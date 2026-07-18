import type { Database } from "@agent-dock/database";
import {
  transitionCommand,
  transitionSession,
  transitionTurn,
  type CommandState,
  type SessionState,
  type TurnState,
} from "@agent-dock/domain";
import { TURN_COMMAND_OUTBOX_TOPIC, parseTurnCommandOutboxPayload } from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type TurnExecutionRequest = {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
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
};

export type TurnExecutionLifecycle = {
  started(): Promise<void>;
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

export class TurnExecutionBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "TurnExecutionBackendError";
    this.code = code;
    this.retryable = retryable;
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
  tenantId: string;
  backend: TurnExecutionBackend;
  clock?: () => Date;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
};

type ClaimedTurn = {
  outboxId: string;
  attempt: number;
  request: TurnExecutionRequest;
};

type LifecycleRows = {
  commandState: CommandState;
  turnState: TurnState;
  sessionState: SessionState;
  outboxAttempts: number;
  outboxPublishedAt: Date | string | null;
};

type ExecutionFailure = {
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
    };
  }
  return {
    code: "execution_backend_error",
    safeMessage: "Execution backend failed",
    retryable: true,
  };
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new OutboxDispatcherInvariantError(`${description} changed ${updatedRows} rows`);
  }
}

export class OutboxDispatcher {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #backend: TurnExecutionBackend;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;

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
  }

  async dispatchNext(): Promise<DispatchNextResult> {
    const claim = await this.#claimNext();
    if (!claim) return { status: "idle" };

    let started = false;
    let startedPromise: Promise<void> | undefined;
    let startFailure: unknown;
    const lifecycle: TurnExecutionLifecycle = {
      started: () => {
        startedPromise ??= this.#markStarted(claim).then(
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
      return this.#recordFailure(claim, started, normalizeFailure(error));
    }

    await this.#complete(claim, executionResult.stopReason);
    return {
      status: "completed",
      commandId: claim.request.commandId,
      sessionId: claim.request.sessionId,
      turnId: claim.request.turnId,
      attempt: claim.attempt,
    };
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
        .select([
          "outbox.id as outboxId",
          "outbox.payload as outboxPayload",
          "outbox.attempts as attempts",
          "command.id as commandId",
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
        ])
        .where("outbox.tenant_id", "=", this.#tenantId)
        .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
        .where("outbox.published_at", "is", null)
        .where("outbox.available_at", "<=", now)
        .where("command.kind", "=", "turn.execute")
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
              and (
                earlier_command.created_at < ${sql.ref("command.created_at")}
                or (
                  earlier_command.created_at = ${sql.ref("command.created_at")}
                  and earlier_command.id < ${sql.ref("command.id")}
                )
              )
          )`,
        )
        .where("session_row.state", "in", ["cold", "idle"])
        .orderBy("outbox.available_at", "asc")
        .orderBy("outbox.created_at", "asc")
        .orderBy("outbox.id", "asc")
        .limit(1)
        .forUpdate(["outbox", "session_row"])
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

      if (row.commandState === "pending" && row.turnState === "queued") {
        const commandUpdate = await transaction
          .updateTable("commands")
          .set({
            state: transitionCommand(row.commandState, "dispatched"),
            dispatched_at: now,
            failure_code: null,
          })
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", row.commandId)
          .where("state", "=", row.commandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "claiming a command");

        const turnUpdate = await transaction
          .updateTable("turns")
          .set({ state: transitionTurn(row.turnState, "dispatching") })
          .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", row.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "leasing an outbox record");

      return {
        outboxId: row.outboxId,
        attempt: row.attempts + 1,
        request: {
          tenantId: this.#tenantId,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          turnId: row.turnId,
          commandId: row.commandId,
          input: { kind: "prompt", prompt: row.inputText },
          model: {
            profileId: row.modelProfileId,
            provider: row.provider,
            modelId: row.modelId,
            thinkingLevel: row.thinkingLevel,
            credentialBindingId: row.credentialBindingId,
            credentialBindingVersion: row.credentialBindingVersion,
          },
        },
      };
    });
  }

  async #markStarted(claim: ClaimedTurn): Promise<void> {
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
        .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "starting a session");

      const outboxUpdate = await transaction
        .updateTable("outbox")
        .set({ published_at: now, last_error: null })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", claim.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "publishing an acknowledged outbox record");
    });
  }

  async #complete(claim: ClaimedTurn, stopReason: string): Promise<void> {
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

      const commandUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.commandState, "completed"),
          completed_at: now,
          failure_code: null,
        })
        .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "settling a session");
    });
  }

  async #recordFailure(
    claim: ClaimedTurn,
    started: boolean,
    failure: ExecutionFailure,
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
        const commandUpdate = await transaction
          .updateTable("commands")
          .set({ state: transitionCommand(rows.commandState, "pending") })
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", claim.request.commandId)
          .where("state", "=", rows.commandState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "requeueing a command");

        const turnUpdate = await transaction
          .updateTable("turns")
          .set({ state: transitionTurn(rows.turnState, "queued") })
          .where("tenant_id", "=", this.#tenantId)
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
          .where("tenant_id", "=", this.#tenantId)
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

      const commandUpdate = await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(rows.commandState, "failed"),
          completed_at: now,
          failure_code: failure.code,
        })
        .where("tenant_id", "=", this.#tenantId)
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
        .where("tenant_id", "=", this.#tenantId)
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
        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: transitionSession(rows.sessionState, "idle"),
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", claim.request.sessionId)
          .where("state", "=", rows.sessionState)
          .executeTakeFirst();
        expectOne(sessionUpdate.numUpdatedRows, "settling a failed session");
      }

      if (!started) {
        const outboxUpdate = await transaction
          .updateTable("outbox")
          .set({ published_at: now, last_error: failure.code })
          .where("tenant_id", "=", this.#tenantId)
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
      .select([
        "command.state as commandState",
        "turn.state as turnState",
        "session_row.state as sessionState",
        "outbox.attempts as outboxAttempts",
        "outbox.published_at as outboxPublishedAt",
      ])
      .where("command.tenant_id", "=", this.#tenantId)
      .where("command.id", "=", claim.request.commandId)
      .where("turn.id", "=", claim.request.turnId)
      .where("session_row.id", "=", claim.request.sessionId)
      .forUpdate(["command", "turn", "session_row", "outbox"])
      .executeTakeFirst();

    if (!row) {
      throw new OutboxDispatcherInvariantError("Claimed command lifecycle rows are missing");
    }
    if (row.outboxAttempts !== claim.attempt) {
      throw new OutboxDispatcherStaleClaimError(
        `Outbox claim attempt ${claim.attempt} was superseded by attempt ${row.outboxAttempts}`,
      );
    }
    return row;
  }
}
