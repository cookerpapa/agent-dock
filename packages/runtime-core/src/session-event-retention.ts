import type { Database } from "@agent-dock/database";
import type { CheckpointObjectStore } from "./checkpoint-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants as zlibConstants, gunzipSync, gzip } from "node:zlib";
import { sql, type Kysely, type Transaction } from "kysely";

export const SESSION_EVENT_ARCHIVE_FORMAT = "agent-dock.session-events.ndjson.gzip.v1";
export const DEFAULT_SESSION_EVENT_HOT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_SESSION_EVENT_RETENTION_CLAIM_MS = 15 * 60 * 1_000;
export const DEFAULT_SESSION_EVENT_ARCHIVE_MAX_BYTES = 128 * 1_024 * 1_024;

const gzipAsync = promisify(gzip);

type ArchiveJob = {
  id: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  claimOwner: string;
  claimUntil: Date;
};

type ArchiveEventRow = {
  event_id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  agent_node_id: string | null;
  agent_id: string;
  command_id: string | null;
  seq: string;
  schema_version: number;
  type: string;
  payload: Record<string, unknown>;
  lease_id: string;
  fencing_token: string;
  occurred_at: Date;
  persisted_at: Date;
};

export type SessionEventRetentionResult =
  | { status: "idle" }
  | {
      status: "archived";
      tenantId: string;
      sessionId: string;
      turnId: string;
      firstSequence: number;
      lastSequence: number;
      eventCount: number;
      compressedBytes: number;
      uncompressedBytes: number;
    };

export type SessionEventRetentionOptions = {
  database: Kysely<Database>;
  objectStore: CheckpointObjectStore;
  ownerId?: string;
  clock?: () => Date;
  idGenerator?: () => string;
  hotRetentionMs?: number;
  claimMs?: number;
  maximumArchiveBytes?: number;
};

export class SessionEventRetentionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "SessionEventRetentionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function boundedInteger(value: number | undefined, fallback: number, description: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
  return resolved;
}

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SessionEventRetentionError(
      "event_archive_invariant",
      `${description} is outside the positive safe integer range`,
      false,
    );
  }
  return parsed;
}

function safeNonNegativeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionEventRetentionError(
      "event_archive_invariant",
      `${description} is outside the non-negative safe integer range`,
      false,
    );
  }
  return parsed;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Session event retention clock must return a valid Date");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function iso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new SessionEventRetentionError(
      "event_archive_invariant",
      "Session event archive contains an invalid timestamp",
      false,
    );
  }
  return value.toISOString();
}

function eventArchiveBytes(job: ArchiveJob, rows: readonly ArchiveEventRow[]): Uint8Array {
  const header = {
    format: SESSION_EVENT_ARCHIVE_FORMAT,
    tenantId: job.tenantId,
    sessionId: job.sessionId,
    turnId: job.turnId,
    firstSequence: job.firstSequence,
    lastSequence: job.lastSequence,
    eventCount: job.eventCount,
  };
  const lines = [JSON.stringify(header)];
  let expectedSequence = job.firstSequence;
  for (const row of rows) {
    const sequence = safeSequence(row.seq, "Archived event sequence");
    if (
      row.tenant_id !== job.tenantId ||
      row.session_id !== job.sessionId ||
      row.turn_id !== job.turnId ||
      sequence !== expectedSequence
    ) {
      throw new SessionEventRetentionError(
        "event_archive_invariant",
        "Session event archive source is not one contiguous Turn",
        false,
      );
    }
    lines.push(
      JSON.stringify({
        eventId: row.event_id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        agentNodeId: row.agent_node_id,
        agentId: row.agent_id,
        commandId: row.command_id,
        sequence,
        schemaVersion: row.schema_version,
        type: row.type,
        payload: row.payload,
        leaseId: row.lease_id,
        fencingToken: safeSequence(row.fencing_token, "Archived event fencing token"),
        occurredAt: iso(row.occurred_at),
        persistedAt: iso(row.persisted_at),
      }),
    );
    expectedSequence += 1;
  }
  if (rows.length !== job.eventCount || expectedSequence - 1 !== job.lastSequence) {
    throw new SessionEventRetentionError(
      "event_archive_invariant",
      "Session event archive source count changed",
      true,
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function verifySessionEventArchive(
  compressed: Uint8Array,
  expected: {
    sha256: string;
    uncompressedSha256: string;
    sizeBytes: number;
    uncompressedSizeBytes: number;
  },
): { firstSequence: number; lastSequence: number; eventCount: number } {
  if (compressed.byteLength !== expected.sizeBytes || sha256(compressed) !== expected.sha256) {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive object failed integrity validation",
      false,
    );
  }
  let raw: Uint8Array;
  try {
    raw = gunzipSync(compressed);
  } catch {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive object could not be decompressed",
      false,
    );
  }
  if (
    raw.byteLength !== expected.uncompressedSizeBytes ||
    sha256(raw) !== expected.uncompressedSha256
  ) {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive payload failed integrity validation",
      false,
    );
  }
  const newlineIndex = raw.indexOf(0x0a);
  if (newlineIndex < 1) {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive header is missing",
      false,
    );
  }
  const firstLine = Buffer.from(raw.buffer, raw.byteOffset, newlineIndex).toString("utf8");
  let header: unknown;
  try {
    header = JSON.parse(firstLine ?? "") as unknown;
  } catch {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive header is malformed",
      false,
    );
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive header is invalid",
      false,
    );
  }
  const value = header as Record<string, unknown>;
  if (
    value.format !== SESSION_EVENT_ARCHIVE_FORMAT ||
    !Number.isSafeInteger(value.firstSequence) ||
    !Number.isSafeInteger(value.lastSequence) ||
    !Number.isSafeInteger(value.eventCount)
  ) {
    throw new SessionEventRetentionError(
      "event_archive_corrupt",
      "Session event archive header is invalid",
      false,
    );
  }
  return {
    firstSequence: Number(value.firstSequence),
    lastSequence: Number(value.lastSequence),
    eventCount: Number(value.eventCount),
  };
}

export class SessionEventRetentionService {
  readonly #database: Kysely<Database>;
  readonly #objectStore: CheckpointObjectStore;
  readonly #ownerId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #hotRetentionMs: number;
  readonly #claimMs: number;
  readonly #maximumArchiveBytes: number;

  constructor(options: SessionEventRetentionOptions) {
    this.#database = options.database;
    this.#objectStore = options.objectStore;
    this.#ownerId = options.ownerId ?? `event-retention-${randomUUID()}`;
    if (this.#ownerId.length < 1 || this.#ownerId.length > 256) {
      throw new TypeError("Session event retention owner ID is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#hotRetentionMs = boundedInteger(
      options.hotRetentionMs,
      DEFAULT_SESSION_EVENT_HOT_RETENTION_MS,
      "hotRetentionMs",
    );
    this.#claimMs = boundedInteger(
      options.claimMs,
      DEFAULT_SESSION_EVENT_RETENTION_CLAIM_MS,
      "claimMs",
    );
    this.#maximumArchiveBytes = boundedInteger(
      options.maximumArchiveBytes,
      DEFAULT_SESSION_EVENT_ARCHIVE_MAX_BYTES,
      "maximumArchiveBytes",
    );
  }

  async runOnce(): Promise<SessionEventRetentionResult> {
    const now = validDate(this.#clock);
    const cutoff = new Date(now.valueOf() - this.#hotRetentionMs);
    const job = await this.#database
      .transaction()
      .execute((transaction) => this.#claim(transaction, now, cutoff));
    if (job === undefined) return { status: "idle" };

    try {
      const rows = await this.#loadRows(job);
      const raw = eventArchiveBytes(job, rows);
      if (raw.byteLength > this.#maximumArchiveBytes) {
        throw new SessionEventRetentionError(
          "event_archive_too_large",
          "One terminal Turn exceeds the configured event archive object limit",
          false,
        );
      }
      const compressed = await gzipAsync(raw, { level: zlibConstants.Z_BEST_SPEED });
      const rawDigest = sha256(raw);
      const compressedDigest = sha256(compressed);
      const objectKey = [
        "session-event-archives",
        job.tenantId,
        job.sessionId,
        `${String(job.firstSequence)}-${String(job.lastSequence)}-${compressedDigest}.ndjson.gz`,
      ].join("/");
      await this.#putContentAddressed(objectKey, compressed);
      await this.#finalize(job, validDate(this.#clock), {
        objectKey,
        sha256: compressedDigest,
        uncompressedSha256: rawDigest,
        sizeBytes: compressed.byteLength,
        uncompressedSizeBytes: raw.byteLength,
      });
      return {
        status: "archived",
        tenantId: job.tenantId,
        sessionId: job.sessionId,
        turnId: job.turnId,
        firstSequence: job.firstSequence,
        lastSequence: job.lastSequence,
        eventCount: job.eventCount,
        compressedBytes: compressed.byteLength,
        uncompressedBytes: raw.byteLength,
      };
    } catch (error: unknown) {
      await this.#releaseClaim(job).catch(() => undefined);
      throw error;
    }
  }

  async #releaseClaim(job: ArchiveJob): Promise<void> {
    await this.#database
      .updateTable("session_event_archives")
      .set({ claim_until: validDate(this.#clock) })
      .where("id", "=", job.id)
      .where("state", "=", "uploading")
      .where("claim_owner", "=", job.claimOwner)
      .executeTakeFirst();
  }

  async #claim(
    transaction: Transaction<Database>,
    now: Date,
    cutoff: Date,
  ): Promise<ArchiveJob | undefined> {
    const claimUntil = new Date(now.valueOf() + this.#claimMs);
    const stale = await transaction
      .selectFrom("session_event_archives")
      .select(["id", "tenant_id", "session_id", "turn_id", "first_seq", "last_seq", "event_count"])
      .where("state", "=", "uploading")
      .where("claim_until", "<=", now)
      .orderBy("created_at", "asc")
      .forUpdate()
      .skipLocked()
      .limit(1)
      .executeTakeFirst();
    if (stale !== undefined) {
      await transaction
        .updateTable("session_event_archives")
        .set({ claim_owner: this.#ownerId, claim_until: claimUntil })
        .where("id", "=", stale.id)
        .executeTakeFirstOrThrow();
      return this.#job(stale, claimUntil);
    }

    const candidate = await sql<{
      tenant_id: string;
      session_id: string;
      replay_floor_seq: string;
      turn_id: string;
      through_seq: string;
    }>`
      select session_row.tenant_id,
             cursor.session_id,
             cursor.replay_floor_seq,
             event_row.turn_id,
             projection.through_seq
        from session_event_cursors as cursor
        join sessions as session_row on session_row.id = cursor.session_id
        join session_events as event_row
          on event_row.session_id = cursor.session_id
         and event_row.seq = cursor.replay_floor_seq + 1
        join turns as turn_row
          on turn_row.tenant_id = event_row.tenant_id
         and turn_row.session_id = event_row.session_id
         and turn_row.id = event_row.turn_id
        join conversation_turn_projections as projection
          on projection.tenant_id = turn_row.tenant_id
         and projection.session_id = turn_row.session_id
         and projection.turn_id = turn_row.id
       where turn_row.state in ('completed', 'failed', 'cancelled')
         and turn_row.settled_at < ${cutoff}
       order by turn_row.settled_at asc
       for update of cursor skip locked
       limit 1
    `.execute(transaction);
    const first = candidate.rows[0];
    if (first === undefined) return undefined;
    const firstSequence = safeNonNegativeSequence(first.replay_floor_seq, "Replay floor") + 1;
    const aggregate = await transaction
      .selectFrom("session_events")
      .select((expression) => [
        expression.fn.min<string>("seq").as("first_seq"),
        expression.fn.max<string>("seq").as("last_seq"),
        expression.fn.countAll<string>().as("event_count"),
        expression.fn.max<Date>("persisted_at").as("latest_persisted_at"),
      ])
      .where("tenant_id", "=", first.tenant_id)
      .where("session_id", "=", first.session_id)
      .where("turn_id", "=", first.turn_id)
      .executeTakeFirstOrThrow();
    const lastSequence = safeSequence(aggregate.last_seq, "Archive last sequence");
    const eventCount = safeSequence(aggregate.event_count, "Archive event count");
    if (
      safeSequence(aggregate.first_seq, "Archive first sequence") !== firstSequence ||
      lastSequence - firstSequence + 1 !== eventCount ||
      lastSequence > safeSequence(first.through_seq, "Projection sequence") ||
      aggregate.latest_persisted_at === null ||
      new Date(aggregate.latest_persisted_at).valueOf() >= cutoff.valueOf()
    ) {
      throw new SessionEventRetentionError(
        "event_archive_invariant",
        "Terminal Turn is not a contiguous eligible hot-event prefix",
        true,
      );
    }
    const id = this.#idGenerator();
    await transaction
      .insertInto("session_event_archives")
      .values({
        id,
        tenant_id: first.tenant_id,
        session_id: first.session_id,
        turn_id: first.turn_id,
        first_seq: firstSequence,
        last_seq: lastSequence,
        event_count: eventCount,
        format: SESSION_EVENT_ARCHIVE_FORMAT,
        object_key: null,
        sha256: null,
        uncompressed_sha256: null,
        size_bytes: null,
        uncompressed_size_bytes: null,
        state: "uploading",
        claim_owner: this.#ownerId,
        claim_until: claimUntil,
        archived_at: null,
      })
      .executeTakeFirstOrThrow();
    return {
      id,
      tenantId: first.tenant_id,
      sessionId: first.session_id,
      turnId: first.turn_id,
      firstSequence,
      lastSequence,
      eventCount,
      claimOwner: this.#ownerId,
      claimUntil,
    };
  }

  #job(
    row: {
      id: string;
      tenant_id: string;
      session_id: string;
      turn_id: string;
      first_seq: string;
      last_seq: string;
      event_count: number;
    },
    claimUntil: Date,
  ): ArchiveJob {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      firstSequence: safeSequence(row.first_seq, "Archive first sequence"),
      lastSequence: safeSequence(row.last_seq, "Archive last sequence"),
      eventCount: row.event_count,
      claimOwner: this.#ownerId,
      claimUntil,
    };
  }

  async #loadRows(job: ArchiveJob): Promise<readonly ArchiveEventRow[]> {
    return this.#database
      .selectFrom("session_events")
      .select([
        "event_id",
        "tenant_id",
        "session_id",
        "turn_id",
        "agent_node_id",
        "agent_id",
        "command_id",
        "seq",
        "schema_version",
        "type",
        "payload",
        "lease_id",
        "fencing_token",
        "occurred_at",
        "persisted_at",
      ])
      .where("tenant_id", "=", job.tenantId)
      .where("session_id", "=", job.sessionId)
      .where("turn_id", "=", job.turnId)
      .where("seq", ">=", String(job.firstSequence))
      .where("seq", "<=", String(job.lastSequence))
      .orderBy("seq", "asc")
      .execute();
  }

  async #putContentAddressed(objectKey: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.#objectStore.put(objectKey, bytes);
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code !== "EEXIST" && code !== "checkpoint_object_exists") throw error;
    }
    const existing = await this.#objectStore.get(objectKey);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new SessionEventRetentionError(
        "event_archive_corrupt",
        "Content-addressed Session event archive did not match its key",
        false,
      );
    }
  }

  async #finalize(
    job: ArchiveJob,
    archivedAt: Date,
    object: {
      objectKey: string;
      sha256: string;
      uncompressedSha256: string;
      sizeBytes: number;
      uncompressedSizeBytes: number;
    },
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const archive = await transaction
        .selectFrom("session_event_archives")
        .select(["state", "claim_owner", "claim_until"])
        .where("id", "=", job.id)
        .forUpdate()
        .executeTakeFirst();
      const cursor = await transaction
        .selectFrom("session_event_cursors")
        .select("replay_floor_seq")
        .where("session_id", "=", job.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        archive === undefined ||
        archive.state !== "uploading" ||
        archive.claim_owner !== job.claimOwner ||
        new Date(archive.claim_until).valueOf() <= archivedAt.valueOf() ||
        cursor === undefined ||
        Number(cursor.replay_floor_seq) + 1 !== job.firstSequence
      ) {
        throw new SessionEventRetentionError(
          "event_archive_stale_claim",
          "Session event archive claim is stale",
          true,
        );
      }
      const deleted = await transaction
        .deleteFrom("session_events")
        .where("tenant_id", "=", job.tenantId)
        .where("session_id", "=", job.sessionId)
        .where("turn_id", "=", job.turnId)
        .where("seq", ">=", String(job.firstSequence))
        .where("seq", "<=", String(job.lastSequence))
        .executeTakeFirst();
      if (deleted.numDeletedRows !== BigInt(job.eventCount)) {
        throw new SessionEventRetentionError(
          "event_archive_invariant",
          "Session event archive source changed before commit",
          true,
        );
      }
      const advanced = await transaction
        .updateTable("session_event_cursors")
        .set({ replay_floor_seq: job.lastSequence, updated_at: archivedAt })
        .where("session_id", "=", job.sessionId)
        .where("replay_floor_seq", "=", String(job.firstSequence - 1))
        .executeTakeFirst();
      if (advanced.numUpdatedRows !== 1n) {
        throw new SessionEventRetentionError(
          "event_archive_invariant",
          "Session replay floor lost its compare-and-set race",
          true,
        );
      }
      await sql`
        delete from session_event_ids as identity
         where identity.session_id = ${job.sessionId}
           and identity.seq between ${job.firstSequence} and ${job.lastSequence}
           and not exists (
             select 1
               from context_compactions as compaction
              where compaction.started_event_id = identity.event_id
                 or compaction.completed_event_id = identity.event_id
           )
      `.execute(transaction);
      await transaction
        .updateTable("session_event_archives")
        .set({
          state: "committed",
          object_key: object.objectKey,
          sha256: object.sha256,
          uncompressed_sha256: object.uncompressedSha256,
          size_bytes: object.sizeBytes,
          uncompressed_size_bytes: object.uncompressedSizeBytes,
          archived_at: archivedAt,
        })
        .where("id", "=", job.id)
        .where("state", "=", "uploading")
        .where("claim_owner", "=", job.claimOwner)
        .executeTakeFirstOrThrow();
    });
  }
}
