import type { Database } from "@agent-dock/database";
import {
  Session,
  SessionError,
  type Entry,
  type EntryQuery,
  type BranchBounds,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
} from "@earendil-works/pi-agent-core";
import { sql, type Kysely, type Transaction } from "kysely";

export type ExecutionAuthority = {
  assertCurrent(database?: Transaction<Database>): Promise<void>;
};

export type AgentDockPiSessionMetadata = SessionMetadata & {
  tenantId: string;
};

export type PostgresPiSessionStorageOptions = {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  authority?: ExecutionAuthority;
};

function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionError("storage", `${name} is outside the JavaScript safe-integer range`);
  }
  return parsed;
}

function limit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionError("invalid_query", "Query limit must be a positive safe integer");
  }
  return value;
}

function payload<T>(value: unknown): T {
  return structuredClone(value) as T;
}

function entryFromRow(row: {
  payload: Record<string, unknown>;
  seq: string;
  parent_id: string | null;
  timestamp_ms: string;
}): Entry {
  return {
    ...payload<Record<string, unknown>>(row.payload),
    seq: safeInteger(row.seq, "Pi entry sequence"),
    parentId: row.parent_id,
    timestamp: safeInteger(row.timestamp_ms, "Pi entry timestamp"),
  } as Entry;
}

function recordFromRow(row: {
  payload: Record<string, unknown>;
  seq: string;
  timestamp_ms: string;
}): LaneRecord {
  return {
    ...payload<Record<string, unknown>>(row.payload),
    seq: safeInteger(row.seq, "Pi record sequence"),
    timestamp: safeInteger(row.timestamp_ms, "Pi record timestamp"),
  } as LaneRecord;
}

/** PostgreSQL implementation of Pi 0.84's public bounded SessionStorage port. */
export class PostgresPiSessionStorage implements SessionStorage<AgentDockPiSessionMetadata> {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #authority: ExecutionAuthority | undefined;

  constructor(options: PostgresPiSessionStorageOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#authority = options.authority;
  }

  static async create(
    options: PostgresPiSessionStorageOptions & { createdAt?: number; parentSessionId?: string },
  ): Promise<PostgresPiSessionStorage> {
    const storage = new PostgresPiSessionStorage(options);
    await options.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("pi_sessions")
        .values({
          tenant_id: options.tenantId,
          id: options.sessionId,
          created_at_ms: options.createdAt ?? Date.now(),
          parent_session_id: options.parentSessionId ?? null,
          next_seq: 1,
          name: null,
        })
        .executeTakeFirst();
      await transaction
        .insertInto("pi_session_lanes")
        .values({
          tenant_id: options.tenantId,
          session_id: options.sessionId,
          lane: "main",
          leaf_id: null,
        })
        .executeTakeFirst();
    });
    return storage;
  }

  asSession(): Session<AgentDockPiSessionMetadata> {
    return new Session(this);
  }

  async getMetadata(): Promise<AgentDockPiSessionMetadata> {
    const row = await this.#database
      .selectFrom("pi_sessions")
      .select(["id", "tenant_id", "created_at_ms", "parent_session_id"])
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", this.#sessionId)
      .executeTakeFirst();
    if (row === undefined) throw new SessionError("not_found", "Pi Session was not found");
    return {
      id: row.id,
      tenantId: row.tenant_id,
      createdAt: safeInteger(row.created_at_ms, "Pi Session creation timestamp"),
      ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    };
  }

  async getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
    const rows = await this.#database
      .selectFrom("pi_session_lanes")
      .select(["lane", "leaf_id"])
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .orderBy("lane", "asc")
      .execute();
    return rows.map((row) => ({ lane: row.lane, leafId: row.leaf_id }));
  }

  async createLane(lane: string, at: string | null): Promise<void> {
    await this.#mutate(async (transaction) => {
      await this.#requireTarget(transaction, at);
      await transaction
        .insertInto("pi_session_lanes")
        .values({ tenant_id: this.#tenantId, session_id: this.#sessionId, lane, leaf_id: at })
        .executeTakeFirst();
      const seq = await this.#nextSequence(transaction);
      await this.#appendLog(transaction, seq, "lane", { lane, leafId: at });
    });
  }

  async moveLane(lane: string, to: string | null): Promise<void> {
    await this.#mutate(async (transaction) => {
      await this.#requireTarget(transaction, to);
      const update = await transaction
        .updateTable("pi_session_lanes")
        .set({ leaf_id: to })
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", lane)
        .executeTakeFirst();
      if (update.numUpdatedRows !== 1n)
        throw new SessionError("invalid_lane", "Pi lane was not found");
      const seq = await this.#nextSequence(transaction);
      await this.#appendLog(transaction, seq, "lane", { lane, leafId: to });
    });
  }

  async appendEntry<TEntry extends Entry>(
    newEntry: ProvisionedEntry<TEntry>,
    lane: string,
  ): Promise<TEntry> {
    return this.#mutate(async (transaction) => {
      const pointer = await transaction
        .selectFrom("pi_session_lanes")
        .select("leaf_id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", lane)
        .forUpdate()
        .executeTakeFirst();
      if (pointer === undefined) throw new SessionError("invalid_lane", "Pi lane was not found");
      const seq = await this.#nextSequence(transaction);
      const timestamp = Date.now();
      const complete = {
        ...payload<Record<string, unknown>>(newEntry),
        parentId: pointer.leaf_id,
        seq,
        timestamp,
      } as TEntry;
      await transaction
        .insertInto("pi_session_entries")
        .values({
          tenant_id: this.#tenantId,
          session_id: this.#sessionId,
          id: complete.id,
          seq,
          parent_id: pointer.leaf_id,
          type: complete.type,
          custom_type: complete.type === "custom" ? complete.customType : null,
          timestamp_ms: timestamp,
          payload: complete as unknown as Record<string, unknown>,
        })
        .executeTakeFirst();
      await transaction
        .updateTable("pi_session_lanes")
        .set({ leaf_id: complete.id })
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", lane)
        .executeTakeFirstOrThrow();
      await this.#appendLog(transaction, seq, "entry", { entry: complete });
      return complete;
    });
  }

  async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
    return this.#mutate(async (transaction) => {
      const lane = await transaction
        .selectFrom("pi_session_lanes")
        .select("lane")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", newRecord.lane)
        .forUpdate()
        .executeTakeFirst();
      if (lane === undefined) throw new SessionError("invalid_lane", "Pi lane was not found");
      if (newRecord.type === "operation_started") {
        const open = await this.#findOpenOperations(transaction, newRecord.lane, 1);
        if (open.length > 0) {
          throw new SessionError(
            "storage",
            `Pi lane ${newRecord.lane} already has an open operation`,
          );
        }
      }
      const seq = await this.#nextSequence(transaction);
      const timestamp = Date.now();
      const complete = {
        ...payload<Record<string, unknown>>(newRecord),
        seq,
        timestamp,
      } as TRecord;
      const runId =
        complete.type === "operation_started"
          ? complete.id
          : "runId" in complete && typeof complete.runId === "string"
            ? complete.runId
            : null;
      await transaction
        .insertInto("pi_session_records")
        .values({
          tenant_id: this.#tenantId,
          session_id: this.#sessionId,
          id: complete.id,
          seq,
          lane: complete.lane,
          type: complete.type,
          run_id: runId,
          operation_kind: complete.type === "operation_started" ? complete.intent.kind : null,
          timestamp_ms: timestamp,
          payload: complete as unknown as Record<string, unknown>,
        })
        .executeTakeFirst();
      await this.#appendLog(transaction, seq, "record", { record: complete });
      return complete;
    });
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const row = await this.#database
      .selectFrom("pi_session_entries")
      .select(["payload", "seq", "parent_id", "timestamp_ms"])
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : entryFromRow(row);
  }

  async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
    const boundedLimit = limit(query.limit);
    let selection = this.#database
      .selectFrom("pi_session_entries")
      .select(["payload", "seq", "parent_id", "timestamp_ms"])
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId);
    if (query.type !== undefined) selection = selection.where("type", "=", query.type);
    if (query.customType !== undefined)
      selection = selection.where("custom_type", "=", query.customType);
    if (query.cursor !== undefined) {
      selection = selection.where(
        "seq",
        query.order === "oldestFirst" ? ">" : "<",
        String(query.cursor.afterSeq),
      );
    }
    selection = selection.orderBy("seq", query.order === "oldestFirst" ? "asc" : "desc");
    if (boundedLimit !== undefined) selection = selection.limit(boundedLimit);
    return (await selection.execute()).map(entryFromRow);
  }

  async findEntriesOnBranch(
    query: EntryQuery & BranchBounds & { start: string },
  ): Promise<Entry[]> {
    const maximum = limit(query.limit) ?? Number.MAX_SAFE_INTEGER;
    const walked: Entry[] = [];
    const visited = new Set<string>();
    let currentId: string | null = query.start;
    while (currentId !== null && walked.length < maximum) {
      if (visited.has(currentId))
        throw new SessionError("invalid_entry", "Pi Session branch contains a cycle");
      visited.add(currentId);
      const current = await this.getEntry(currentId);
      if (current === undefined)
        throw new SessionError("not_found", `Pi entry was not found: ${currentId}`);
      const matchesCursor =
        query.cursor === undefined ||
        (query.order === "oldestFirst"
          ? current.seq > query.cursor.afterSeq
          : current.seq < query.cursor.afterSeq);
      if (
        matchesCursor &&
        (query.type === undefined || current.type === query.type) &&
        (query.customType === undefined ||
          (current.type === "custom" && current.customType === query.customType))
      ) {
        walked.push(current);
      }
      if (current.id === query.stopAtId || current.type === query.stopAtType) break;
      currentId = current.parentId;
    }
    return query.order === "oldestFirst" ? walked.reverse() : walked;
  }

  async findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
    const boundedLimit = limit(query.limit);
    let selection = this.#database
      .selectFrom("pi_session_records")
      .select(["payload", "seq", "timestamp_ms"])
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId);
    if (query.lane !== undefined) selection = selection.where("lane", "=", query.lane);
    if (query.type !== undefined) selection = selection.where("type", "=", query.type);
    if (query.runId !== undefined) selection = selection.where("run_id", "=", query.runId);
    if (query.operationKind !== undefined) {
      selection = selection.where("operation_kind", "=", query.operationKind);
    }
    if (query.afterSeq !== undefined)
      selection = selection.where("seq", ">", String(query.afterSeq));
    selection = selection.orderBy("seq", query.order === "oldestFirst" ? "asc" : "desc");
    if (boundedLimit !== undefined) selection = selection.limit(boundedLimit);
    return (await selection.execute()).map(recordFromRow);
  }

  async findOpenOperations(
    lane: string,
    options?: { limit?: number },
  ): Promise<OperationStartedRecord[]> {
    return this.#findOpenOperations(this.#database, lane, limit(options?.limit));
  }

  async getLog(options: { afterSeq?: number; limit?: number } = {}): Promise<LogItem[]> {
    const boundedLimit = limit(options.limit);
    let selection = this.#database
      .selectFrom("pi_session_log")
      .select(["seq", "kind", "payload"])
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId);
    if (options.afterSeq !== undefined) {
      selection = selection.where("seq", ">", String(options.afterSeq));
    }
    selection = selection.orderBy("seq", "asc");
    if (boundedLimit !== undefined) selection = selection.limit(boundedLimit);
    return (await selection.execute()).map(
      (row) =>
        ({
          ...payload<Record<string, unknown>>(row.payload),
          kind: row.kind,
          seq: safeInteger(row.seq, "Pi log sequence"),
        }) as LogItem,
    );
  }

  async getName(): Promise<string | undefined> {
    const row = await this.#database
      .selectFrom("pi_sessions")
      .select("name")
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", this.#sessionId)
      .executeTakeFirst();
    if (row === undefined) throw new SessionError("not_found", "Pi Session was not found");
    return row.name ?? undefined;
  }

  async setName(name: string): Promise<void> {
    await this.#mutate(async (transaction) => {
      const seq = await this.#nextSequence(transaction);
      await transaction
        .updateTable("pi_sessions")
        .set({ name })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", this.#sessionId)
        .executeTakeFirstOrThrow();
      await this.#appendLog(transaction, seq, "fact", { fact: "name", name });
    });
  }

  async getLabel(id: string): Promise<string | undefined> {
    const row = await this.#database
      .selectFrom("pi_session_labels")
      .select("label")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("target_id", "=", id)
      .executeTakeFirst();
    return row?.label;
  }

  async setLabel(id: string, label: string | undefined): Promise<void> {
    await this.#mutate(async (transaction) => {
      await this.#requireTarget(transaction, id);
      const seq = await this.#nextSequence(transaction);
      if (label === undefined) {
        await transaction
          .deleteFrom("pi_session_labels")
          .where("tenant_id", "=", this.#tenantId)
          .where("session_id", "=", this.#sessionId)
          .where("target_id", "=", id)
          .execute();
      } else {
        await transaction
          .insertInto("pi_session_labels")
          .values({
            tenant_id: this.#tenantId,
            session_id: this.#sessionId,
            target_id: id,
            label,
            updated_seq: seq,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "session_id", "target_id"]).doUpdateSet({
              label,
              updated_seq: seq,
            }),
          )
          .execute();
      }
      await this.#appendLog(transaction, seq, "fact", {
        fact: "label",
        targetId: id,
        ...(label === undefined ? {} : { label }),
      });
    });
  }

  async getStats(): Promise<SessionStats> {
    const message = await this.#database
      .selectFrom("pi_session_entries")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("type", "=", "message")
      .executeTakeFirstOrThrow();
    return {
      messageCount: safeInteger(message.count, "Pi message count"),
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    };
  }

  async #mutate<T>(effect: (transaction: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#authority?.assertCurrent(transaction);
      return effect(transaction);
    });
  }

  async #nextSequence(transaction: Transaction<Database>): Promise<number> {
    const result = await sql<{ seq: string }>`
      update pi_sessions
         set next_seq = next_seq + 1
       where tenant_id = ${this.#tenantId}::uuid
         and id = ${this.#sessionId}::uuid
       returning next_seq - 1 as seq
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) throw new SessionError("not_found", "Pi Session was not found");
    return safeInteger(row.seq, "Pi Session sequence");
  }

  async #appendLog(
    transaction: Transaction<Database>,
    seq: number,
    kind: LogItem["kind"],
    value: Record<string, unknown>,
  ): Promise<void> {
    await transaction
      .insertInto("pi_session_log")
      .values({
        tenant_id: this.#tenantId,
        session_id: this.#sessionId,
        seq,
        kind,
        payload: value,
      })
      .executeTakeFirst();
  }

  async #requireTarget(transaction: Transaction<Database>, id: string | null): Promise<void> {
    if (id === null) return;
    const row = await transaction
      .selectFrom("pi_session_entries")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) throw new SessionError("not_found", `Pi entry was not found: ${id}`);
  }

  async #findOpenOperations(
    database: Kysely<Database> | Transaction<Database>,
    lane: string,
    maximum?: number,
  ): Promise<OperationStartedRecord[]> {
    let query = database
      .selectFrom("pi_session_records as started")
      .select(["started.payload", "started.seq", "started.timestamp_ms"])
      .where("started.tenant_id", "=", this.#tenantId)
      .where("started.session_id", "=", this.#sessionId)
      .where("started.lane", "=", lane)
      .where("started.type", "=", "operation_started")
      .where(
        sql<boolean>`not exists (
          select 1 from pi_session_records as finished
           where finished.tenant_id = started.tenant_id
             and finished.session_id = started.session_id
             and finished.lane = started.lane
             and finished.type = 'operation_finished'
             and finished.run_id = started.id
        )`,
      )
      .orderBy("started.seq", "desc");
    if (maximum !== undefined) query = query.limit(maximum);
    return (await query.execute()).map(recordFromRow) as OperationStartedRecord[];
  }
}

export {
  PostgresRunExecutionAuthority,
  type PostgresRunExecutionAuthorityOptions,
} from "./postgres-execution-authority.ts";
