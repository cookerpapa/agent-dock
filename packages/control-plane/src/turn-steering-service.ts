import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import type { CreateTurnSteerRequest, TurnSteerResource } from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";
import {
  TurnSteerBackendError,
  type TurnSteerBackend,
  type TurnSteerRequest,
} from "./turn-steer.ts";

export type TurnSteeringErrorCode =
  "not_found" | "conflict" | "idempotency_conflict" | "steer_transport_unavailable";

export class TurnSteeringError extends Error {
  readonly code: TurnSteeringErrorCode;

  constructor(code: TurnSteeringErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "TurnSteeringError";
    this.code = code;
  }
}

type StoredSteer = {
  commandId: string;
  targetCommandId: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  idempotencyKey: string;
  text: string;
  requestHash: string;
  state: "pending" | "dispatched" | "acknowledged" | "completed" | "failed";
  sandboxId: string;
  acceptedAt: Date | string;
  completedAt: Date | string | null;
};

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TurnSteeringError("steer_transport_unavailable", "Stored steer timestamp is invalid");
  }
  return parsed.toISOString();
}

function fingerprint(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, kind: "turn.steer", text }))
    .digest("hex");
}

function payloadString(payload: Record<string, unknown>, property: string): string {
  const value = payload[property];
  if (typeof value !== "string" || value.length === 0) {
    throw new TurnSteeringError("steer_transport_unavailable", "Stored steer command is invalid");
  }
  return value;
}

function resource(row: StoredSteer, replayed: boolean): TurnSteerResource {
  if (row.completedAt === null || row.state !== "completed") {
    throw new TurnSteeringError(
      "steer_transport_unavailable",
      "Steer delivery did not reach a terminal state",
    );
  }
  return {
    commandId: row.commandId,
    targetCommandId: row.targetCommandId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    state: "delivered",
    acceptedAt: isoTimestamp(row.acceptedAt),
    deliveredAt: isoTimestamp(row.completedAt),
    replayed,
  };
}

export class TurnSteeringService {
  readonly #database: Kysely<Database>;
  readonly #gateway: SupervisorWebSocketGateway | undefined;
  readonly #backendFactory: ((sandboxId: string) => Promise<TurnSteerBackend>) | undefined;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;
  readonly #inflight = new Map<string, Promise<TurnSteerResource>>();

  constructor(options: {
    database: Kysely<Database>;
    gateway?: SupervisorWebSocketGateway;
    backendFactory?: (sandboxId: string) => Promise<TurnSteerBackend>;
    idGenerator?: () => string;
    clock?: () => Date;
  }) {
    this.#database = options.database;
    this.#gateway = options.gateway;
    this.#backendFactory = options.backendFactory;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async deliver(
    identity: TenantRequestIdentity,
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    request: CreateTurnSteerRequest,
  ): Promise<TurnSteerResource> {
    const text = request.text.trim();
    const requestHash = fingerprint(text);
    let stored = await this.#load(identity.tenantId, sessionId, idempotencyKey);
    const replayed = stored !== undefined;
    if (stored !== undefined) {
      if (stored.turnId !== turnId || stored.requestHash !== requestHash) {
        throw new TurnSteeringError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different steer request",
        );
      }
      if (stored.state === "completed") return resource(stored, true);
      if (stored.state === "failed") {
        throw new TurnSteeringError(
          "conflict",
          "The previous steer delivery failed; use a new Idempotency-Key while the Run is active",
        );
      }
    } else {
      stored = await this.#create(
        identity.tenantId,
        sessionId,
        turnId,
        idempotencyKey,
        text,
        requestHash,
      );
    }

    const inflight = this.#inflight.get(stored.commandId);
    if (inflight !== undefined) {
      return { ...(await inflight), replayed: true };
    }
    const delivery = this.#deliverStored(stored, replayed);
    this.#inflight.set(stored.commandId, delivery);
    try {
      return await delivery;
    } finally {
      if (this.#inflight.get(stored.commandId) === delivery) {
        this.#inflight.delete(stored.commandId);
      }
    }
  }

  async #deliverStored(stored: StoredSteer, replayed: boolean): Promise<TurnSteerResource> {
    if (this.#backendFactory === undefined && this.#gateway === undefined) {
      throw new TurnSteeringError(
        "steer_transport_unavailable",
        "Active Pi steer transport is unavailable",
      );
    }
    await this.#markDispatched(stored);
    const backend =
      this.#backendFactory === undefined
        ? this.#gateway!.createRemoteSteerBackend(stored.sandboxId)
        : await this.#backendFactory(stored.sandboxId);
    const delivery: TurnSteerRequest = {
      commandId: stored.commandId,
      idempotencyKey: stored.idempotencyKey,
      text: stored.text,
      target: {
        commandId: stored.targetCommandId,
        tenantId: stored.tenantId,
        projectId: stored.projectId,
        workspaceId: stored.workspaceId,
        sessionId: stored.sessionId,
        runId: stored.runId,
        turnId: stored.turnId,
        attemptId: stored.attemptId,
      },
    };
    try {
      await backend.steer(delivery);
    } catch (error: unknown) {
      if (error instanceof TurnSteerBackendError && error.ambiguous) {
        throw new TurnSteeringError(
          "steer_transport_unavailable",
          "Steer delivery outcome is temporarily unknown; retry with the same Idempotency-Key",
        );
      }
      const code =
        error instanceof TurnSteerBackendError &&
        ["invalid_state", "stale_fence", "stale_attempt", "steer_target_unavailable"].includes(
          error.code,
        )
          ? "conflict"
          : "steer_transport_unavailable";
      await this.#markFailed(stored.commandId, error).catch(() => undefined);
      throw new TurnSteeringError(
        code,
        code === "conflict"
          ? "The active Pi Run ended before the steer could be delivered"
          : "Steer delivery is temporarily unavailable",
      );
    }
    const deliveredAt = this.#clock();
    await this.#database
      .updateTable("commands")
      .set({
        state: "completed",
        acknowledged_at: deliveredAt,
        completed_at: deliveredAt,
        failure_code: null,
      })
      .where("tenant_id", "=", stored.tenantId)
      .where("id", "=", stored.commandId)
      .where("state", "in", ["pending", "dispatched", "acknowledged"])
      .executeTakeFirstOrThrow();
    return resource({ ...stored, state: "completed", completedAt: deliveredAt }, replayed);
  }

  async #create(
    tenantId: string,
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    text: string,
    requestHash: string,
  ): Promise<StoredSteer> {
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const target = await this.#activeTarget(transaction, tenantId, sessionId, turnId);
        const commandId = this.#idGenerator();
        const inserted = await transaction
          .insertInto("commands")
          .values({
            id: commandId,
            tenant_id: tenantId,
            session_id: sessionId,
            turn_id: turnId,
            idempotency_key: idempotencyKey,
            kind: "turn.steer",
            state: "pending",
            mailbox_position: null,
            payload: {
              schemaVersion: 1,
              requestHash,
              targetCommandId: target.targetCommandId,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              runId: target.runId,
              attemptId: target.attemptId,
              sandboxId: target.sandboxId,
              text,
            },
            dispatched_at: null,
            acknowledged_at: null,
            completed_at: null,
            failure_code: null,
          })
          .returning("created_at")
          .executeTakeFirstOrThrow();
        return {
          commandId,
          targetCommandId: target.targetCommandId,
          tenantId,
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          sessionId,
          runId: target.runId,
          turnId,
          attemptId: target.attemptId,
          idempotencyKey,
          text,
          requestHash,
          state: "pending",
          sandboxId: target.sandboxId,
          acceptedAt: inserted.created_at,
          completedAt: null,
        };
      });
    } catch (error: unknown) {
      const concurrent = await this.#load(tenantId, sessionId, idempotencyKey);
      if (concurrent !== undefined) {
        if (concurrent.turnId !== turnId || concurrent.requestHash !== requestHash) {
          throw new TurnSteeringError(
            "idempotency_conflict",
            "Idempotency-Key was already used for a different command",
          );
        }
        return concurrent;
      }
      throw error;
    }
  }

  async #activeTarget(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
    turnId: string,
  ): Promise<{
    targetCommandId: string;
    projectId: string;
    workspaceId: string;
    runId: string;
    attemptId: string;
    sandboxId: string;
  }> {
    const row = await transaction
      .selectFrom("turns as turn")
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "turn.tenant_id")
          .onRef("session_row.id", "=", "turn.session_id"),
      )
      .innerJoin("commands as target", (join) =>
        join
          .onRef("target.tenant_id", "=", "turn.tenant_id")
          .onRef("target.session_id", "=", "turn.session_id")
          .onRef("target.turn_id", "=", "turn.id")
          .on("target.kind", "=", "turn.execute"),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "turn.tenant_id")
          .onRef("run.session_id", "=", "turn.session_id")
          .onRef("run.turn_id", "=", "turn.id")
          .onRef("run.command_id", "=", "target.id"),
      )
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .innerJoin("session_leases as lease", "lease.session_id", "session_row.id")
      .select([
        "turn.state as turnState",
        "session_row.state as sessionState",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "target.id as targetCommandId",
        "target.state as targetCommandState",
        "run.id as runId",
        "run.state as runState",
        "attempt.id as attemptId",
        "attempt.state as attemptState",
        "attempt.sandbox_id as attemptSandboxId",
        "lease.sandbox_id as leaseSandboxId",
      ])
      .where("turn.tenant_id", "=", tenantId)
      .where("turn.session_id", "=", sessionId)
      .where("turn.id", "=", turnId)
      .forUpdate(["turn", "session_row", "target", "run", "attempt", "lease"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new TurnSteeringError("not_found", "Active Turn was not found");
    }
    if (
      row.turnState !== "running" ||
      row.sessionState !== "running" ||
      row.targetCommandState !== "acknowledged" ||
      !["claimed", "provisioning", "restoring", "running"].includes(row.runState) ||
      !["claimed", "provisioning", "restoring", "running"].includes(row.attemptState) ||
      row.attemptSandboxId === null ||
      row.attemptSandboxId !== row.leaseSandboxId
    ) {
      throw new TurnSteeringError(
        "conflict",
        "Only one currently running Pi Run can accept a steer",
      );
    }
    return {
      targetCommandId: row.targetCommandId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      runId: row.runId,
      attemptId: row.attemptId,
      sandboxId: row.leaseSandboxId,
    };
  }

  async #load(
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<StoredSteer | undefined> {
    const command = await this.#database
      .selectFrom("commands")
      .select([
        "id",
        "turn_id",
        "idempotency_key",
        "kind",
        "state",
        "payload",
        "created_at",
        "completed_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (command === undefined) return undefined;
    if (command.kind !== "turn.steer") {
      throw new TurnSteeringError(
        "idempotency_conflict",
        "Idempotency-Key was already used for a different command",
      );
    }
    const targetCommandId = payloadString(command.payload, "targetCommandId");
    const text = payloadString(command.payload, "text");
    const requestHash = payloadString(command.payload, "requestHash");
    return {
      commandId: command.id,
      targetCommandId,
      tenantId,
      projectId: payloadString(command.payload, "projectId"),
      workspaceId: payloadString(command.payload, "workspaceId"),
      sessionId,
      runId: payloadString(command.payload, "runId"),
      turnId: command.turn_id,
      attemptId: payloadString(command.payload, "attemptId"),
      idempotencyKey: command.idempotency_key,
      text,
      requestHash,
      state: command.state,
      sandboxId: payloadString(command.payload, "sandboxId"),
      acceptedAt: command.created_at,
      completedAt: command.completed_at,
    };
  }

  async #markDispatched(stored: StoredSteer): Promise<void> {
    if (stored.state !== "pending") return;
    await this.#database
      .updateTable("commands")
      .set({ state: "dispatched", dispatched_at: this.#clock() })
      .where("tenant_id", "=", stored.tenantId)
      .where("id", "=", stored.commandId)
      .where("state", "=", "pending")
      .executeTakeFirstOrThrow();
    stored.state = "dispatched";
  }

  async #markFailed(storedCommandId: string, error: unknown): Promise<void> {
    const failureCode =
      error instanceof TurnSteerBackendError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
        ? error.code
        : "steer_delivery_failed";
    await this.#database
      .updateTable("commands")
      .set({
        state: "failed",
        completed_at: this.#clock(),
        failure_code: failureCode,
      })
      .where("id", "=", storedCommandId)
      .where("state", "in", ["pending", "dispatched", "acknowledged"])
      .executeTakeFirstOrThrow();
  }
}
