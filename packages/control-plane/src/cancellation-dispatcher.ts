import type { Database } from "@agent-dock/database";
import {
  transitionCommand,
  transitionSession,
  transitionTurn,
  type CommandState,
  type SessionState,
  type TurnState,
} from "@agent-dock/domain";
import {
  TURN_CANCELLATION_OUTBOX_TOPIC,
  parseEnvironmentRuntimeSnapshot,
  parseTurnCancellationOutboxPayload,
  type CancelTurnCommandMessage,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import type {
  TurnExecutionAcknowledgement,
  TurnExecutionLeaseManager,
  TurnExecutionRequest,
} from "./outbox-dispatcher.ts";
import {
  validateSupervisorDispatchAffinity,
  type SupervisorDispatchAffinity,
} from "./supervisor-dispatch-affinity.ts";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";
import { commitTerminalTurnEvent } from "./terminal-turn-event.ts";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type TurnCancellationReason = CancelTurnCommandMessage["payload"]["reason"];

export type TurnCancellationRequest = {
  commandId: string;
  idempotencyKey: string;
  reason: TurnCancellationReason;
  gracePeriodMs: number;
  target: TurnExecutionRequest;
};

export type TurnCancellationLifecycle = {
  started(acknowledgement: TurnExecutionAcknowledgement): Promise<void>;
};

export type TurnCancellationResult = {
  reason: TurnCancellationReason;
  forced: boolean;
};

export interface TurnCancellationBackend {
  cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult>;
}

export class TurnCancellationBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "TurnCancellationBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class CancellationDispatcherInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationDispatcherInvariantError";
  }
}

export class CancellationDispatcherStaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationDispatcherStaleClaimError";
  }
}

export type CancellationDispatchNextResult =
  | { status: "idle" }
  | {
      status: "cancelled";
      commandId: string;
      targetCommandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      forced: boolean;
    }
  | {
      status: "retry_scheduled";
      commandId: string;
      targetCommandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      failureCode: string;
    }
  | {
      status: "failed";
      commandId: string;
      targetCommandId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      phase: "before_start" | "after_start";
      failureCode: string;
    };

export type CancellationDispatcherOptions = {
  database: Kysely<Database>;
  tenantId?: string;
  backend: TurnCancellationBackend;
  leaseManager: TurnExecutionLeaseManager;
  clock?: () => Date;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  supervisorAffinity?: SupervisorDispatchAffinity;
  idGenerator?: () => string;
  eventNotificationPublisher?: SessionEventNotificationPublisher;
};

type ClaimedCancellation = {
  outboxId: string;
  attempt: number;
  request: TurnCancellationRequest;
};

type CancellationLifecycleRows = {
  cancellationCommandState: CommandState;
  targetCommandState: CommandState;
  turnState: TurnState;
  sessionState: SessionState;
  outboxAttempts: number;
  outboxPublishedAt: Date | string | null;
  runState: import("@agent-dock/domain").RunState;
  runAttemptState: import("@agent-dock/domain").RunAttemptState;
  currentAttemptId: string | null;
};

type CancellationFailure = {
  code: string;
  safeMessage: string;
  retryable: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("cancellation dispatcher clock must return a valid Date");
  }
  return value;
}

function parseCancellationPayload(value: Record<string, unknown>): {
  targetCommandId: string;
  reason: TurnCancellationReason;
  gracePeriodMs: number;
} {
  const targetCommandId = value.targetCommandId;
  const reason = value.reason;
  const gracePeriodMs = value.gracePeriodMs;
  if (typeof targetCommandId !== "string" || targetCommandId.length === 0) {
    throw new CancellationDispatcherInvariantError("Cancellation command target is missing");
  }
  if (
    reason !== "user_request" &&
    reason !== "timeout" &&
    reason !== "lease_revoked" &&
    reason !== "shutdown"
  ) {
    throw new CancellationDispatcherInvariantError("Cancellation command reason is invalid");
  }
  if (!Number.isSafeInteger(gracePeriodMs) || (gracePeriodMs as number) < 0) {
    throw new CancellationDispatcherInvariantError("Cancellation grace period is invalid");
  }
  return { targetCommandId, reason, gracePeriodMs: gracePeriodMs as number };
}

function normalizeFailure(error: unknown): CancellationFailure {
  if (error instanceof TurnCancellationBackendError) {
    return { code: error.code, safeMessage: error.message, retryable: error.retryable };
  }
  return {
    code: "cancellation_backend_error",
    safeMessage: "Cancellation backend failed",
    retryable: true,
  };
}

function expectOne(changedRows: bigint, description: string): void {
  if (changedRows !== 1n) {
    throw new CancellationDispatcherInvariantError(`${description} changed ${changedRows} rows`);
  }
}

export class CancellationDispatcher {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string | undefined;
  readonly #backend: TurnCancellationBackend;
  readonly #leaseManager: TurnExecutionLeaseManager;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;
  readonly #supervisorAffinity: SupervisorDispatchAffinity | undefined;
  readonly #idGenerator: () => string;
  readonly #eventNotificationPublisher: SessionEventNotificationPublisher | undefined;

  constructor(options: CancellationDispatcherOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#backend = options.backend;
    this.#leaseManager = options.leaseManager;
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
    this.#supervisorAffinity =
      options.supervisorAffinity === undefined
        ? undefined
        : validateSupervisorDispatchAffinity(options.supervisorAffinity);
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#eventNotificationPublisher = options.eventNotificationPublisher;
  }

  async dispatchNext(): Promise<CancellationDispatchNextResult> {
    return this.#dispatch();
  }

  /**
   * Executes the cancellation for one exact execution command. Temporal uses
   * this on the same Activity Worker that owns the live Pi runtime.
   */
  async dispatchTargetCommand(targetCommandId: string): Promise<CancellationDispatchNextResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        targetCommandId,
      )
    ) {
      throw new TypeError("targetCommandId must be a UUID");
    }
    return this.#dispatch(targetCommandId.toLowerCase());
  }

  async #dispatch(targetCommandId?: string): Promise<CancellationDispatchNextResult> {
    const claim = await this.#claimNext(targetCommandId);
    if (claim === undefined) return { status: "idle" };

    let started = false;
    let acknowledgement: TurnExecutionAcknowledgement | undefined;
    let startedPromise: Promise<void> | undefined;
    let startFailure: unknown;
    const lifecycle: TurnCancellationLifecycle = {
      started: (candidate) => {
        if (
          startedPromise !== undefined &&
          (candidate.leaseId !== acknowledgement?.leaseId ||
            candidate.fencingToken !== acknowledgement.fencingToken)
        ) {
          return Promise.reject(
            new CancellationDispatcherInvariantError(
              "Cancellation acknowledgement changed after start",
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

    let result: TurnCancellationResult;
    try {
      result = await this.#backend.cancel(claim.request, lifecycle);
      if (startedPromise !== undefined) await startedPromise;
      if (!started || acknowledgement === undefined) {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Cancellation backend returned before acknowledging the command",
          false,
        );
      }
      if (result.reason !== claim.request.reason || typeof result.forced !== "boolean") {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Cancellation backend returned an invalid termination confirmation",
          false,
        );
      }
    } catch (error: unknown) {
      if (startedPromise !== undefined && !started && startFailure === undefined) {
        try {
          await startedPromise;
        } catch {
          // Preserve the durable lifecycle failure below.
        }
      }
      if (startFailure !== undefined) {
        if (startFailure instanceof TurnCancellationBackendError) {
          return this.#recordFailure(claim, false, normalizeFailure(startFailure));
        }
        throw startFailure;
      }
      return this.#recordFailure(claim, started, normalizeFailure(error));
    }

    await this.#complete(claim, acknowledgement, result);
    return {
      status: "cancelled",
      commandId: claim.request.commandId,
      targetCommandId: claim.request.target.commandId,
      sessionId: claim.request.target.sessionId,
      turnId: claim.request.target.turnId,
      attempt: claim.attempt,
      forced: result.forced,
    };
  }

  async #claimNext(targetCommandId?: string): Promise<ClaimedCancellation | undefined> {
    const now = safeDate(this.#clock);
    const leaseUntil = new Date(now.valueOf() + this.#claimLeaseMs);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("outbox")
        .innerJoin("commands as cancellation", (join) =>
          join
            .onRef("cancellation.tenant_id", "=", "outbox.tenant_id")
            .on(
              sql<boolean>`${sql.ref("cancellation.id")}::text = ${sql.ref("outbox.payload")} ->> 'commandId'`,
            ),
        )
        .innerJoin("commands as target", (join) =>
          join
            .onRef("target.tenant_id", "=", "cancellation.tenant_id")
            .onRef("target.session_id", "=", "cancellation.session_id")
            .onRef("target.turn_id", "=", "cancellation.turn_id")
            .on(
              sql<boolean>`${sql.ref("target.id")}::text = ${sql.ref("outbox.payload")} ->> 'targetCommandId'`,
            ),
        )
        .innerJoin("turns as turn", (join) =>
          join
            .onRef("turn.tenant_id", "=", "cancellation.tenant_id")
            .onRef("turn.session_id", "=", "cancellation.session_id")
            .onRef("turn.id", "=", "cancellation.turn_id"),
        )
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "cancellation.tenant_id")
            .onRef("session_row.id", "=", "cancellation.session_id"),
        )
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "target.tenant_id")
            .onRef("run.session_id", "=", "target.session_id")
            .onRef("run.turn_id", "=", "target.turn_id")
            .onRef("run.command_id", "=", "target.id"),
        )
        .innerJoin("run_attempts as run_attempt", (join) =>
          join
            .onRef("run_attempt.run_id", "=", "run.id")
            .onRef("run_attempt.id", "=", "run.current_attempt_id"),
        )
        .innerJoin("environment_versions as environment", (join) =>
          join
            .onRef("environment.tenant_id", "=", "run.tenant_id")
            .onRef("environment.project_id", "=", "run.project_id")
            .onRef("environment.id", "=", "run.environment_version_id"),
        )
        .select([
          "outbox.tenant_id as tenantId",
          "outbox.id as outboxId",
          "outbox.payload as outboxPayload",
          "outbox.attempts as attempts",
          "cancellation.id as cancellationCommandId",
          "cancellation.idempotency_key as cancellationIdempotencyKey",
          "cancellation.payload as cancellationPayload",
          "cancellation.state as cancellationCommandState",
          "target.id as targetCommandId",
          "target.idempotency_key as targetIdempotencyKey",
          "turn.id as turnId",
          "turn.input_kind as inputKind",
          "turn.input_text as inputText",
          "turn.model_profile_id as modelProfileId",
          "turn.provider as provider",
          "turn.model_id as modelId",
          "turn.thinking_level as thinkingLevel",
          "turn.credential_binding_id as credentialBindingId",
          "turn.credential_binding_version as credentialBindingVersion",
          "session_row.id as sessionId",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.next_event_seq as nextEventSeq",
          "run.id as runId",
          "run_attempt.id as runAttemptId",
          "run_attempt.attempt_number as runAttemptNumber",
          "environment.id as environmentVersionId",
          "environment.version_number as environmentVersionNumber",
          "environment.profile_key as environmentProfileKey",
          "environment.profile_version as environmentProfileVersion",
          "environment.image_revision as environmentImageRevision",
          "environment.spec_sha256 as environmentSpecSha256",
          "environment.recipe as environmentRecipe",
          "environment.recipe_sha256 as environmentRecipeSha256",
        ])
        .where(
          this.#tenantId === undefined
            ? sql<boolean>`true`
            : sql<boolean>`${sql.ref("outbox.tenant_id")} = ${this.#tenantId}`,
        )
        .where("outbox.topic", "=", TURN_CANCELLATION_OUTBOX_TOPIC)
        .where("outbox.published_at", "is", null)
        .where("outbox.available_at", "<=", now)
        .where("cancellation.kind", "=", "turn.cancel")
        .where("cancellation.state", "in", ["pending", "dispatched"])
        .where("target.kind", "=", "turn.execute")
        .where(
          targetCommandId === undefined
            ? sql<boolean>`true`
            : sql<boolean>`${sql.ref("target.id")} = ${targetCommandId}`,
        )
        .where(
          this.#supervisorAffinity === undefined
            ? sql<boolean>`true`
            : sql<boolean>`exists (
                select 1
                from session_leases as affinity_lease
                inner join supervisor_connections as affinity_connection
                  on affinity_connection.sandbox_id = affinity_lease.sandbox_id
                where affinity_lease.session_id = ${sql.ref("session_row.id")}
                  and affinity_lease.sandbox_id = ${this.#supervisorAffinity.sandboxId}
                  and affinity_lease.valid_until > ${now}
                  and affinity_connection.control_plane_instance_id = ${this.#supervisorAffinity.controlPlaneInstanceId}
                  and affinity_connection.state = 'active'
                  and affinity_connection.expires_at > ${now}
              )`,
        )
        .orderBy("outbox.available_at", "asc")
        .orderBy("outbox.created_at", "asc")
        .orderBy("outbox.id", "asc")
        .limit(1)
        .forUpdate([
          "outbox",
          "cancellation",
          "target",
          "turn",
          "session_row",
          "run",
          "run_attempt",
        ])
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return undefined;

      const outboxPayload = parseTurnCancellationOutboxPayload(row.outboxPayload);
      const commandPayload = parseCancellationPayload(row.cancellationPayload);
      if (
        outboxPayload.commandId !== row.cancellationCommandId ||
        outboxPayload.targetCommandId !== row.targetCommandId ||
        outboxPayload.sessionId !== row.sessionId ||
        outboxPayload.turnId !== row.turnId ||
        commandPayload.targetCommandId !== row.targetCommandId
      ) {
        throw new CancellationDispatcherInvariantError(
          "Cancellation outbox identity does not match its durable commands",
        );
      }
      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new CancellationDispatcherInvariantError(
          "The v1 cancellation dispatcher only targets durable prompt turns",
        );
      }

      if (row.cancellationCommandState === "pending") {
        const commandUpdate = await transaction
          .updateTable("commands")
          .set({
            state: transitionCommand(row.cancellationCommandState, "dispatched"),
            dispatched_at: now,
            failure_code: null,
          })
          .where("tenant_id", "=", row.tenantId)
          .where("id", "=", row.cancellationCommandId)
          .where("state", "=", row.cancellationCommandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "claiming a cancellation command");
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
      expectOne(outboxUpdate.numUpdatedRows, "leasing a cancellation outbox record");

      return {
        outboxId: row.outboxId,
        attempt: row.attempts + 1,
        request: {
          commandId: row.cancellationCommandId,
          idempotencyKey: row.cancellationIdempotencyKey,
          reason: commandPayload.reason,
          gracePeriodMs: commandPayload.gracePeriodMs,
          target: {
            tenantId: row.tenantId,
            projectId: row.projectId,
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            runId: row.runId,
            turnId: row.turnId,
            attemptId: row.runAttemptId,
            attemptNumber: row.runAttemptNumber,
            commandId: row.targetCommandId,
            idempotencyKey: row.targetIdempotencyKey,
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
          },
        },
      };
    });
  }

  async #markStarted(
    claim: ClaimedCancellation,
    acknowledgement: TurnExecutionAcknowledgement,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      const activePair =
        (rows.turnState === "running" && rows.sessionState === "running") ||
        (rows.turnState === "waiting_approval" && rows.sessionState === "waiting_approval");
      if (
        rows.cancellationCommandState !== "dispatched" ||
        rows.targetCommandState !== "acknowledged" ||
        !activePair ||
        rows.outboxPublishedAt !== null
      ) {
        throw new TurnCancellationBackendError(
          "cancellation_too_late",
          "Turn was no longer active when cancellation reached the supervisor",
          false,
        );
      }
      const priorTerminalEvent = await transaction
        .selectFrom("session_events")
        .select("event_id")
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("session_id", "=", claim.request.target.sessionId)
        .where("turn_id", "=", claim.request.target.turnId)
        .where("command_id", "=", claim.request.target.commandId)
        .where("type", "in", ["turn.completed", "turn.failed", "turn.cancelled"])
        .executeTakeFirst();
      if (priorTerminalEvent !== undefined) {
        throw new TurnCancellationBackendError(
          "cancellation_too_late",
          "Turn already emitted a terminal event before cancellation",
          false,
        );
      }
      await this.#leaseManager.assertCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.target.tenantId,
          runId: claim.request.target.runId,
          attemptId: claim.request.target.attemptId,
        },
        {
          runState: "cancel_requested",
          attemptState: "cancel_requested",
          reason: `cancellation_${claim.request.reason}`,
          now,
          heartbeat: true,
        },
      );

      const cancellationUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.cancellationCommandState, "acknowledged"),
          acknowledged_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.cancellationCommandState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "acknowledging a cancellation command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({ state: transitionTurn(rows.turnState, "cancelling") })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "cancelling a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "cancelling"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "cancelling a session");

      const outboxUpdate = await transaction
        .updateTable("outbox")
        .set({ published_at: now, last_error: null })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "publishing an acknowledged cancellation");
    });
  }

  async #complete(
    claim: ClaimedCancellation,
    acknowledgement: TurnExecutionAcknowledgement,
    result: TurnCancellationResult,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.cancellationCommandState !== "acknowledged" ||
        rows.targetCommandState !== "acknowledged" ||
        rows.turnState !== "cancelling" ||
        rows.sessionState !== "cancelling" ||
        rows.outboxPublishedAt === null
      ) {
        throw new CancellationDispatcherInvariantError(
          "Only an acknowledged cancellation can settle a turn",
        );
      }

      await this.#leaseManager.assertCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.target.tenantId,
          runId: claim.request.target.runId,
          attemptId: claim.request.target.attemptId,
        },
        {
          runState: "cancelled",
          attemptState: "cancelled",
          reason: "cancellation_confirmed",
          now,
          stopReason: "cancelled",
        },
      );

      const cancellationUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.cancellationCommandState, "completed"),
          completed_at: now,
          failure_code: null,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.cancellationCommandState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "completing a cancellation command");

      const targetUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.targetCommandState, "completed"),
          completed_at: now,
          failure_code: null,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.commandId)
        .where("state", "=", rows.targetCommandState)
        .executeTakeFirst();
      expectOne(targetUpdate.numUpdatedRows, "completing the cancelled execute command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "cancelled"),
          stop_reason: "cancelled",
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "settling a cancelled turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "idle"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "settling a cancelled session");
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.target.tenantId,
        sessionId: claim.request.target.sessionId,
        turnId: claim.request.target.turnId,
        commandId: claim.request.target.commandId,
        agentId: "root",
        leaseId: acknowledgement.leaseId,
        fencingToken: acknowledgement.fencingToken,
        body: {
          type: "turn.cancelled",
          payload: { reason: result.reason, forced: result.forced },
        },
        now,
        eventId: this.#idGenerator(),
        ...(this.#eventNotificationPublisher === undefined
          ? {}
          : { notificationPublisher: this.#eventNotificationPublisher }),
      });

      await this.#leaseManager.releaseCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
    });
  }

  async #recordFailure(
    claim: ClaimedCancellation,
    started: boolean,
    failure: CancellationFailure,
  ): Promise<CancellationDispatchNextResult> {
    const now = safeDate(this.#clock);
    const shouldRetry = !started && failure.retryable && claim.attempt < this.#maxAttempts;

    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (shouldRetry) {
        if (rows.cancellationCommandState !== "dispatched" || rows.outboxPublishedAt !== null) {
          throw new CancellationDispatcherInvariantError(
            "Only an unacknowledged cancellation can return to the mailbox",
          );
        }
        const commandUpdate = await transaction
          .updateTable("commands")
          .set({ state: transitionCommand(rows.cancellationCommandState, "pending") })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.commandId)
          .where("state", "=", rows.cancellationCommandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "requeueing a cancellation command");

        const outboxUpdate = await transaction
          .updateTable("outbox")
          .set({
            available_at: new Date(now.valueOf() + this.#retryDelayMs),
            last_error: failure.code,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.outboxId)
          .where("published_at", "is", null)
          .executeTakeFirst();
        expectOne(outboxUpdate.numUpdatedRows, "scheduling a cancellation retry");
        return;
      }

      const expectedCancellationState = started ? "acknowledged" : "dispatched";
      if (
        rows.cancellationCommandState !== expectedCancellationState ||
        started !== (rows.outboxPublishedAt !== null)
      ) {
        throw new CancellationDispatcherInvariantError(
          "Cancellation lifecycle does not match the reported failure phase",
        );
      }

      const cancellationUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.cancellationCommandState, "failed"),
          completed_at: now,
          failure_code: failure.code,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.commandId)
        .where("state", "=", rows.cancellationCommandState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "failing a cancellation command");

      if (started) {
        if (
          rows.targetCommandState !== "acknowledged" ||
          rows.turnState !== "cancelling" ||
          rows.sessionState !== "cancelling"
        ) {
          throw new CancellationDispatcherInvariantError(
            "A started cancellation must own the cancelling lifecycle",
          );
        }
        await transitionCurrentRunAttempt(
          transaction,
          {
            tenantId: claim.request.target.tenantId,
            runId: claim.request.target.runId,
            attemptId: claim.request.target.attemptId,
          },
          {
            runState: "failed",
            attemptState: "failed",
            reason: "cancellation_failed",
            now,
            failure: {
              code: failure.code,
              message: failure.safeMessage,
              retryable: false,
            },
          },
        );
        const targetUpdate = await transaction
          .updateTable("commands")
          .set({
            state: transitionCommand(rows.targetCommandState, "failed"),
            completed_at: now,
            failure_code: failure.code,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.target.commandId)
          .where("state", "=", rows.targetCommandState)
          .executeTakeFirst();
        expectOne(targetUpdate.numUpdatedRows, "failing the cancellation target command");

        const turnUpdate = await transaction
          .updateTable("turns")
          .set({
            state: transitionTurn(rows.turnState, "failed"),
            failure_code: failure.code,
            failure_message: failure.safeMessage,
            failure_retryable: false,
            settled_at: now,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.target.turnId)
          .where("state", "=", rows.turnState)
          .executeTakeFirst();
        expectOne(turnUpdate.numUpdatedRows, "failing a cancelling turn");

        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: transitionSession(rows.sessionState, "failed"),
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.target.sessionId)
          .where("state", "=", rows.sessionState)
          .executeTakeFirst();
        expectOne(sessionUpdate.numUpdatedRows, "failing a cancelling session");
      } else {
        const outboxUpdate = await transaction
          .updateTable("outbox")
          .set({ published_at: now, last_error: failure.code })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.outboxId)
          .where("published_at", "is", null)
          .executeTakeFirst();
        expectOne(outboxUpdate.numUpdatedRows, "publishing a rejected cancellation");
      }
    });

    if (shouldRetry) {
      return {
        status: "retry_scheduled",
        commandId: claim.request.commandId,
        targetCommandId: claim.request.target.commandId,
        sessionId: claim.request.target.sessionId,
        turnId: claim.request.target.turnId,
        attempt: claim.attempt,
        failureCode: failure.code,
      };
    }
    return {
      status: "failed",
      commandId: claim.request.commandId,
      targetCommandId: claim.request.target.commandId,
      sessionId: claim.request.target.sessionId,
      turnId: claim.request.target.turnId,
      attempt: claim.attempt,
      phase: started ? "after_start" : "before_start",
      failureCode: failure.code,
    };
  }

  async #lockLifecycleRows(
    transaction: Transaction<Database>,
    claim: ClaimedCancellation,
  ): Promise<CancellationLifecycleRows> {
    const row = await transaction
      .selectFrom("commands as cancellation")
      .innerJoin("commands as target", (join) =>
        join
          .onRef("target.tenant_id", "=", "cancellation.tenant_id")
          .onRef("target.session_id", "=", "cancellation.session_id")
          .onRef("target.turn_id", "=", "cancellation.turn_id")
          .on("target.id", "=", claim.request.target.commandId),
      )
      .innerJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "cancellation.tenant_id")
          .onRef("turn.session_id", "=", "cancellation.session_id")
          .onRef("turn.id", "=", "cancellation.turn_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "cancellation.tenant_id")
          .onRef("session_row.id", "=", "cancellation.session_id"),
      )
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "cancellation.tenant_id")
          .on("outbox.id", "=", claim.outboxId),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "target.tenant_id")
          .onRef("run.session_id", "=", "target.session_id")
          .onRef("run.turn_id", "=", "target.turn_id")
          .onRef("run.command_id", "=", "target.id"),
      )
      .innerJoin("run_attempts as run_attempt", (join) =>
        join
          .onRef("run_attempt.run_id", "=", "run.id")
          .onRef("run_attempt.id", "=", "run.current_attempt_id"),
      )
      .select([
        "cancellation.state as cancellationCommandState",
        "target.state as targetCommandState",
        "turn.state as turnState",
        "session_row.state as sessionState",
        "outbox.attempts as outboxAttempts",
        "outbox.published_at as outboxPublishedAt",
        "run.state as runState",
        "run.current_attempt_id as currentAttemptId",
        "run_attempt.state as runAttemptState",
      ])
      .where("cancellation.tenant_id", "=", claim.request.target.tenantId)
      .where("cancellation.id", "=", claim.request.commandId)
      .where("target.id", "=", claim.request.target.commandId)
      .where("turn.id", "=", claim.request.target.turnId)
      .where("session_row.id", "=", claim.request.target.sessionId)
      .where("run.id", "=", claim.request.target.runId)
      .where("run_attempt.id", "=", claim.request.target.attemptId)
      .forUpdate(["cancellation", "target", "turn", "session_row", "outbox", "run", "run_attempt"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new CancellationDispatcherInvariantError(
        "Claimed cancellation lifecycle rows are missing",
      );
    }
    if (row.outboxAttempts !== claim.attempt) {
      throw new CancellationDispatcherStaleClaimError(
        `Cancellation claim attempt ${claim.attempt} was superseded by attempt ${row.outboxAttempts}`,
      );
    }
    if (row.currentAttemptId !== claim.request.target.attemptId) {
      throw new CancellationDispatcherStaleClaimError("Cancellation target attempt was superseded");
    }
    return row;
  }
}
