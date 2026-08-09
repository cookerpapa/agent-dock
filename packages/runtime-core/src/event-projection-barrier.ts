import type { Database } from "@agent-dock/database";
import type { Kysely } from "kysely";

export interface EventProjectionBarrier {
  waitForSession(tenantId: string, sessionId: string): Promise<void>;
}

export type PostgresEventProjectionBarrierOptions = Readonly<{
  database: Kysely<Database>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  clock?: () => Date;
}>;

function bounded(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export class PostgresEventProjectionBarrier implements EventProjectionBarrier {
  readonly #database: Kysely<Database>;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #clock: () => Date;

  constructor(options: PostgresEventProjectionBarrierOptions) {
    this.#database = options.database;
    this.#timeoutMs = bounded(options.timeoutMs ?? 60_000, "timeoutMs", 600_000);
    this.#pollIntervalMs = bounded(options.pollIntervalMs ?? 25, "pollIntervalMs", 5_000);
    this.#clock = options.clock ?? (() => new Date());
  }

  async waitForSession(tenantId: string, sessionId: string): Promise<void> {
    const startedAt = this.#clock().valueOf();
    while (true) {
      const cursor = await this.#database
        .selectFrom("sessions as session_row")
        .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
        .select(["cursor.last_persisted_seq", "cursor.last_projected_seq"])
        .where("session_row.tenant_id", "=", tenantId)
        .where("session_row.id", "=", sessionId)
        .executeTakeFirst();
      if (cursor === undefined) throw new Error("Session event projection cursor is missing");
      if (cursor.last_projected_seq === cursor.last_persisted_seq) return;
      if (this.#clock().valueOf() - startedAt >= this.#timeoutMs) {
        throw new Error("Session event projection did not catch up before its terminal boundary");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }
}
