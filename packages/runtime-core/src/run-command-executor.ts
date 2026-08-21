import type { Database } from "@pi-cloud/database";
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
} from "@pi-cloud/domain";
import {
  TURN_COMMAND_OUTBOX_TOPIC,
  parseCloudToolCapabilitySnapshot,
  parseEnvironmentRuntimeSnapshot,
  parseTurnCommandOutboxPayload,
} from "@pi-cloud/protocol";
import type {
  CancelTurnCommandMessage,
  CloudToolCapabilitySnapshot,
  TurnBudgetSnapshot,
  WorkspacePatch,
} from "@pi-cloud/protocol";
import type { EnvironmentRuntimeSnapshot, TraceContext } from "@pi-cloud/protocol";
import { virtualRunTraceCarrier, withSpan } from "@pi-cloud/observability";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";
import { commitTerminalTurnEvent } from "./terminal-turn-event.ts";
import type {
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
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
  sandboxRetention: import("@pi-cloud/protocol").SandboxRetentionPolicy;
  toolCapabilities: CloudToolCapabilitySnapshot;
  agentSystemPrompt?: string;
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
  workspacePatch?: WorkspacePatch;
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
    const code =
      reason === "timeout"
        ? "pi_timeout"
        : reason === "shutdown"
          ? "worker_shutdown"
          : "turn_cancelled";
    const message =
      reason === "timeout"
        ? "Pi turn exceeded its execution deadline"
        : reason === "shutdown"
          ? "Pi Worker shut down before the turn settled"
          : "Turn cancellation was confirmed";
    super(code, message, false);
    this.name = "TurnExecutionCancelledError";
    this.reason = reason;
    this.forced = forced;
  }
}

export class RunCommandExecutorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCommandExecutorInvariantError";
  }
}

export class RunCommandExecutorStaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCommandExecutorStaleClaimError";
  }
}

export type RunCommandExecutionResult =
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

export type RunCommandExecutorOptions = {
  database: Kysely<Database>;
  backend: TurnExecutionBackend;
  clock?: () => Date;
  claimLeaseMs?: number;
  maxAttempts?: number;
  claimOwnerId?: string;
  idGenerator?: () => string;
  leaseManager?: TurnExecutionLeaseManager;
  metrics?: PiCloudMetrics;
  eventNotificationPublisher?: SessionEventNotificationPublisher;
  terminalTurnProjectionSource?: TerminalTurnProjectionSource;
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
  runState: import("@pi-cloud/domain").RunState;
  runVersion: string;
  currentAttemptId: string | null;
  runAttemptState: import("@pi-cloud/domain").RunAttemptState;
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
    throw new RunCommandExecutorInvariantError(
      "The v1 turn dispatcher requires a positive mailbox position",
    );
  }
  return parsed;
}

function safeNonNegativeInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunCommandExecutorInvariantError(`${name} must be a non-negative safe integer`);
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
    throw new RunCommandExecutorInvariantError(`${description} changed ${updatedRows} rows`);
  }
}

export class RunCommandExecutor {
  readonly #database: Kysely<Database>;
  readonly #backend: TurnExecutionBackend;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #maxAttempts: number;
  readonly #claimOwnerId: string;
  readonly #idGenerator: () => string;
  readonly #leaseManager: TurnExecutionLeaseManager | undefined;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #eventNotificationPublisher: SessionEventNotificationPublisher | undefined;
  readonly #terminalTurnProjectionSource: TerminalTurnProjectionSource | undefined;

  constructor(options: RunCommandExecutorOptions) {
    this.#database = options.database;
    this.#backend = options.backend;
    this.#clock = options.clock ?? (() => new Date());
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      "claimLeaseMs",
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
    this.#metrics = options.metrics;
    this.#eventNotificationPublisher = options.eventNotificationPublisher;
    this.#terminalTurnProjectionSource = options.terminalTurnProjectionSource;
  }

  /**
   * Executes exactly one durable command selected by the PostgreSQL Worker queue. This component
   * owns transactional admission and lifecycle commits; it never chooses
   * between tenants, Sessions, or Runs.
   */
  async dispatchCommand(commandId: string): Promise<RunCommandExecutionResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)
    ) {
      throw new TypeError("commandId must be a UUID");
    }
    return this.#dispatch(commandId.toLowerCase());
  }

  async #dispatch(commandId: string): Promise<RunCommandExecutionResult> {
    const claim = await this.#claimNext(commandId);
    if (!claim) return { status: "idle" };

    const observedAt = safeDate(this.#clock).valueOf();
    this.#metrics?.queueWait.observe(Math.max(0, observedAt - claim.queuedAt.valueOf()) / 1_000);
    this.#metrics?.activeRuns.inc();
    const executionStartedAt = performance.now();
    try {
      const result = await withSpan<RunCommandExecutionResult>({
        serviceName: "pi-cloud-control-plane",
        name: "run.dispatch",
        ...(claim.request.traceContext === undefined ? {} : { parent: claim.request.traceContext }),
        attributes: {
          "pi_cloud.run.id": claim.request.runId,
          "pi_cloud.attempt.id": claim.request.attemptId,
          "pi_cloud.session.id": claim.request.sessionId,
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
                  new RunCommandExecutorInvariantError(
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
                  new RunCommandExecutorInvariantError(
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
              if (error instanceof TurnExecutionCancelledError && error.reason === "user_request") {
                throw new RunCommandExecutorInvariantError(
                  "Cancellation confirmation arrived before its durable lifecycle",
                );
              }
            }
            return this.#recordFailure(claim, started, normalizeFailure(error), acknowledgement);
          }

          await this.#complete(claim, executionResult, acknowledgement);
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

  async #observeCancellation(claim: ClaimedTurn): Promise<RunCommandExecutionResult | undefined> {
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

  async #claimNext(commandId: string): Promise<ClaimedTurn | undefined> {
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
        .innerJoin("workspaces as workspace_row", (join) =>
          join
            .onRef("workspace_row.tenant_id", "=", "session_row.tenant_id")
            .onRef("workspace_row.id", "=", "session_row.workspace_id"),
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
          "session_row.session_kind as sessionKind",
          "session_row.sandbox_retention_policy as sandboxRetention",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.next_event_seq as nextEventSeq",
          "session_row.current_workspace_version_id as sessionWorkspaceVersionId",
          "session_row.forked_from_session_id as forkedFromSessionId",
          "workspace_row.current_workspace_version_id as currentWorkspaceVersionId",
          "run.id as runId",
          "run.trace_id as traceId",
          "run.tool_capability_snapshot as toolCapabilitySnapshot",
          "run.agent_system_prompt as agentSystemPrompt",
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
        .where("workspace_row.deleted_at", "is", null)
        .where("policy.enabled", "=", true)
        .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
        .where("outbox.published_at", "is", null)
        .where("outbox.available_at", "<=", now)
        .where("command.kind", "=", "turn.execute")
        .where("command.id", "=", commandId)
        .where(
          sql<boolean>`not exists (
            select 1
            from workspace_terminal_sessions as active_terminal
            where active_terminal.tenant_id = ${sql.ref("command.tenant_id")}
              and active_terminal.workspace_id = ${sql.ref("session_row.workspace_id")}
              and active_terminal.state in (
                'reserved',
                'materializing',
                'active',
                'cleaning',
                'unknown'
              )
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
        .where(
          sql<boolean>`(
            ${sql.ref("session_row.forked_from_session_id")} is not null
            or not exists (
              select 1
              from turns as workspace_active_turn
              inner join sessions as workspace_active_session
                on workspace_active_session.tenant_id = workspace_active_turn.tenant_id
                and workspace_active_session.id = workspace_active_turn.session_id
              where workspace_active_turn.tenant_id = ${sql.ref("command.tenant_id")}
                and workspace_active_session.workspace_id = ${sql.ref("session_row.workspace_id")}
                and workspace_active_session.forked_from_session_id is null
                and workspace_active_turn.id <> ${sql.ref("command.turn_id")}
                and workspace_active_turn.state in (
                  'dispatching',
                  'running',
                  'waiting_approval',
                  'cancelling'
                )
                and not (
                  ${sql.ref("session_row.session_kind")} = 'subagent'
                  and exists (
                    select 1
                    from subagent_executions as child_execution
                    inner join runs as parent_run
                      on parent_run.tenant_id = child_execution.tenant_id
                      and parent_run.id = child_execution.parent_run_id
                    where child_execution.tenant_id = ${sql.ref("run.tenant_id")}
                      and child_execution.child_run_id = ${sql.ref("run.id")}
                      and (
                        child_execution.workspace_mode = 'none'
                        or (
                          child_execution.workspace_mode = 'shared_serialized'
                          and parent_run.turn_id = workspace_active_turn.id
                        )
                      )
                  )
                )
            )
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
        .limit(1)
        .forUpdate(["outbox", "session_row", "run"])
        .skipLocked()
        .executeTakeFirst();

      if (!row) return undefined;

      if (row.forkedFromSessionId === null) {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("tenant_id", "=", row.tenantId)
          .where("id", "=", row.workspaceId)
          .where("deleted_at", "is", null)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const workspaceBlocked = await transaction
          .selectNoFrom((expression) =>
            expression
              .exists(
                transaction
                  .selectFrom("turns as active_turn")
                  .innerJoin("sessions as active_session", (join) =>
                    join
                      .onRef("active_session.tenant_id", "=", "active_turn.tenant_id")
                      .onRef("active_session.id", "=", "active_turn.session_id"),
                  )
                  .select("active_turn.id")
                  .where("active_turn.tenant_id", "=", row.tenantId)
                  .where("active_session.workspace_id", "=", row.workspaceId)
                  .where("active_session.forked_from_session_id", "is", null)
                  .where("active_turn.id", "!=", row.turnId)
                  .where("active_turn.state", "in", [
                    "dispatching",
                    "running",
                    "waiting_approval",
                    "cancelling",
                  ])
                  .where(
                    sql<boolean>`not (
                      ${row.sessionKind} = 'subagent'
                      and exists (
                        select 1
                        from subagent_executions as child_execution
                        inner join runs as parent_run
                          on parent_run.tenant_id = child_execution.tenant_id
                          and parent_run.id = child_execution.parent_run_id
                        where child_execution.tenant_id = ${row.tenantId}
                          and child_execution.child_run_id = ${row.runId}
                          and (
                            child_execution.workspace_mode = 'none'
                            or (
                              child_execution.workspace_mode = 'shared_serialized'
                              and parent_run.turn_id = ${sql.ref("active_turn.id")}
                            )
                          )
                      )
                    )`,
                  ),
              )
              .as("blocked"),
          )
          .executeTakeFirstOrThrow();
        if (workspaceBlocked.blocked) return undefined;
      }

      const payload = parseTurnCommandOutboxPayload(row.outboxPayload);
      if (
        payload.commandId !== row.commandId ||
        payload.sessionId !== row.sessionId ||
        payload.turnId !== row.turnId
      ) {
        throw new RunCommandExecutorInvariantError(
          "Turn-command outbox identity does not match its durable command",
        );
      }
      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new RunCommandExecutorInvariantError(
          "The v1 turn dispatcher only accepts durable prompt turns",
        );
      }
      if (row.mailboxPosition === null) {
        throw new RunCommandExecutorInvariantError(
          "The v1 turn dispatcher requires a positive mailbox position",
        );
      }
      safeMailboxPosition(row.mailboxPosition);

      const maximumToolCalls = safeNonNegativeInteger(row.maximumToolCalls, "tool-call budget");
      // A post-ACK attempt is never blindly replayed. Pre-ACK retries cannot
      // have executed a Tool, so every newly claimed execution starts with the
      // full per-Run budget. The trusted Runner decrements it in memory while
      // the Agent Loop is active.
      const remainingToolCalls = maximumToolCalls;
      const toolCapabilities = parseCloudToolCapabilitySnapshot(row.toolCapabilitySnapshot);

      const attemptNumber = row.attempts + 1;
      if (row.runAttemptCount !== row.attempts) {
        throw new RunCommandExecutorInvariantError(
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
          throw new RunCommandExecutorInvariantError("Current run attempt is missing");
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
          workspace_base_version_id:
            row.forkedFromSessionId === null
              ? row.currentWorkspaceVersionId
              : row.sessionWorkspaceVersionId,
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
        throw new RunCommandExecutorInvariantError(
          `Claimed command and turn states do not match (${row.commandState}/${row.turnState})`,
        );
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
          sandboxRetention: row.sandboxRetention,
          toolCapabilities,
          ...(row.agentSystemPrompt === null ? {} : { agentSystemPrompt: row.agentSystemPrompt }),
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
        throw new RunCommandExecutorInvariantError(
          "Only a dispatched command and turn can be acknowledged",
        );
      }
      if (rows.outboxPublishedAt !== null) {
        throw new RunCommandExecutorInvariantError(
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
        throw new RunCommandExecutorInvariantError(
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
    });
  }

  async #complete(
    claim: ClaimedTurn,
    result: TurnExecutionResult,
    acknowledgement: TurnExecutionAcknowledgement | undefined,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.completed",
      payload: {
        stopReason: result.stopReason,
        ...(result.workspacePatch === undefined ? {} : { workspacePatch: result.workspacePatch }),
      },
    } as const;
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.commandState !== "acknowledged" ||
        rows.turnState !== "running" ||
        rows.sessionState !== "running" ||
        rows.outboxPublishedAt === null
      ) {
        throw new RunCommandExecutorInvariantError(
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
          stopReason: result.stopReason,
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
          stop_reason: result.stopReason,
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
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        commandId: claim.request.commandId,
        agentId: "root",
        leaseId: acknowledgement?.leaseId ?? terminalEventId,
        fencingToken: acknowledgement?.fencingToken ?? claim.request.attemptNumber,
        body: terminalBody,
        now,
        eventId: terminalEventId,
        ...(this.#eventNotificationPublisher === undefined
          ? {}
          : { notificationPublisher: this.#eventNotificationPublisher }),
      });
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
  ): Promise<RunCommandExecutionResult> {
    const now = safeDate(this.#clock);
    const shouldRetry = !started && failure.retryable && claim.attempt < this.#maxAttempts;
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.failed",
      payload: {
        code: failure.code,
        message: failure.safeMessage,
        retryable: failure.retryable,
      },
    } as const;
    let preparedProjection: PreparedTerminalTurnProjection | undefined;
    if (!shouldRetry) {
      try {
        preparedProjection = await this.#terminalTurnProjectionSource?.prepare({
          tenantId: claim.request.tenantId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          commandId: claim.request.commandId,
          agentId: "root",
          body: terminalBody,
          eventId: terminalEventId,
          occurredAt: now.toISOString(),
        });
      } catch {
        // Interrupted-prefix recovery is best effort and cannot control the
        // authoritative Run/Session terminal transaction.
      }
    }

    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);

      if (shouldRetry) {
        if (
          rows.commandState !== "dispatched" ||
          rows.turnState !== "dispatching" ||
          rows.outboxPublishedAt !== null
        ) {
          throw new RunCommandExecutorInvariantError(
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
            // PostgreSQL owns the retry timestamp. The durable command becomes
            // eligible after available_at, when any Worker may claim it.
            available_at: now,
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
        throw new RunCommandExecutorInvariantError(
          "Command lifecycle does not match the reported execution phase",
        );
      }
      if (started !== (rows.outboxPublishedAt !== null)) {
        throw new RunCommandExecutorInvariantError(
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
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        commandId: claim.request.commandId,
        agentId: "root",
        leaseId: acknowledgement?.leaseId ?? terminalEventId,
        fencingToken: acknowledgement?.fencingToken ?? claim.request.attemptNumber,
        body: terminalBody,
        now,
        eventId: terminalEventId,
        ...(preparedProjection === undefined ? {} : { preparedProjection }),
        ...(this.#eventNotificationPublisher === undefined
          ? {}
          : { notificationPublisher: this.#eventNotificationPublisher }),
      });

      if (started) {
        if (rows.sessionState !== "running") {
          throw new RunCommandExecutorInvariantError(
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
        throw new RunCommandExecutorStaleClaimError("Run attempt was superseded");
      }
      throw new RunCommandExecutorInvariantError("Claimed command lifecycle rows are missing");
    }
    if (row.outboxAttempts !== claim.attempt) {
      throw new RunCommandExecutorStaleClaimError(
        `Outbox claim attempt ${claim.attempt} was superseded by attempt ${row.outboxAttempts}`,
      );
    }
    if (row.currentAttemptId !== claim.request.attemptId) {
      throw new RunCommandExecutorStaleClaimError("Run attempt was superseded");
    }
    return row;
  }
}
