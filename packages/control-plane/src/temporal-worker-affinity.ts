import type { Database } from "@agent-dock/database";
import {
  temporalWorkerAffinityTaskQueue,
  validateTemporalRunWorkflowInput,
  type TemporalRunWorkflowInput,
  type TemporalWorkerAffinity,
} from "@agent-dock/temporal-orchestration";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";

const DEFAULT_RESERVATION_TTL_MS = 5_000;

export type PostgresTemporalWorkerAffinityOptions = {
  database: Kysely<Database>;
  reservationTtlMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${String(maximum)}`,
    );
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("Affinity clock returned an invalid Date");
  }
  return value;
}

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Affinity reservation count was invalid");
  }
  return parsed;
}

/**
 * PostgreSQL-backed hints for Temporal Worker-specific Activity queues.
 *
 * Temporal remains the only task matcher. These rows only bound an optional
 * private-queue attempt and are never required to restore a Session.
 */
export class PostgresTemporalWorkerAffinity {
  readonly #database: Kysely<Database>;
  readonly #reservationTtlMs: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PostgresTemporalWorkerAffinityOptions) {
    this.#database = options.database;
    this.#reservationTtlMs = positiveInteger(
      options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
      "reservationTtlMs",
      60_000,
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async reserve(rawInput: TemporalRunWorkflowInput): Promise<TemporalWorkerAffinity | undefined> {
    const input = validateTemporalRunWorkflowInput(rawInput);
    const now = validDate(this.#clock());
    return this.#database.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom("temporal_worker_affinity_reservations")
        .where("expires_at", "<=", now)
        .execute();

      const existing = await transaction
        .selectFrom("temporal_worker_affinity_reservations")
        .select([
          "id",
          "sandbox_id as sandboxId",
          "task_queue as taskQueue",
          "expires_at as expiresAt",
        ])
        .where("command_id", "=", input.commandId)
        .where("tenant_id", "=", input.tenantId)
        .where("session_id", "=", input.sessionId)
        .executeTakeFirst();
      if (existing !== undefined && existing.expiresAt.valueOf() > now.valueOf()) {
        return {
          reservationId: existing.id,
          sandboxId: existing.sandboxId,
          taskQueue: existing.taskQueue,
        };
      }

      const session = await transaction
        .selectFrom("sessions")
        .select([
          "worker_affinity_sandbox_id as sandboxId",
          "worker_affinity_expires_at as expiresAt",
        ])
        .where("id", "=", input.sessionId)
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirst();
      if (
        session?.sandboxId === null ||
        session?.sandboxId === undefined ||
        session.expiresAt === null ||
        session.expiresAt.valueOf() <= now.valueOf()
      ) {
        return undefined;
      }

      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select([
          "id",
          "supervisor_id as supervisorId",
          "boot_id as bootId",
          "state",
          "active_sessions as activeSessions",
          "max_concurrent_sessions as maximumSessions",
        ])
        .where("id", "=", session.sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (
        sandbox === undefined ||
        (sandbox.state !== "ready" && sandbox.state !== "leased") ||
        sandbox.activeSessions >= sandbox.maximumSessions
      ) {
        return undefined;
      }

      const connection = await transaction
        .selectFrom("supervisor_connections")
        .select("connection_id")
        .where("sandbox_id", "=", sandbox.id)
        .where("supervisor_id", "=", sandbox.supervisorId)
        .where("boot_id", "=", sandbox.bootId)
        .where("state", "=", "active")
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (connection === undefined) return undefined;

      const reservationCount = await this.#activeReservationCount(transaction, sandbox.id, now);
      if (sandbox.activeSessions + reservationCount >= sandbox.maximumSessions) return undefined;

      const reservationId = uuid(this.#idGenerator(), "reservationId");
      const taskQueue = temporalWorkerAffinityTaskQueue(sandbox.id);
      await transaction
        .insertInto("temporal_worker_affinity_reservations")
        .values({
          id: reservationId,
          tenant_id: input.tenantId,
          session_id: input.sessionId,
          command_id: input.commandId,
          sandbox_id: sandbox.id,
          task_queue: taskQueue,
          expires_at: new Date(now.valueOf() + this.#reservationTtlMs),
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      return { reservationId, sandboxId: sandbox.id, taskQueue };
    });
  }

  async claim(
    rawInput: TemporalRunWorkflowInput,
    workerSandboxId: string,
  ): Promise<"claimed" | "stale" | "wrong_worker"> {
    const input = validateTemporalRunWorkflowInput(rawInput);
    const affinity = input.affinity;
    if (affinity === undefined) return "stale";
    const sandboxId = uuid(workerSandboxId, "workerSandboxId");
    if (affinity.sandboxId !== sandboxId) return "wrong_worker";
    const now = validDate(this.#clock());
    const claimed = await this.#database
      .deleteFrom("temporal_worker_affinity_reservations")
      .where("id", "=", affinity.reservationId)
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .where("command_id", "=", input.commandId)
      .where("sandbox_id", "=", sandboxId)
      .where("task_queue", "=", affinity.taskQueue)
      .where("expires_at", ">", now)
      .returning("id")
      .executeTakeFirst();
    return claimed === undefined ? "stale" : "claimed";
  }

  async release(reservationId: string): Promise<void> {
    await this.#database
      .deleteFrom("temporal_worker_affinity_reservations")
      .where("id", "=", uuid(reservationId, "reservationId"))
      .execute();
  }

  async remember(
    rawInput: TemporalRunWorkflowInput,
    workerSandboxId: string,
    ttlMs: number,
  ): Promise<void> {
    const input = validateTemporalRunWorkflowInput(rawInput);
    const sandboxId = uuid(workerSandboxId, "workerSandboxId");
    const duration = positiveInteger(ttlMs, "ttlMs", 60 * 60_000);
    const now = validDate(this.#clock());
    await this.#database
      .updateTable("sessions")
      .set({
        worker_affinity_sandbox_id: sandboxId,
        worker_affinity_expires_at: new Date(now.valueOf() + duration),
      })
      .where("id", "=", input.sessionId)
      .where("tenant_id", "=", input.tenantId)
      .executeTakeFirst();
  }

  async #activeReservationCount(
    transaction: Transaction<Database>,
    sandboxId: string,
    now: Date,
  ): Promise<number> {
    const row = await transaction
      .selectFrom("temporal_worker_affinity_reservations")
      .select(sql<string>`count(*)`.as("reservationCount"))
      .where("sandbox_id", "=", sandboxId)
      .where("expires_at", ">", now)
      .executeTakeFirstOrThrow();
    return count(row.reservationCount);
  }
}
