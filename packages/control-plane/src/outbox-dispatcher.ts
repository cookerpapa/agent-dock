import type { Database } from "@agent-dock/database";
import {
  isTerminalRunAttemptState,
  transitionCommand,
  transitionRun,
  transitionRunAttempt,
  transitionSession,
  transitionTurn,
  type CommandState,
  type SessionState,
  type TurnState,
} from "@agent-dock/domain";
import {
  TURN_CANCELLATION_OUTBOX_TOPIC,
  TURN_COMMAND_OUTBOX_TOPIC,
  parseEnvironmentRuntimeSnapshot,
  parseTurnCommandOutboxPayload,
} from "@agent-dock/protocol";
import type { CancelTurnCommandMessage, TurnBudgetSnapshot } from "@agent-dock/protocol";
import type { EnvironmentRuntimeSnapshot, TraceContext } from "@agent-dock/protocol";
import { virtualRunTraceCarrier, withSpan } from "@agent-dock/observability";
import type { AgentDockMetrics } from "@agent-dock/observability";
import { sql, type Kysely, type Transaction } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import {
  validateSupervisorDispatchAffinity,
  type SupervisorDispatchAffinity,
} from "./supervisor-dispatch-affinity.ts";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";
import { createCompletedRunReviewBundle } from "./review-bundle.ts";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const CANDIDATE_RACE_CANCELLATION_GRACE_PERIOD_MS = 2_000;

function candidateRaceCancellationFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        kind: "turn.cancel",
        reason: "user_request",
        gracePeriodMs: CANDIDATE_RACE_CANCELLATION_GRACE_PERIOD_MS,
      }),
    )
    .digest("hex");
}

export type TurnExecutionRequest = {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  attemptNumber: number;
  commandId: string;
  idempotencyKey: string;
  nextEventSeq: string;
  input: {
    kind: "prompt";
    prompt: string;
  };
  model: {
    profileId: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    credentialBindingId: string;
    credentialBindingVersion: string;
  };
  environment: EnvironmentRuntimeSnapshot;
  budgets?: TurnBudgetSnapshot;
  traceContext?: TraceContext;
};

export type TurnExecutionAcknowledgement = {
  leaseId: string;
  fencingToken: number;
};

export type TurnExecutionLifecycle = {
  started(acknowledgement?: TurnExecutionAcknowledgement): Promise<void>;
};

export type TurnExecutionResult = {
  stopReason: string;
};

export interface TurnExecutionBackend {
  execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult>;
}

export interface TurnExecutionLeaseManager {
  assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void>;
  assertCurrentOrExpired?(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void>;
  releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void>;
}

export class TurnExecutionBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly quarantineSession: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, quarantineSession = false) {
    super(safeMessage);
    this.name = "TurnExecutionBackendError";
    this.code = code;
    this.retryable = retryable;
    this.quarantineSession = quarantineSession;
  }
}

export class TurnExecutionCancelledError extends TurnExecutionBackendError {
  readonly reason: CancelTurnCommandMessage["payload"]["reason"];
  readonly forced: boolean;

  constructor(reason: CancelTurnCommandMessage["payload"]["reason"], forced: boolean) {
    super("turn_cancelled", "Turn cancellation was confirmed", false);
    this.name = "TurnExecutionCancelledError";
    this.reason = reason;
    this.forced = forced;
  }
}

export class OutboxDispatcherInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxDispatcherInvariantError";
  }
}

export class OutboxDispatcherStaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxDispatcherStaleClaimError";
  }
}

export type DispatchNextResult =
  | { status: "idle" }
  | {
      status: "cancellation_pending" | "cancelled";
      commandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
    }
  | {
      status: "completed";
      commandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
    }
  | {
      status: "retry_scheduled";
      commandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      failureCode: string;
    }
  | {
      status: "failed";
      commandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      phase: "before_start" | "after_start";
      failureCode: string;
    };

export type OutboxDispatcherOptions = {
  database: Kysely<Database>;
  tenantId?: string;
  backend: TurnExecutionBackend;
  clock?: () => Date;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  claimOwnerId?: string;
  idGenerator?: () => string;
  leaseManager?: TurnExecutionLeaseManager;
  supervisorAffinity?: SupervisorDispatchAffinity;
  metrics?: AgentDockMetrics;
};

type ClaimedTurn = {
  outboxId: string;
  attempt: number;
  request: TurnExecutionRequest;
  queuedAt: Date;
};

type LifecycleRows = {
  commandState: CommandState;
  commandFailureCode: string | null;
  turnState: TurnState;
  sessionState: SessionState;
  outboxAttempts: number;
  outboxPublishedAt: Date | string | null;
  runState: import("@agent-dock/domain").RunState;
  runVersion: string;
  currentAttemptId: string | null;
  runAttemptState: import("@agent-dock/domain").RunAttemptState;
};

type ExecutionFailure = {
  code: string;
  safeMessage: string;
  retryable: boolean;
  quarantineSession: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeMailboxPosition(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OutboxDispatcherInvariantError(
      "The v1 turn dispatcher requires a positive mailbox position",
    );
  }
  return parsed;
}

function safeNonNegativeInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OutboxDispatcherInvariantError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("dispatcher clock must return a valid Date");
  }
  return value;
}

function normalizeFailure(error: unknown): ExecutionFailure {
  if (error instanceof TurnExecutionBackendError) {
    return {
      code: error.code,
      safeMessage: error.message,
      retryable: error.retryable,
      quarantineSession: error.quarantineSession,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code,
      safeMessage: error instanceof Error ? error.message : "Execution backend failed",
      retryable: error.retryable,
      quarantineSession:
        "quarantineSession" in error && typeof error.quarantineSession === "boolean"
          ? error.quarantineSession
          : false,
    };
  }
  return {
    code: "execution_backend_error",
    safeMessage: "Execution backend failed",
    retryable: true,
    quarantineSession: false,
  };
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new OutboxDispatcherInvariantError(`${description} changed ${updatedRows} rows`);
  }
}

export class OutboxDispatcher {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string | undefined;
  readonly #backend: TurnExecutionBackend;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;
  readonly #claimOwnerId: string;
  readonly #idGenerator: () => string;
  readonly #leaseManager: TurnExecutionLeaseManager | undefined;
  readonly #supervisorAffinity: SupervisorDispatchAffinity | undefined;
  readonly #metrics: AgentDockMetrics | undefined;

  constructor(options: OutboxDispatcherOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#backend = options.backend;
    this.#clock = options.clock ?? (() => new Date());
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      "claimLeaseMs",
    );
    this.#retryDelayMs = positiveInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.#claimOwnerId = options.claimOwnerId ?? "control-plane";
    if (
      this.#claimOwnerId.length < 1 ||
      this.#claimOwnerId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(this.#claimOwnerId)
    ) {
      throw new TypeError("claimOwnerId is invalid");
    }
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#leaseManager = options.leaseManager;
    this.#supervisorAffinity =
      options.supervisorAffinity === undefined
        ? undefined
        : validateSupervisorDispatchAffinity(options.supervisorAffinity);
    this.#metrics = options.metrics;
  }

  async dispatchNext(): Promise<DispatchNextResult> {
    const claim = await this.#claimNext();
    if (!claim) return { status: "idle" };

    const observedAt = safeDate(this.#clock).valueOf();
    this.#metrics?.queueWait.observe(Math.max(0, observedAt - claim.queuedAt.valueOf()) / 1_000);
    this.#metrics?.activeRuns.inc();
    const executionStartedAt = performance.now();
    try {
      const result = await withSpan<DispatchNextResult>({
        serviceName: "agent-dock-control-plane",
        name: "run.dispatch",
        ...(claim.request.traceContext === undefined ? {} : { parent: claim.request.traceContext }),
        attributes: {
          "agent_dock.run.id": claim.request.runId,
          "agent_dock.attempt.id": claim.request.attemptId,
          "agent_dock.session.id": claim.request.sessionId,
        },
        run: async () => {
          let started = false;
          let acknowledgement: TurnExecutionAcknowledgement | undefined;
          let startedPromise: Promise<void> | undefined;
          let startFailure: unknown;
          const lifecycle: TurnExecutionLifecycle = {
            started: (candidate) => {
              if (this.#leaseManager !== undefined && candidate === undefined) {
                return Promise.reject(
                  new OutboxDispatcherInvariantError(
                    "A fenced execution acknowledgement is required by the configured lease manager",
                  ),
                );
              }
              if (
                startedPromise !== undefined &&
                (candidate?.leaseId !== acknowledgement?.leaseId ||
                  candidate?.fencingToken !== acknowledgement?.fencingToken)
              ) {
                return Promise.reject(
                  new OutboxDispatcherInvariantError(
                    "Execution acknowledgement changed after start",
                  ),
                );
              }
              acknowledgement = candidate;
              startedPromise ??= this.#markStarted(claim, candidate).then(
                () => {
                  started = true;
                },
                (error: unknown) => {
                  startFailure = error;
                  throw error;
                },
              );
              return startedPromise;
            },
          };

          let executionResult: TurnExecutionResult;
          try {
            executionResult = await this.#backend.execute(claim.request, lifecycle);
            if (startedPromise) await startedPromise;
            if (!started) {
              throw new TurnExecutionBackendError(
                "backend_protocol_violation",
                "Execution backend returned before acknowledging the command",
                false,
              );
            }
            if (
              typeof executionResult.stopReason !== "string" ||
              executionResult.stopReason.trim().length === 0 ||
              executionResult.stopReason.length > 256
            ) {
              throw new TurnExecutionBackendError(
                "backend_protocol_violation",
                "Execution backend returned an invalid stop reason",
                false,
              );
            }
          } catch (error) {
            if (startedPromise && !started && startFailure === undefined) {
              try {
                await startedPromise;
              } catch {
                // The persistence error is rethrown below instead of being recorded as an agent failure.
              }
            }
            if (startFailure !== undefined) throw startFailure;
            if (started) {
              const externallySettled = await this.#observeCancellation(claim);
              if (externallySettled !== undefined) return externallySettled;
              if (error instanceof TurnExecutionCancelledError) {
                throw new OutboxDispatcherInvariantError(
                  "Cancellation confirmation arrived before its durable lifecycle",
                );
              }
            }
            return this.#recordFailure(claim, started, normalizeFailure(error), acknowledgement);
          }

          await this.#complete(claim, executionResult.stopReason, acknowledgement);
          return {
            status: "completed",
            commandId: claim.request.commandId,
            sessionId: claim.request.sessionId,
            turnId: claim.request.turnId,
            attempt: claim.attempt,
          };
        },
      });
      this.#metrics?.runs.inc({ outcome: result.status });
      this.#metrics?.runDuration.observe(
        { outcome: result.status },
        (performance.now() - executionStartedAt) / 1_000,
      );
      return result;
    } catch (error: unknown) {
      this.#metrics?.runs.inc({ outcome: "dispatcher_error" });
      this.#metrics?.runDuration.observe(
        { outcome: "dispatcher_error" },
        (performance.now() - executionStartedAt) / 1_000,
      );
      throw error;
    } finally {
      this.#metrics?.activeRuns.dec();
    }
  }

  async #observeCancellation(claim: ClaimedTurn): Promise<DispatchNextResult | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.commandState === "acknowledged" &&
        rows.turnState === "cancelling" &&
        rows.sessionState === "cancelling" &&
        rows.outboxPublishedAt !== null
      ) {
        return {
          status: "cancellation_pending",
          commandId: claim.request.commandId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
        };
      }
      if (
        rows.commandState === "completed" &&
        rows.turnState === "cancelled" &&
        rows.sessionState === "idle" &&
        rows.outboxPublishedAt !== null
      ) {
        return {
          status: "cancelled",
          commandId: claim.request.commandId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
        };
      }
      if (
        rows.commandState === "failed" &&
        rows.turnState === "failed" &&
        rows.sessionState === "failed" &&
        rows.outboxPublishedAt !== null
      ) {
        return {
          status: "failed",
          commandId: claim.request.commandId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
          phase: "after_start",
          failureCode: rows.commandFailureCode ?? "cancellation_failed",
        };
      }
      return undefined;
    });
  }

  async #claimNext(): Promise<ClaimedTurn | undefined> {
    const now = safeDate(this.#clock);
    const leaseUntil = new Date(now.valueOf() + this.#claimLeaseMs);

    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("outbox")
        .innerJoin("commands as command", (join) =>
          join
            .onRef("command.tenant_id", "=", "outbox.tenant_id")
            .on(
              sql<boolean>`${sql.ref("command.id")}::text = ${sql.ref("outbox.payload")} ->> 'commandId'`,
            ),
        )
        .innerJoin("turns as turn", (join) =>
          join
            .onRef("turn.tenant_id", "=", "command.tenant_id")
            .onRef("turn.session_id", "=", "command.session_id")
            .onRef("turn.id", "=", "command.turn_id"),
        )
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "command.tenant_id")
            .onRef("session_row.id", "=", "command.session_id"),
        )
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "command.tenant_id")
            .onRef("run.session_id", "=", "command.session_id")
            .onRef("run.turn_id", "=", "turn.id")
            .onRef("run.command_id", "=", "command.id"),
        )
        .innerJoin("environment_versions as environment", (join) =>
          join
            .onRef("environment.tenant_id", "=", "run.tenant_id")
            .onRef("environment.project_id", "=", "run.project_id")
            .onRef("environment.id", "=", "run.environment_version_id"),
        )
        .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "command.tenant_id")
        .select([
          "outbox.id as outboxId",
          "outbox.payload as outboxPayload",
          "outbox.attempts as attempts",
          "command.tenant_id as tenantId",
          "command.id as commandId",
          "command.idempotency_key as idempotencyKey",
          "command.mailbox_position as mailboxPosition",
          "command.state as commandState",
          "turn.id as turnId",
          "turn.state as turnState",
          "turn.input_kind as inputKind",
          "turn.input_text as inputText",
          "turn.model_profile_id as modelProfileId",
          "turn.provider as provider",
          "turn.model_id as modelId",
          "turn.thinking_level as thinkingLevel",
          "turn.credential_binding_id as credentialBindingId",
          "turn.credential_binding_version as credentialBindingVersion",
          "session_row.id as sessionId",
          "session_row.state as sessionState",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.next_event_seq as nextEventSeq",
          "run.id as runId",
          "run.trace_id as traceId",
          "run.queued_at as runQueuedAt",
          "run.state as runState",
          "run.current_attempt_id as currentAttemptId",
          "run.attempt_count as runAttemptCount",
          "run.row_version as runVersion",
          "environment.id as environmentVersionId",
          "environment.version_number as environmentVersionNumber",
          "environment.profile_key as environmentProfileKey",
          "environment.profile_version as environmentProfileVersion",
          "environment.image_revision as environmentImageRevision",
          "environment.spec_sha256 as environmentSpecSha256",
          "environment.recipe as environmentRecipe",
          "environment.recipe_sha256 as environmentRecipeSha256",
          "policy.maximum_model_requests_per_run as maximumModelRequests",
          "policy.maximum_cost_microusd_per_run as maximumCostMicrousd",
          "policy.daily_token_budget as dailyTokenBudget",
          "policy.monthly_cost_microusd_budget as monthlyCostMicrousdBudget",
          "policy.maximum_tool_calls_per_run as maximumToolCalls",
          "policy.maximum_tool_output_bytes as maximumToolOutputBytes",
          "policy.maximum_run_duration_ms as maximumRunDurationMs",
          "policy.compaction_reserve_tokens as compactionReserveTokens",
          "policy.compaction_keep_recent_tokens as compactionKeepRecentTokens",
        ])
        .where(
          this.#tenantId === undefined
            ? sql<boolean>`true`
            : sql<boolean>`${sql.ref("outbox.tenant_id")} = ${this.#tenantId}`,
        )
        .where("policy.enabled", "=", true)
        .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
        .where("outbox.published_at", "is", null)
        .where("outbox.available_at", "<=", now)
        .where("command.kind", "=", "turn.execute")
        .where(
          this.#supervisorAffinity === undefined
            ? sql<boolean>`true`
            : sql<boolean>`exists (
                select 1
                from sandboxes as affinity_sandbox
                inner join supervisor_connections as affinity_connection
                  on affinity_connection.sandbox_id = affinity_sandbox.id
                  and affinity_connection.supervisor_id = affinity_sandbox.supervisor_id
                  and affinity_connection.boot_id = affinity_sandbox.boot_id
                where affinity_sandbox.id = ${this.#supervisorAffinity.sandboxId}
                  and affinity_sandbox.state in ('ready', 'leased')
                  and affinity_sandbox.active_sessions < affinity_sandbox.max_concurrent_sessions
                  and affinity_connection.control_plane_instance_id = ${this.#supervisorAffinity.controlPlaneInstanceId}
                  and affinity_connection.state = 'active'
                  and affinity_connection.accepting_assignments = true
                  and affinity_connection.expires_at > ${now}
              )`,
        )
        .where(
          sql<boolean>`(
            (
              ${sql.ref("command.state")} = 'pending'
              and ${sql.ref("turn.state")} = 'queued'
              and not exists (
                select 1
                from turns as active_turn
                where active_turn.tenant_id = ${sql.ref("command.tenant_id")}
                  and active_turn.session_id = ${sql.ref("command.session_id")}
                  and active_turn.state in ('dispatching', 'running', 'waiting_approval', 'cancelling')
              )
            )
            or (
              ${sql.ref("command.state")} = 'dispatched'
              and ${sql.ref("turn.state")} = 'dispatching'
            )
          )`,
        )
        .where(
          sql<boolean>`not exists (
            select 1
            from commands as earlier_command
            where earlier_command.tenant_id = ${sql.ref("command.tenant_id")}
              and earlier_command.session_id = ${sql.ref("command.session_id")}
              and earlier_command.kind = 'turn.execute'
              and earlier_command.state in ('pending', 'dispatched', 'acknowledged')
              and earlier_command.mailbox_position < ${sql.ref("command.mailbox_position")}
          )`,
        )
        .where("session_row.state", "in", ["cold", "idle"])
        .where(
          sql<boolean>`(
            select count(*)
            from turns as tenant_active_turn
            where tenant_active_turn.tenant_id = ${sql.ref("command.tenant_id")}
              and tenant_active_turn.id <> ${sql.ref("command.turn_id")}
              and tenant_active_turn.state in ('dispatching', 'running', 'waiting_approval', 'cancelling')
          ) < ${sql.ref("policy.maximum_concurrent_turns")}`,
        )
        .where(
          sql<boolean>`not exists (
            select 1
            from orchestration_candidates as candidate_admission
            inner join orchestration_runs as orchestration_admission
              on orchestration_admission.tenant_id = candidate_admission.tenant_id
              and orchestration_admission.id = candidate_admission.orchestration_id
            where candidate_admission.tenant_id = ${sql.ref("command.tenant_id")}
              and candidate_admission.run_id = ${sql.ref("run.id")}
              and (
                orchestration_admission.state <> 'running'
                or (
                  select count(*)
                  from orchestration_candidates as sibling_candidate
                  inner join runs as sibling_run
                    on sibling_run.tenant_id = sibling_candidate.tenant_id
                    and sibling_run.id = sibling_candidate.run_id
                  where sibling_candidate.tenant_id = candidate_admission.tenant_id
                    and sibling_candidate.orchestration_id = candidate_admission.orchestration_id
                    and sibling_candidate.run_id <> candidate_admission.run_id
                    and sibling_run.state in (
                      'claimed',
                      'provisioning',
                      'restoring',
                      'running',
                      'checkpointing',
                      'cancel_requested'
                    )
                ) >= orchestration_admission.maximum_concurrent_candidates
              )
          )`,
        )
        .orderBy("policy.last_scheduled_at", "asc")
        .orderBy("command.tenant_id", "asc")
        .orderBy("outbox.available_at", "asc")
        .orderBy("outbox.created_at", "asc")
        .orderBy("outbox.id", "asc")
        .limit(1)
        .forUpdate(["outbox", "session_row", "policy", "run"])
        .skipLocked()
        .executeTakeFirst();

      if (!row) return undefined;

      const payload = parseTurnCommandOutboxPayload(row.outboxPayload);
      if (
        payload.commandId !== row.commandId ||
        payload.sessionId !== row.sessionId ||
        payload.turnId !== row.turnId
      ) {
        throw new OutboxDispatcherInvariantError(
          "Turn-command outbox identity does not match its durable command",
        );
      }
      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new OutboxDispatcherInvariantError(
          "The v1 turn dispatcher only accepts durable prompt turns",
        );
      }
      if (row.mailboxPosition === null) {
        throw new OutboxDispatcherInvariantError(
          "The v1 turn dispatcher requires a positive mailbox position",
        );
      }
      safeMailboxPosition(row.mailboxPosition);

      const usedToolCalls = await transaction
        .selectFrom("session_events")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("tenant_id", "=", row.tenantId)
        .where("session_id", "=", row.sessionId)
        .where("turn_id", "=", row.turnId)
        .where("type", "=", "tool.started")
        .executeTakeFirstOrThrow();
      const maximumToolCalls = safeNonNegativeInteger(row.maximumToolCalls, "tool-call budget");
      const remainingToolCalls = Math.max(
        0,
        maximumToolCalls - safeNonNegativeInteger(usedToolCalls.count, "used tool-call count"),
      );

      const attemptNumber = row.attempts + 1;
      if (row.runAttemptCount !== row.attempts) {
        throw new OutboxDispatcherInvariantError(
          "Run attempt count does not match its durable outbox",
        );
      }
      if (row.currentAttemptId !== null) {
        const previous = await transaction
          .selectFrom("run_attempts")
          .select(["state"])
          .where("tenant_id", "=", row.tenantId)
          .where("run_id", "=", row.runId)
          .where("id", "=", row.currentAttemptId)
          .forUpdate()
          .executeTakeFirst();
        if (previous === undefined) {
          throw new OutboxDispatcherInvariantError("Current run attempt is missing");
        }
        if (!isTerminalRunAttemptState(previous.state)) {
          const superseded = await transaction
            .updateTable("run_attempts")
            .set({ state: "superseded", settled_at: now, updated_at: now })
            .where("tenant_id", "=", row.tenantId)
            .where("run_id", "=", row.runId)
            .where("id", "=", row.currentAttemptId)
            .where("state", "=", previous.state)
            .executeTakeFirst();
          expectOne(superseded.numUpdatedRows, "superseding a stale run attempt");
          await transaction
            .insertInto("run_attempt_transitions")
            .values({
              id: this.#idGenerator(),
              tenant_id: row.tenantId,
              run_id: row.runId,
              attempt_id: row.currentAttemptId,
              from_state: previous.state,
              to_state: "superseded",
              reason: "outbox_claim_expired",
              occurred_at: now,
            })
            .executeTakeFirstOrThrow();
        }
      }
      const attemptId = this.#idGenerator();
      await transaction
        .insertInto("run_attempts")
        .values({
          id: attemptId,
          tenant_id: row.tenantId,
          run_id: row.runId,
          attempt_number: attemptNumber,
          state: "claimed",
          claim_owner_id: this.#claimOwnerId,
          claim_expires_at: leaseUntil,
          sandbox_id: null,
          lease_id: null,
          fencing_token: null,
          checkpoint_revision: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          provisioning_at: null,
          restoring_at: null,
          running_at: null,
          checkpointing_at: null,
          last_heartbeat_at: null,
          settled_at: null,
          claimed_at: now,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("run_attempt_transitions")
        .values({
          id: this.#idGenerator(),
          tenant_id: row.tenantId,
          run_id: row.runId,
          attempt_id: attemptId,
          from_state: null,
          to_state: "claimed",
          reason: "outbox_claimed",
          occurred_at: now,
        })
        .executeTakeFirstOrThrow();
      const runUpdate = await transaction
        .updateTable("runs")
        .set({
          state: "claimed",
          current_attempt_id: attemptId,
          attempt_count: attemptNumber,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          settled_at: null,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("tenant_id", "=", row.tenantId)
        .where("id", "=", row.runId)
        .where("row_version", "=", row.runVersion)
        .where("attempt_count", "=", row.runAttemptCount)
        .executeTakeFirst();
      expectOne(runUpdate.numUpdatedRows, "claiming a run");

      const policyUpdate = await transaction
        .updateTable("tenant_runtime_policies")
        .set({
          last_scheduled_at: sql<Date>`greatest(
            ${sql.ref("last_scheduled_at")} + interval '1 microsecond',
            ${now}
          )`,
          updated_at: now,
        })
        .where("tenant_id", "=", row.tenantId)
        .where("enabled", "=", true)
        .executeTakeFirst();
      expectOne(policyUpdate.numUpdatedRows, "advancing tenant scheduling fairness");

      if (row.commandState === "pending" && row.turnState === "queued") {
        const commandUpdate = await transaction
          .updateTable("commands")
          .set({
            state: transitionCommand(row.commandState, "dispatched"),
            dispatched_at: now,
            failure_code: null,
          })
          .where("tenant_id", "=", row.tenantId)
          .where("id", "=", row.commandId)
          .where("state", "=", row.commandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "claiming a command");

        const turnUpdate = await transaction
          .updateTable("turns")
          .set({ state: transitionTurn(row.turnState, "dispatching") })
          .where("tenant_id", "=", row.tenantId)
          .where("id", "=", row.turnId)
          .where("state", "=", row.turnState)
          .executeTakeFirst();
        expectOne(turnUpdate.numUpdatedRows, "claiming a turn");
      } else if (row.commandState !== "dispatched" || row.turnState !== "dispatching") {
        throw new OutboxDispatcherInvariantError("Claimed command and turn states do not match");
      }

      const outboxUpdate = await transaction
        .updateTable("outbox")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          available_at: leaseUntil,
          last_error: null,
        })
        .where("tenant_id", "=", row.tenantId)
        .where("id", "=", row.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "leasing an outbox record");

      return {
        outboxId: row.outboxId,
        attempt: attemptNumber,
        queuedAt: new Date(row.runQueuedAt),
        request: {
          tenantId: row.tenantId,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          runId: row.runId,
          turnId: row.turnId,
          attemptId,
          attemptNumber,
          commandId: row.commandId,
          idempotencyKey: row.idempotencyKey,
          nextEventSeq: row.nextEventSeq,
          input: { kind: "prompt", prompt: row.inputText },
          model: {
            profileId: row.modelProfileId,
            provider: row.provider,
            modelId: row.modelId,
            thinkingLevel: row.thinkingLevel,
            credentialBindingId: row.credentialBindingId,
            credentialBindingVersion: row.credentialBindingVersion,
          },
          environment: parseEnvironmentRuntimeSnapshot({
            environmentVersionId: row.environmentVersionId,
            versionNumber: row.environmentVersionNumber,
            profileKey: row.environmentProfileKey,
            profileVersion: row.environmentProfileVersion,
            imageRevision: row.environmentImageRevision,
            specSha256: row.environmentSpecSha256,
            recipe: row.environmentRecipe,
            recipeSha256: row.environmentRecipeSha256,
          }),
          budgets: {
            maximumModelRequests: safeNonNegativeInteger(
              row.maximumModelRequests,
              "model-request budget",
            ),
            maximumCostMicrousd: safeNonNegativeInteger(row.maximumCostMicrousd, "run cost budget"),
            dailyTokenBudget: safeNonNegativeInteger(row.dailyTokenBudget, "daily token budget"),
            monthlyCostMicrousdBudget: safeNonNegativeInteger(
              row.monthlyCostMicrousdBudget,
              "monthly cost budget",
            ),
            maximumToolCalls,
            remainingToolCalls,
            maximumToolOutputBytes: safeNonNegativeInteger(
              row.maximumToolOutputBytes,
              "tool output budget",
            ),
            maximumRunDurationMs: safeNonNegativeInteger(
              row.maximumRunDurationMs,
              "Run duration budget",
            ),
            compactionReserveTokens: safeNonNegativeInteger(
              row.compactionReserveTokens,
              "compaction reserve",
            ),
            compactionKeepRecentTokens: safeNonNegativeInteger(
              row.compactionKeepRecentTokens,
              "compaction recent context",
            ),
          },
          traceContext: virtualRunTraceCarrier(
            row.traceId,
            attemptId.replaceAll("-", "").slice(0, 16),
          ),
        },
      };
    });
  }

  async #markStarted(
    claim: ClaimedTurn,
    acknowledgement: TurnExecutionAcknowledgement | undefined,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (rows.commandState !== "dispatched" || rows.turnState !== "dispatching") {
        throw new OutboxDispatcherInvariantError(
          "Only a dispatched command and turn can be acknowledged",
        );
      }
      if (rows.outboxPublishedAt !== null) {
        throw new OutboxDispatcherInvariantError(
          "An unpublished outbox record is required before command acknowledgement",
        );
      }
      if (this.#leaseManager !== undefined && acknowledgement !== undefined) {
        await this.#leaseManager.assertCurrent(transaction, claim.request, acknowledgement, now);
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: "provisioning",
          attemptState: "provisioning",
          reason: "command_acknowledged",
          now,
          heartbeat: true,
          transitionId: this.#idGenerator(),
        },
      );

      let nextSessionState: SessionState;
      if (rows.sessionState === "cold") {
        const starting = transitionSession(rows.sessionState, "starting");
        const idle = transitionSession(starting, "idle");
        nextSessionState = transitionSession(idle, "running");
      } else if (rows.sessionState === "idle") {
        nextSessionState = transitionSession(rows.sessionState, "running");
      } else {
        throw new OutboxDispatcherInvariantError(
          `Session cannot start a turn from ${rows.sessionState}`,
        );
      }

      const commandUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.commandState, "acknowledged"),
          acknowledged_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.commandState)
        .executeTakeFirst();
      expectOne(commandUpdate.numUpdatedRows, "acknowledging a command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "running"),
          started_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "starting a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: nextSessionState,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "starting a session");

      const outboxUpdate = await transaction
        .updateTable("outbox")
        .set({ published_at: now, last_error: null })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "publishing an acknowledged outbox record");

      // A race can be cancelled after this command was claimed but before the
      // remote backend acknowledges it. Queued withdrawal can no longer own
      // that lifecycle pair, so atomically create the ordinary durable
      // cancellation at the acknowledgement boundary. This closes the gap
      // without inventing a second cancellation protocol.
      const cancelledCandidate = await transaction
        .selectFrom("orchestration_candidates as candidate")
        .innerJoin("orchestration_runs as orchestration", (join) =>
          join
            .onRef("orchestration.tenant_id", "=", "candidate.tenant_id")
            .onRef("orchestration.id", "=", "candidate.orchestration_id"),
        )
        .select(["candidate.id as candidateId", "orchestration.id as orchestrationId"])
        .where("candidate.tenant_id", "=", claim.request.tenantId)
        .where("candidate.run_id", "=", claim.request.runId)
        .where("orchestration.state", "=", "cancel_requested")
        .executeTakeFirst();
      if (cancelledCandidate !== undefined) {
        const cancellationCommandId = this.#idGenerator();
        const cancellationOutboxId = this.#idGenerator();
        const idempotencyKey = `race-cancel:${cancelledCandidate.orchestrationId}:${cancelledCandidate.candidateId}`;
        const cancellation = await transaction
          .insertInto("commands")
          .values({
            id: cancellationCommandId,
            tenant_id: claim.request.tenantId,
            session_id: claim.request.sessionId,
            turn_id: claim.request.turnId,
            idempotency_key: idempotencyKey,
            kind: "turn.cancel",
            state: "pending",
            payload: {
              schemaVersion: 1,
              requestHash: candidateRaceCancellationFingerprint(),
              targetCommandId: claim.request.commandId,
              reason: "user_request",
              gracePeriodMs: CANDIDATE_RACE_CANCELLATION_GRACE_PERIOD_MS,
            },
            dispatched_at: null,
            acknowledged_at: null,
            completed_at: null,
            failure_code: null,
          })
          .onConflict((conflict) => conflict.columns(["session_id", "idempotency_key"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (cancellation !== undefined) {
          await transaction
            .insertInto("outbox")
            .values({
              id: cancellationOutboxId,
              tenant_id: claim.request.tenantId,
              aggregate_type: "session",
              aggregate_id: claim.request.sessionId,
              topic: TURN_CANCELLATION_OUTBOX_TOPIC,
              payload: {
                schemaVersion: 1,
                commandId: cancellation.id,
                targetCommandId: claim.request.commandId,
                sessionId: claim.request.sessionId,
                turnId: claim.request.turnId,
                kind: "turn.cancel",
              },
              published_at: null,
              last_error: null,
            })
            .executeTakeFirstOrThrow();
        }
      }
    });
  }

  async #complete(
    claim: ClaimedTurn,
    stopReason: string,
    acknowledgement: TurnExecutionAcknowledgement | undefined,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.commandState !== "acknowledged" ||
        rows.turnState !== "running" ||
        rows.sessionState !== "running" ||
        rows.outboxPublishedAt === null
      ) {
        throw new OutboxDispatcherInvariantError(
          "Only an acknowledged running command can complete",
        );
      }

      if (this.#leaseManager !== undefined && acknowledgement !== undefined) {
        await this.#leaseManager.assertCurrent(transaction, claim.request, acknowledgement, now);
      }
      if (rows.runAttemptState === "provisioning" || rows.runAttemptState === "restoring") {
        await transitionCurrentRunAttempt(
          transaction,
          {
            tenantId: claim.request.tenantId,
            runId: claim.request.runId,
            attemptId: claim.request.attemptId,
          },
          {
            runState: "running",
            attemptState: "running",
            reason: "backend_settled_without_phase_signal",
            now,
            transitionId: this.#idGenerator(),
          },
        );
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: "completed",
          attemptState: "completed",
          reason: "execution_completed",
          now,
          stopReason,
          transitionId: this.#idGenerator(),
        },
      );

      const commandUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.commandState, "completed"),
          completed_at: now,
          failure_code: null,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.commandState)
        .executeTakeFirst();
      expectOne(commandUpdate.numUpdatedRows, "completing a command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "completed"),
          stop_reason: stopReason,
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "completing a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "idle"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "settling a session");
      await createCompletedRunReviewBundle(
        transaction,
        {
          tenantId: claim.request.tenantId,
          projectId: claim.request.projectId,
          workspaceId: claim.request.workspaceId,
          sessionId: claim.request.sessionId,
          runId: claim.request.runId,
          turnId: claim.request.turnId,
          attemptId: claim.request.attemptId,
          environment: claim.request.environment,
        },
        stopReason,
        now,
      );
      if (this.#leaseManager !== undefined && acknowledgement !== undefined) {
        await this.#leaseManager.releaseCurrent(transaction, claim.request, acknowledgement, now);
      }
    });
  }

  async #recordFailure(
    claim: ClaimedTurn,
    started: boolean,
    failure: ExecutionFailure,
    acknowledgement: TurnExecutionAcknowledgement | undefined,
  ): Promise<DispatchNextResult> {
    const now = safeDate(this.#clock);
    const shouldRetry = !started && failure.retryable && claim.attempt < this.#maxAttempts;

    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);

      if (shouldRetry) {
        if (
          rows.commandState !== "dispatched" ||
          rows.turnState !== "dispatching" ||
          rows.outboxPublishedAt !== null
        ) {
          throw new OutboxDispatcherInvariantError(
            "Only an unacknowledged command can return to the mailbox",
          );
        }
        const attemptState = transitionRunAttempt(rows.runAttemptState, "failed");
        const attemptUpdate = await transaction
          .updateTable("run_attempts")
          .set({
            state: attemptState,
            failure_code: failure.code,
            failure_message: failure.safeMessage,
            failure_retryable: failure.retryable,
            settled_at: now,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("run_id", "=", claim.request.runId)
          .where("id", "=", claim.request.attemptId)
          .where("state", "=", rows.runAttemptState)
          .executeTakeFirst();
        expectOne(attemptUpdate.numUpdatedRows, "failing a retryable run attempt");
        await transaction
          .insertInto("run_attempt_transitions")
          .values({
            id: this.#idGenerator(),
            tenant_id: claim.request.tenantId,
            run_id: claim.request.runId,
            attempt_id: claim.request.attemptId,
            from_state: rows.runAttemptState,
            to_state: attemptState,
            reason: "execution_retry_scheduled",
            occurred_at: now,
          })
          .executeTakeFirstOrThrow();
        const runUpdate = await transaction
          .updateTable("runs")
          .set({
            state: transitionRun(rows.runState, "queued"),
            stop_reason: null,
            failure_code: null,
            failure_message: null,
            failure_retryable: null,
            settled_at: null,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.runId)
          .where("current_attempt_id", "=", claim.request.attemptId)
          .where("state", "=", rows.runState)
          .where("row_version", "=", rows.runVersion)
          .executeTakeFirst();
        expectOne(runUpdate.numUpdatedRows, "requeueing a run");

        const commandUpdate = await transaction
          .updateTable("commands")
          .set({ state: transitionCommand(rows.commandState, "pending") })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.commandId)
          .where("state", "=", rows.commandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "requeueing a command");

        const turnUpdate = await transaction
          .updateTable("turns")
          .set({ state: transitionTurn(rows.turnState, "queued") })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.turnId)
          .where("state", "=", rows.turnState)
          .executeTakeFirst();
        expectOne(turnUpdate.numUpdatedRows, "requeueing a turn");

        const outboxUpdate = await transaction
          .updateTable("outbox")
          .set({
            available_at: new Date(now.valueOf() + this.#retryDelayMs),
            last_error: failure.code,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.outboxId)
          .where("published_at", "is", null)
          .executeTakeFirst();
        expectOne(outboxUpdate.numUpdatedRows, "scheduling an outbox retry");
        return;
      }

      const expectedCommandState = started ? "acknowledged" : "dispatched";
      const expectedTurnState = started ? "running" : "dispatching";
      if (rows.commandState !== expectedCommandState || rows.turnState !== expectedTurnState) {
        throw new OutboxDispatcherInvariantError(
          "Command lifecycle does not match the reported execution phase",
        );
      }
      if (started !== (rows.outboxPublishedAt !== null)) {
        throw new OutboxDispatcherInvariantError(
          "Outbox publication does not match the reported execution phase",
        );
      }

      if (started && this.#leaseManager !== undefined && acknowledgement !== undefined) {
        if (this.#leaseManager.assertCurrentOrExpired !== undefined) {
          await this.#leaseManager.assertCurrentOrExpired(
            transaction,
            claim.request,
            acknowledgement,
            now,
          );
        } else {
          await this.#leaseManager.assertCurrent(transaction, claim.request, acknowledgement, now);
        }
      }
      const timedOut = /(?:^|_)timeout$/.test(failure.code) || failure.code === "pi_timeout";
      if (failure.code.startsWith("environment_")) {
        await transaction
          .insertInto("environment_validations")
          .values({
            id: this.#idGenerator(),
            tenant_id: claim.request.tenantId,
            project_id: claim.request.projectId,
            environment_version_id: claim.request.environment.environmentVersionId,
            run_id: claim.request.runId,
            attempt_id: claim.request.attemptId,
            status: "failed",
            report: null,
            failure_code: failure.code,
            validated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["environment_version_id", "run_id", "attempt_id"]).doNothing(),
          )
          .executeTakeFirst();
        await transaction
          .updateTable("environment_versions")
          .set({
            state: "failed",
            failure_code: failure.code,
            validated_at: null,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("project_id", "=", claim.request.projectId)
          .where("id", "=", claim.request.environment.environmentVersionId)
          .where("recipe_sha256", "=", claim.request.environment.recipeSha256)
          .executeTakeFirstOrThrow();
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: timedOut ? "timed_out" : "failed",
          attemptState: timedOut ? "timed_out" : "failed",
          reason: timedOut ? "execution_timed_out" : "execution_failed",
          now,
          failure: {
            code: failure.code,
            message: failure.safeMessage,
            retryable: failure.retryable,
          },
          transitionId: this.#idGenerator(),
        },
      );

      const commandUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.commandState, "failed"),
          completed_at: now,
          failure_code: failure.code,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.commandState)
        .executeTakeFirst();
      expectOne(commandUpdate.numUpdatedRows, "failing a command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "failed"),
          failure_code: failure.code,
          failure_message: failure.safeMessage,
          failure_retryable: failure.retryable,
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "failing a turn");

      if (started) {
        if (rows.sessionState !== "running") {
          throw new OutboxDispatcherInvariantError(
            "A started execution must own a running session",
          );
        }
        const nextSessionState = failure.quarantineSession
          ? transitionSession(rows.sessionState, "failed")
          : transitionSession(rows.sessionState, "idle");
        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: nextSessionState,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.sessionId)
          .where("state", "=", rows.sessionState)
          .executeTakeFirst();
        expectOne(sessionUpdate.numUpdatedRows, "settling a failed session");
        if (this.#leaseManager !== undefined && acknowledgement !== undefined) {
          await this.#leaseManager.releaseCurrent(transaction, claim.request, acknowledgement, now);
        }
      }

      if (!started) {
        const outboxUpdate = await transaction
          .updateTable("outbox")
          .set({ published_at: now, last_error: failure.code })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.outboxId)
          .where("published_at", "is", null)
          .executeTakeFirst();
        expectOne(outboxUpdate.numUpdatedRows, "publishing a rejected outbox record");
      }
    });

    if (shouldRetry) {
      return {
        status: "retry_scheduled",
        commandId: claim.request.commandId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        attempt: claim.attempt,
        failureCode: failure.code,
      };
    }
    return {
      status: "failed",
      commandId: claim.request.commandId,
      sessionId: claim.request.sessionId,
      turnId: claim.request.turnId,
      attempt: claim.attempt,
      phase: started ? "after_start" : "before_start",
      failureCode: failure.code,
    };
  }

  async #lockLifecycleRows(
    transaction: Transaction<Database>,
    claim: ClaimedTurn,
  ): Promise<LifecycleRows> {
    const row = await transaction
      .selectFrom("commands as command")
      .innerJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "command.tenant_id")
          .onRef("turn.session_id", "=", "command.session_id")
          .onRef("turn.id", "=", "command.turn_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "command.tenant_id")
          .onRef("session_row.id", "=", "command.session_id"),
      )
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "command.tenant_id")
          .on("outbox.id", "=", claim.outboxId),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "command.tenant_id")
          .onRef("run.turn_id", "=", "turn.id")
          .onRef("run.command_id", "=", "command.id"),
      )
      .innerJoin("run_attempts as run_attempt", (join) =>
        join
          .onRef("run_attempt.run_id", "=", "run.id")
          .onRef("run_attempt.id", "=", "run.current_attempt_id"),
      )
      .select([
        "command.state as commandState",
        "command.failure_code as commandFailureCode",
        "turn.state as turnState",
        "session_row.state as sessionState",
        "outbox.attempts as outboxAttempts",
        "outbox.published_at as outboxPublishedAt",
        "run.state as runState",
        "run.row_version as runVersion",
        "run.current_attempt_id as currentAttemptId",
        "run_attempt.state as runAttemptState",
      ])
      .where("command.tenant_id", "=", claim.request.tenantId)
      .where("command.id", "=", claim.request.commandId)
      .where("turn.id", "=", claim.request.turnId)
      .where("session_row.id", "=", claim.request.sessionId)
      .where("run.id", "=", claim.request.runId)
      .where("run_attempt.id", "=", claim.request.attemptId)
      .forUpdate(["command", "turn", "session_row", "outbox", "run", "run_attempt"])
      .executeTakeFirst();

    if (!row) {
      const authority = await transaction
        .selectFrom("outbox")
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "outbox.tenant_id")
            .on("run.id", "=", claim.request.runId),
        )
        .select(["outbox.attempts as outboxAttempts", "run.current_attempt_id as attemptId"])
        .where("outbox.id", "=", claim.outboxId)
        .where("outbox.tenant_id", "=", claim.request.tenantId)
        .forUpdate(["outbox", "run"])
        .executeTakeFirst();
      if (
        authority !== undefined &&
        (authority.outboxAttempts !== claim.attempt ||
          authority.attemptId !== claim.request.attemptId)
      ) {
        throw new OutboxDispatcherStaleClaimError("Run attempt was superseded");
      }
      throw new OutboxDispatcherInvariantError("Claimed command lifecycle rows are missing");
    }
    if (row.outboxAttempts !== claim.attempt) {
      throw new OutboxDispatcherStaleClaimError(
        `Outbox claim attempt ${claim.attempt} was superseded by attempt ${row.outboxAttempts}`,
      );
    }
    if (row.currentAttemptId !== claim.request.attemptId) {
      throw new OutboxDispatcherStaleClaimError("Run attempt was superseded");
    }
    return row;
  }
}
