import type { Database } from "@agent-dock/database";
import { transitionSandbox, type SandboxState } from "@agent-dock/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  TurnExecutionAcknowledgement,
  TurnExecutionLeaseManager,
  TurnExecutionRequest,
} from "./outbox-dispatcher.ts";

const DEFAULT_LEASE_DURATION_MS = 60_000;

export type SessionLeaseCoordinatorOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  clock?: () => Date;
  idGenerator?: () => string;
  leaseDurationMs?: number;
};

export class SessionLeaseCoordinatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SessionLeaseCoordinatorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("lease coordinator clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionLeaseCoordinatorError(
      "lease_invariant",
      `${name} is outside the supported integer range`,
      false,
    );
  }
  return parsed;
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new SessionLeaseCoordinatorError(
      "lease_invariant",
      `${description} changed ${updatedRows} rows`,
      false,
    );
  }
}

export class SessionLeaseCoordinator implements TurnExecutionLeaseManager {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #leaseDurationMs: number;

  constructor(options: SessionLeaseCoordinatorOptions) {
    this.#database = options.database;
    this.#sandboxId = options.sandboxId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
  }

  async acquire(request: TurnExecutionRequest): Promise<TurnExecutionAcknowledgement> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state", "last_fencing_token"])
        .where("id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.tenant_id !== request.tenantId ||
        session.project_id !== request.projectId ||
        session.workspace_id !== request.workspaceId
      ) {
        throw new SessionLeaseCoordinatorError(
          "session_unavailable",
          "Session is unavailable for execution",
          false,
        );
      }
      if (session.state !== "cold" && session.state !== "idle") {
        throw new SessionLeaseCoordinatorError(
          "invalid_state",
          "Session is not ready for an execution lease",
          true,
        );
      }

      const existing = await transaction
        .selectFrom("session_leases")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined) {
        if (new Date(existing.valid_until).valueOf() > now.valueOf()) {
          throw new SessionLeaseCoordinatorError(
            "lease_conflict",
            "Session already has a current execution lease",
            true,
          );
        }
        await this.#releaseLeaseRow(
          transaction,
          existing.session_id,
          existing.lease_id,
          existing.sandbox_id,
          existing.fencing_token,
          now,
        );
      }

      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["id", "state", "active_sessions", "max_concurrent_sessions"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || (sandbox.state !== "ready" && sandbox.state !== "leased")) {
        throw new SessionLeaseCoordinatorError(
          "sandbox_unavailable",
          "Execution sandbox is unavailable",
          true,
        );
      }
      if (sandbox.active_sessions >= sandbox.max_concurrent_sessions) {
        throw new SessionLeaseCoordinatorError(
          "capacity",
          "Execution sandbox is at capacity",
          true,
        );
      }

      const previousFence = safeInteger(session.last_fencing_token, "session fencing token");
      const fencingToken = previousFence + 1;
      if (!Number.isSafeInteger(fencingToken)) {
        throw new SessionLeaseCoordinatorError(
          "lease_invariant",
          "Session fencing token is exhausted",
          false,
        );
      }
      const leaseId = this.#idGenerator();
      const validUntil = new Date(now.valueOf() + this.#leaseDurationMs);

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          last_fencing_token: fencingToken,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("id", "=", request.sessionId)
        .where("tenant_id", "=", request.tenantId)
        .where("last_fencing_token", "=", session.last_fencing_token)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "advancing a session fence");

      await transaction
        .insertInto("session_leases")
        .values({
          session_id: request.sessionId,
          lease_id: leaseId,
          sandbox_id: sandbox.id,
          fencing_token: fencingToken,
          valid_until: validUntil,
          acquired_at: now,
          renewed_at: now,
        })
        .executeTakeFirstOrThrow();

      const nextSandboxState =
        sandbox.state === "ready" ? transitionSandbox(sandbox.state, "leased") : sandbox.state;
      const sandboxUpdate = await transaction
        .updateTable("sandboxes")
        .set({
          state: nextSandboxState,
          active_sessions: sandbox.active_sessions + 1,
          updated_at: now,
        })
        .where("id", "=", sandbox.id)
        .where("state", "=", sandbox.state)
        .where("active_sessions", "=", sandbox.active_sessions)
        .executeTakeFirst();
      expectOne(sandboxUpdate.numUpdatedRows, "reserving sandbox capacity");

      return { leaseId, fencingToken };
    });
  }

  async assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void> {
    await this.#currentLease(transaction, request, acknowledgement, now, true);
  }

  async assertCurrentLease(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#currentLease(transaction, request, acknowledgement, now, true);
    });
  }

  async releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void> {
    const lease = await this.#currentLease(transaction, request, acknowledgement, now, false);
    await this.#releaseLeaseRow(
      transaction,
      request.sessionId,
      acknowledgement.leaseId,
      lease.sandbox_id,
      acknowledgement.fencingToken,
      now,
    );
  }

  async releaseAcquired(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.releaseCurrent(transaction, request, acknowledgement, now);
    });
  }

  async #currentLease(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
    requireUnexpired: boolean,
  ) {
    const lease = await transaction
      .selectFrom("session_leases")
      .selectAll()
      .where("session_id", "=", request.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      lease === undefined ||
      lease.lease_id !== acknowledgement.leaseId ||
      safeInteger(lease.fencing_token, "lease fencing token") !== acknowledgement.fencingToken ||
      lease.sandbox_id !== this.#sandboxId ||
      (requireUnexpired && new Date(lease.valid_until).valueOf() <= now.valueOf())
    ) {
      throw new SessionLeaseCoordinatorError("stale_fence", "Execution lease is stale", false);
    }
    return lease;
  }

  async #releaseLeaseRow(
    transaction: Transaction<Database>,
    sessionId: string,
    leaseId: string,
    sandboxId: string,
    fencingToken: string | number | bigint,
    now: Date,
  ): Promise<void> {
    const sandbox = await transaction
      .selectFrom("sandboxes")
      .select(["state", "active_sessions"])
      .where("id", "=", sandboxId)
      .forUpdate()
      .executeTakeFirst();
    if (
      sandbox === undefined ||
      sandbox.active_sessions < 1 ||
      (sandbox.state !== "leased" && sandbox.state !== "draining" && sandbox.state !== "failed")
    ) {
      throw new SessionLeaseCoordinatorError(
        "lease_invariant",
        "Lease references an unavailable sandbox reservation",
        false,
      );
    }

    const deleted = await transaction
      .deleteFrom("session_leases")
      .where("session_id", "=", sessionId)
      .where("lease_id", "=", leaseId)
      .where("sandbox_id", "=", sandboxId)
      .where("fencing_token", "=", String(fencingToken))
      .executeTakeFirst();
    expectOne(deleted.numDeletedRows, "releasing a session lease");

    const remaining = sandbox.active_sessions - 1;
    let nextState: SandboxState = sandbox.state;
    if (remaining === 0 && sandbox.state === "leased") {
      nextState = transitionSandbox(sandbox.state, "ready");
    }
    const sandboxUpdate = await transaction
      .updateTable("sandboxes")
      .set({ state: nextState, active_sessions: remaining, updated_at: now })
      .where("id", "=", sandboxId)
      .where("state", "=", sandbox.state)
      .where("active_sessions", "=", sandbox.active_sessions)
      .executeTakeFirst();
    expectOne(sandboxUpdate.numUpdatedRows, "releasing sandbox capacity");
  }
}
