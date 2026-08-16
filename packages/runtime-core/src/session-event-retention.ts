import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import type { LiveSessionEventStore } from "./live-session-event-store.ts";

const DEFAULT_CLAIM_MS = 5 * 60 * 1_000;

export type SessionLiveStreamCompactionResult =
  | { status: "idle" }
  | {
      status: "compacted";
      tenantId: string;
      sessionId: string;
      turnId: string;
      throughSequence: number;
    };

export type SessionLiveStreamCompactionOptions = {
  database: Kysely<Database>;
  liveEvents: LiveSessionEventStore;
  ownerId?: string;
  clock?: () => Date;
  claimMs?: number;
};

export class SessionLiveStreamCompactionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "SessionLiveStreamCompactionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Live stream compaction clock must return a valid Date");
  }
  return value;
}

function positiveInteger(value: number | string | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SessionLiveStreamCompactionError(
      "live_stream_compaction_invariant",
      `${description} is outside the positive safe integer range`,
      false,
    );
  }
  return parsed;
}

export class SessionLiveStreamCompactionService {
  readonly #database: Kysely<Database>;
  readonly #liveEvents: LiveSessionEventStore;
  readonly #ownerId: string;
  readonly #clock: () => Date;
  readonly #claimMs: number;

  constructor(options: SessionLiveStreamCompactionOptions) {
    this.#database = options.database;
    this.#liveEvents = options.liveEvents;
    this.#ownerId = options.ownerId ?? `live-stream-compactor-${randomUUID()}`;
    if (this.#ownerId.length < 1 || this.#ownerId.length > 256) {
      throw new TypeError("Live stream compaction owner ID is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#claimMs = options.claimMs ?? DEFAULT_CLAIM_MS;
    if (!Number.isSafeInteger(this.#claimMs) || this.#claimMs < 1_000) {
      throw new TypeError("Live stream compaction claim duration is invalid");
    }
  }

  async runOnce(): Promise<SessionLiveStreamCompactionResult> {
    const now = safeDate(this.#clock);
    const claimUntil = new Date(now.valueOf() + this.#claimMs);
    const job = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_live_stream_compactions")
        .select(["id", "tenant_id", "session_id", "turn_id", "through_seq", "attempts"])
        .where("state", "=", "pending")
        .where("available_at", "<=", now)
        .where((expression) =>
          expression.or([
            expression("claim_until", "is", null),
            expression("claim_until", "<=", now),
          ]),
        )
        .orderBy("available_at", "asc")
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      await transaction
        .updateTable("session_live_stream_compactions")
        .set({
          attempts: row.attempts + 1,
          claim_owner: this.#ownerId,
          claim_until: claimUntil,
          last_error: null,
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        throughSequence: positiveInteger(row.through_seq, "Compaction sequence"),
      };
    });
    if (job === undefined) return { status: "idle" };

    try {
      await this.#liveEvents.trimThrough(job.tenantId, job.sessionId, job.throughSequence);
      const completedAt = safeDate(this.#clock);
      await this.#database.transaction().execute(async (transaction) => {
        const updated = await transaction
          .updateTable("session_live_stream_compactions")
          .set({
            state: "completed",
            claim_owner: null,
            claim_until: null,
            last_error: null,
            completed_at: completedAt,
          })
          .where("id", "=", job.id)
          .where("state", "=", "pending")
          .where("claim_owner", "=", this.#ownerId)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new SessionLiveStreamCompactionError(
            "live_stream_compaction_stale_claim",
            "Live stream compaction claim became stale",
            true,
          );
        }
        // The canonical transcript and terminal event have already committed.
        // Advancing this floor makes old Last-Event-ID values fail explicitly
        // instead of returning a misleading partial Turn.
        await transaction
          .updateTable("session_event_cursors")
          .set({ replay_floor_seq: job.throughSequence, updated_at: completedAt })
          .where("session_id", "=", job.sessionId)
          .where("replay_floor_seq", "<", String(job.throughSequence))
          .execute();
      });
      return { status: "compacted", ...job };
    } catch (error: unknown) {
      await this.#database
        .updateTable("session_live_stream_compactions")
        .set({
          claim_owner: null,
          claim_until: null,
          available_at: new Date(safeDate(this.#clock).valueOf() + 5_000),
          last_error: error instanceof Error ? error.message.slice(0, 1_000) : "compaction failed",
        })
        .where("id", "=", job.id)
        .where("state", "=", "pending")
        .where("claim_owner", "=", this.#ownerId)
        .execute();
      throw error;
    }
  }
}
