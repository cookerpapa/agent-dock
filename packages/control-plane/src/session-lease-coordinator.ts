import type { Database } from "@agent-dock/database";
import { transitionSandbox, type SandboxState } from "@agent-dock/domain";
import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
} from "@agent-dock/protocol";
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
  heartbeatConnectionId?: string;
  connectionGuard?: SupervisorConnectionGuard;
};

export type SupervisorConnectionGuard = {
  controlPlaneInstanceId: string;
  transportId: string;
  heartbeatTimeoutMs: number;
};

export type SupervisorHeartbeatIdentity = {
  supervisorId: string;
  bootId: string;
  connectionId: string;
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

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

const ACTIVE_SESSION_STATES = new Set(["running", "waiting_approval", "cancelling"]);
const ACTIVE_TURN_STATES = new Set(["running", "waiting_approval", "cancelling"]);

export class SessionLeaseCoordinator implements TurnExecutionLeaseManager {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #leaseDurationMs: number;
  readonly #heartbeatConnectionId: string;
  readonly #connectionGuard: SupervisorConnectionGuard | undefined;

  constructor(options: SessionLeaseCoordinatorOptions) {
    this.#database = options.database;
    this.#sandboxId = options.sandboxId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#heartbeatConnectionId = requireUuid(
      options.heartbeatConnectionId ?? globalThis.crypto.randomUUID(),
      "heartbeatConnectionId",
    );
    this.#connectionGuard =
      options.connectionGuard === undefined
        ? undefined
        : {
            controlPlaneInstanceId: requireUuid(
              options.connectionGuard.controlPlaneInstanceId,
              "connectionGuard.controlPlaneInstanceId",
            ),
            transportId: requireUuid(
              options.connectionGuard.transportId,
              "connectionGuard.transportId",
            ),
            heartbeatTimeoutMs: positiveInteger(
              options.connectionGuard.heartbeatTimeoutMs,
              "connectionGuard.heartbeatTimeoutMs",
            ),
          };
  }

  get heartbeatIntervalMs(): number {
    return Math.max(1, Math.floor(this.#leaseDurationMs / 3));
  }

  async heartbeatIdentity(): Promise<SupervisorHeartbeatIdentity> {
    const sandbox = await this.#database
      .selectFrom("sandboxes")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (sandbox === undefined || sandbox.state === "terminated") {
      throw new SessionLeaseCoordinatorError(
        "sandbox_unavailable",
        "Heartbeat sandbox identity is unavailable",
        false,
      );
    }
    return {
      supervisorId: sandbox.supervisor_id,
      bootId: sandbox.boot_id,
      connectionId: this.#heartbeatConnectionId,
    };
  }

  async renewFromHeartbeat(value: unknown): Promise<SupervisorHeartbeatAckMessage> {
    const heartbeat = parseSupervisorToControlMessage(value);
    if (heartbeat.type !== "supervisor.heartbeat") {
      throw new SessionLeaseCoordinatorError(
        "invalid_heartbeat",
        "Lease renewal requires a supervisor heartbeat",
        false,
      );
    }
    if (heartbeat.payload.connectionId !== this.#heartbeatConnectionId) {
      throw new SessionLeaseCoordinatorError(
        "stale_connection",
        "Supervisor heartbeat connection is stale",
        false,
      );
    }
    const now = validDate(this.#clock);
    const validUntil = new Date(now.valueOf() + this.#leaseDurationMs);
    const leaseRenewals = await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["supervisor_id", "boot_id", "state", "max_concurrent_sessions", "active_sessions"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (
        sandbox === undefined ||
        sandbox.supervisor_id !== heartbeat.payload.supervisorId ||
        sandbox.boot_id !== heartbeat.payload.bootId ||
        sandbox.max_concurrent_sessions !== heartbeat.payload.maxConcurrentSessions ||
        (sandbox.state !== "ready" && sandbox.state !== "leased")
      ) {
        throw new SessionLeaseCoordinatorError(
          "stale_supervisor",
          "Supervisor heartbeat identity is stale",
          false,
        );
      }
      const connection = await this.#currentRegisteredConnection(
        transaction,
        {
          supervisorId: heartbeat.payload.supervisorId,
          bootId: heartbeat.payload.bootId,
        },
        now,
        false,
      );
      if (connection !== undefined) {
        await transaction
          .updateTable("supervisor_connections")
          .set({
            accepting_assignments: heartbeat.payload.acceptingAssignments,
            last_heartbeat_at: now,
            expires_at: new Date(now.valueOf() + this.#connectionGuard!.heartbeatTimeoutMs),
          })
          .where("connection_id", "=", this.#heartbeatConnectionId)
          .where("state", "=", "active")
          .executeTakeFirstOrThrow();
      }

      const renewals: SupervisorHeartbeatAckMessage["payload"]["leaseRenewals"] = [];
      for (const observation of heartbeat.payload.sessions) {
        if (observation.turnId === null || !ACTIVE_SESSION_STATES.has(observation.state)) {
          continue;
        }
        const assignment = await transaction
          .selectFrom("session_leases as lease")
          .innerJoin("sessions as session_row", "session_row.id", "lease.session_id")
          .innerJoin("turns as turn", (join) =>
            join
              .onRef("turn.session_id", "=", "session_row.id")
              .on("turn.id", "=", observation.turnId!),
          )
          .innerJoin("commands as command", (join) =>
            join
              .onRef("command.tenant_id", "=", "turn.tenant_id")
              .onRef("command.session_id", "=", "turn.session_id")
              .onRef("command.turn_id", "=", "turn.id")
              .on("command.kind", "=", "turn.execute"),
          )
          .innerJoin("runs as run", (join) =>
            join
              .onRef("run.tenant_id", "=", "command.tenant_id")
              .onRef("run.session_id", "=", "command.session_id")
              .onRef("run.turn_id", "=", "command.turn_id")
              .onRef("run.command_id", "=", "command.id"),
          )
          .innerJoin("run_attempts as run_attempt", (join) =>
            join
              .onRef("run_attempt.run_id", "=", "run.id")
              .onRef("run_attempt.id", "=", "run.current_attempt_id"),
          )
          .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
          .select([
            "lease.lease_id as leaseId",
            "lease.fencing_token as leaseFencingToken",
            "lease.valid_until as leaseValidUntil",
            "session_row.last_fencing_token as sessionFencingToken",
            "session_row.state as sessionState",
            "turn.state as turnState",
            "command.state as commandState",
            "run_attempt.id as runAttemptId",
            "run_attempt.state as runAttemptState",
            "run_attempt.lease_id as runAttemptLeaseId",
            "run_attempt.fencing_token as runAttemptFencingToken",
            "cursor.last_persisted_seq as persistedSequence",
          ])
          .where("lease.session_id", "=", observation.sessionId)
          .where("lease.sandbox_id", "=", this.#sandboxId)
          .forUpdate(["lease", "session_row", "turn", "command", "run", "run_attempt", "cursor"])
          .executeTakeFirst();
        if (assignment === undefined) continue;

        const leaseFence = safeInteger(
          assignment.leaseFencingToken,
          "heartbeat lease fencing token",
        );
        const sessionFence = safeInteger(
          assignment.sessionFencingToken,
          "heartbeat session fencing token",
        );
        const persistedSequence = safeInteger(
          assignment.persistedSequence,
          "heartbeat persisted sequence",
        );
        if (
          assignment.leaseId !== observation.leaseId ||
          leaseFence !== observation.fencingToken ||
          sessionFence !== observation.fencingToken ||
          new Date(assignment.leaseValidUntil).valueOf() <= now.valueOf() ||
          !ACTIVE_SESSION_STATES.has(assignment.sessionState) ||
          !ACTIVE_TURN_STATES.has(assignment.turnState) ||
          assignment.commandState !== "acknowledged" ||
          assignment.runAttemptLeaseId !== observation.leaseId ||
          safeInteger(assignment.runAttemptFencingToken ?? -1, "run attempt fencing token") !==
            observation.fencingToken ||
          assignment.runAttemptState === "completed" ||
          assignment.runAttemptState === "failed" ||
          assignment.runAttemptState === "cancelled" ||
          assignment.runAttemptState === "timed_out" ||
          assignment.runAttemptState === "superseded" ||
          observation.lastAcknowledgedSeq > persistedSequence ||
          persistedSequence > observation.lastProducedSeq
        ) {
          continue;
        }

        const updated = await transaction
          .updateTable("session_leases")
          .set({ valid_until: validUntil, renewed_at: now })
          .where("session_id", "=", observation.sessionId)
          .where("lease_id", "=", observation.leaseId)
          .where("fencing_token", "=", String(observation.fencingToken))
          .where("valid_until", ">", now)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) continue;
        const attemptHeartbeat = await transaction
          .updateTable("run_attempts")
          .set({
            claim_expires_at: validUntil,
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("id", "=", assignment.runAttemptId)
          .where("lease_id", "=", observation.leaseId)
          .where("fencing_token", "=", String(observation.fencingToken))
          .executeTakeFirst();
        expectOne(attemptHeartbeat.numUpdatedRows, "renewing a run attempt heartbeat");
        renewals.push({
          sessionId: observation.sessionId,
          leaseId: observation.leaseId,
          fencingToken: observation.fencingToken,
          validUntil: validUntil.toISOString(),
        });
      }
      await transaction
        .updateTable("sandboxes")
        .set({ updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("boot_id", "=", heartbeat.payload.bootId)
        .executeTakeFirstOrThrow();
      return renewals;
    });

    const acknowledgement = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: now.toISOString(),
      type: "supervisor.heartbeat.ack",
      payload: {
        acknowledgedMessageId: heartbeat.messageId,
        connectionId: this.#heartbeatConnectionId,
        leaseRenewals,
      },
    });
    if (acknowledgement.type !== "supervisor.heartbeat.ack") {
      throw new SessionLeaseCoordinatorError(
        "invalid_heartbeat_ack",
        "Lease renewal acknowledgement was invalid",
        false,
      );
    }
    return acknowledgement;
  }

  async quarantineSandbox(): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || sandbox.state === "failed" || sandbox.state === "terminated") {
        return;
      }
      await transaction
        .updateTable("sandboxes")
        .set({ state: transitionSandbox(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
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
      if (this.#connectionGuard !== undefined) {
        const guardedSandbox = await transaction
          .selectFrom("sandboxes")
          .select(["supervisor_id", "boot_id"])
          .where("id", "=", this.#sandboxId)
          .executeTakeFirst();
        if (guardedSandbox === undefined) {
          throw new SessionLeaseCoordinatorError(
            "sandbox_unavailable",
            "Execution sandbox is unavailable",
            true,
          );
        }
        await this.#currentRegisteredConnection(
          transaction,
          {
            supervisorId: guardedSandbox.supervisor_id,
            bootId: guardedSandbox.boot_id,
          },
          now,
          true,
        );
      }

      const runAttempt = await transaction
        .selectFrom("runs as run")
        .innerJoin("run_attempts as attempt", (join) =>
          join
            .onRef("attempt.run_id", "=", "run.id")
            .onRef("attempt.id", "=", "run.current_attempt_id"),
        )
        .select([
          "run.state as runState",
          "run.current_attempt_id as currentAttemptId",
          "attempt.state as attemptState",
          "attempt.sandbox_id as sandboxId",
          "attempt.lease_id as leaseId",
          "attempt.fencing_token as fencingToken",
        ])
        .where("run.tenant_id", "=", request.tenantId)
        .where("run.id", "=", request.runId)
        .where("run.session_id", "=", request.sessionId)
        .where("run.turn_id", "=", request.turnId)
        .where("run.command_id", "=", request.commandId)
        .where("attempt.id", "=", request.attemptId)
        .forUpdate(["run", "attempt"])
        .executeTakeFirst();
      if (
        runAttempt === undefined ||
        runAttempt.currentAttemptId !== request.attemptId ||
        runAttempt.runState !== "claimed" ||
        runAttempt.attemptState !== "claimed" ||
        runAttempt.sandboxId !== null ||
        runAttempt.leaseId !== null ||
        runAttempt.fencingToken !== null
      ) {
        throw new SessionLeaseCoordinatorError(
          "stale_attempt",
          "Run attempt is unavailable for execution",
          false,
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
        .select([
          "id",
          "supervisor_id",
          "boot_id",
          "state",
          "active_sessions",
          "max_concurrent_sessions",
        ])
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
      await this.#currentRegisteredConnection(
        transaction,
        { supervisorId: sandbox.supervisor_id, bootId: sandbox.boot_id },
        now,
        true,
      );

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

      const attemptUpdate = await transaction
        .updateTable("run_attempts")
        .set({
          sandbox_id: sandbox.id,
          lease_id: leaseId,
          fencing_token: fencingToken,
          claim_expires_at: validUntil,
          last_heartbeat_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", request.tenantId)
        .where("run_id", "=", request.runId)
        .where("id", "=", request.attemptId)
        .where("state", "=", "claimed")
        .where("sandbox_id", "is", null)
        .executeTakeFirst();
      expectOne(attemptUpdate.numUpdatedRows, "binding a run attempt lease");

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

  async assertCurrentOrExpired(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
    now: Date,
  ): Promise<void> {
    await this.#currentLease(transaction, request, acknowledgement, now, false);
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

  async currentAssignment(request: TurnExecutionRequest): Promise<TurnExecutionAcknowledgement> {
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
          "Session is unavailable for cancellation",
          false,
        );
      }
      if (session.state !== "running" && session.state !== "waiting_approval") {
        throw new SessionLeaseCoordinatorError(
          "invalid_state",
          "Session no longer has an active execution to cancel",
          false,
        );
      }

      const lease = await transaction
        .selectFrom("session_leases")
        .select(["lease_id", "sandbox_id", "fencing_token", "valid_until"])
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      const fencingToken =
        lease === undefined ? -1 : safeInteger(lease.fencing_token, "lease fencing token");
      if (
        lease === undefined ||
        lease.sandbox_id !== this.#sandboxId ||
        new Date(lease.valid_until).valueOf() <= now.valueOf() ||
        fencingToken !== safeInteger(session.last_fencing_token, "session fencing token")
      ) {
        throw new SessionLeaseCoordinatorError("stale_fence", "Execution lease is stale", false);
      }
      await this.#currentRunAttempt(transaction, request, {
        leaseId: lease.lease_id,
        fencingToken,
      });
      return { leaseId: lease.lease_id, fencingToken };
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
    await this.#currentRunAttempt(transaction, request, acknowledgement);
    return lease;
  }

  async #currentRunAttempt(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionAcknowledgement,
  ): Promise<void> {
    const attempt = await transaction
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .select([
        "run.current_attempt_id as currentAttemptId",
        "attempt.sandbox_id as sandboxId",
        "attempt.lease_id as leaseId",
        "attempt.fencing_token as fencingToken",
      ])
      .where("run.tenant_id", "=", request.tenantId)
      .where("run.id", "=", request.runId)
      .where("run.session_id", "=", request.sessionId)
      .where("run.turn_id", "=", request.turnId)
      .where("run.command_id", "=", request.commandId)
      .where("attempt.id", "=", request.attemptId)
      .forUpdate(["run", "attempt"])
      .executeTakeFirst();
    if (
      attempt === undefined ||
      attempt.currentAttemptId !== request.attemptId ||
      attempt.sandboxId !== this.#sandboxId ||
      attempt.leaseId !== acknowledgement.leaseId ||
      safeInteger(attempt.fencingToken ?? -1, "run attempt fencing token") !==
        acknowledgement.fencingToken
    ) {
      throw new SessionLeaseCoordinatorError("stale_attempt", "Run attempt is stale", false);
    }
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

  async #currentRegisteredConnection(
    transaction: Transaction<Database>,
    identity: { supervisorId: string; bootId: string },
    now: Date,
    requireAcceptingAssignments: boolean,
  ): Promise<{ acceptingAssignments: boolean } | undefined> {
    if (this.#connectionGuard === undefined) return undefined;
    const connection = await transaction
      .selectFrom("supervisor_connections")
      .select([
        "sandbox_id",
        "supervisor_id",
        "boot_id",
        "control_plane_instance_id",
        "transport_id",
        "state",
        "accepting_assignments",
        "expires_at",
      ])
      .where("connection_id", "=", this.#heartbeatConnectionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      connection === undefined ||
      connection.sandbox_id !== this.#sandboxId ||
      connection.supervisor_id !== identity.supervisorId ||
      connection.boot_id !== identity.bootId ||
      connection.control_plane_instance_id !== this.#connectionGuard.controlPlaneInstanceId ||
      connection.transport_id !== this.#connectionGuard.transportId ||
      connection.state !== "active" ||
      new Date(connection.expires_at).valueOf() <= now.valueOf()
    ) {
      throw new SessionLeaseCoordinatorError(
        "stale_connection",
        "Supervisor connection is stale",
        false,
      );
    }
    if (requireAcceptingAssignments && !connection.accepting_assignments) {
      throw new SessionLeaseCoordinatorError(
        "connection_not_accepting",
        "Supervisor connection is not accepting assignments",
        true,
      );
    }
    return { acceptingAssignments: connection.accepting_assignments };
  }
}
