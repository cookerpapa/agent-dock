import type { Database } from "@pi-cloud/database";
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
import type { ExecutionAuthority } from "./execution-authority.ts";
import type { PostgresPiSessionEntryPayloadCache } from "./session-entry-payload-cache.ts";

export type { ActiveExecutionAuthority, ExecutionAuthority } from "./execution-authority.ts";

export type PiCloudPiSessionMetadata = SessionMetadata & {
  tenantId: string;
};

export type PostgresPiSessionStorageOptions = {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  turnId?: string;
  authority?: ExecutionAuthority;
  entryPayloadCache?: PostgresPiSessionEntryPayloadCache;
};

function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionError("storage", `${name} is outside the JavaScript safe-integer range`);
  }
  return parsed;
}

function signedSafeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new SessionError("storage", `${name} is outside the JavaScript safe-integer range`);
  }
  return parsed;
}

function finiteNumber(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SessionError("storage", `${name} is not a finite number`);
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

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
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

type VisibleEntryRow = {
  payload: Record<string, unknown> | null;
  seq: string;
  parent_id: string | null;
  timestamp_ms: string;
  source_session_id: string;
  source_entry_id: string;
};
type HydratedVisibleEntryRow = Omit<VisibleEntryRow, "payload"> & {
  payload: Record<string, unknown>;
};

/** PostgreSQL implementation of Pi 0.84's public bounded SessionStorage port. */
export class PostgresPiSessionStorage implements SessionStorage<PiCloudPiSessionMetadata> {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #turnId: string | undefined;
  readonly #authority: ExecutionAuthority | undefined;
  readonly #entryPayloadCache: PostgresPiSessionEntryPayloadCache | undefined;

  constructor(options: PostgresPiSessionStorageOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
    this.#authority = options.authority;
    this.#entryPayloadCache = options.entryPayloadCache;
  }

  static async create(
    options: PostgresPiSessionStorageOptions & { createdAt?: number; parentSessionId?: string },
  ): Promise<PostgresPiSessionStorage> {
    const storage = new PostgresPiSessionStorage(options);
    await options.database.transaction().execute(async (transaction) => {
      await options.authority?.assertCurrent(transaction);
      const created = await transaction
        .insertInto("pi_sessions")
        .values({
          tenant_id: options.tenantId,
          id: options.sessionId,
          created_at_ms: options.createdAt ?? Date.now(),
          parent_session_id: options.parentSessionId ?? null,
          next_seq: 1,
          name: null,
        })
        .onConflict((conflict) => conflict.columns(["tenant_id", "id"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (created === undefined) {
        throw new SessionError("already_exists", `Pi Session already exists: ${options.sessionId}`);
      }
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

  asSession(): Session<PiCloudPiSessionMetadata> {
    return new Session(this);
  }

  async getMetadata(): Promise<PiCloudPiSessionMetadata> {
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
      const existing = await transaction
        .selectFrom("pi_session_lanes")
        .select("lane")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", lane)
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new SessionError("already_exists", `Pi lane already exists: ${lane}`);
      }
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
      await this.#requireUnusedId(transaction, newEntry.id);
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
          turn_id: await this.#entryTurnId(transaction, lane),
        })
        .executeTakeFirst();
      await transaction
        .updateTable("pi_session_lanes")
        .set({ leaf_id: complete.id })
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", this.#sessionId)
        .where("lane", "=", lane)
        .executeTakeFirstOrThrow();
      await this.#appendLog(transaction, seq, "entry", { entryId: complete.id });
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
      await this.#requireUnusedId(transaction, newRecord.id);
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
      const turnId = await this.#recordTurnId(transaction, newRecord);
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
          turn_id: turnId,
        })
        .executeTakeFirst();
      await this.#appendLog(transaction, seq, "record", { recordId: complete.id });
      return complete;
    });
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const row = await this.#database
      .selectFrom("pi_session_visible_entries")
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
      .selectFrom("pi_session_visible_entries")
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
    const oldestFirst = query.order === "oldestFirst";
    const direction = query.order === "oldestFirst" ? sql.raw("asc") : sql.raw("desc");
    const cursorOperator = query.order === "oldestFirst" ? sql.raw(">") : sql.raw("<");
    const result = await sql<{
      payload: Record<string, unknown> | null;
      seq: string | null;
      parent_id: string | null;
      timestamp_ms: string | null;
      source_session_id: string | null;
      source_entry_id: string | null;
      diagnostic: boolean;
      start_missing: boolean;
      cycle_detected: boolean;
      parent_missing: boolean;
    }>`
      with recursive visible as (
        select null::jsonb as payload,
               seq,
               parent_id,
               timestamp_ms,
               id,
               type,
               custom_type,
               session_id as source_session_id,
               id as source_entry_id
          from pi_session_entries
         where tenant_id = ${this.#tenantId}::uuid
           and session_id = ${this.#sessionId}::text
        union all
        select null::jsonb as payload,
               seq,
               parent_id,
               timestamp_ms,
               id,
               type,
               custom_type,
               source_session_id,
               source_entry_id
          from pi_session_entry_refs
         where tenant_id = ${this.#tenantId}::uuid
           and session_id = ${this.#sessionId}::text
      ), branch as (
        select payload,
               seq,
               parent_id,
               timestamp_ms,
               id,
               type,
               custom_type,
               source_session_id,
               source_entry_id,
               array[id] as path
          from visible
         where id = ${query.start}::text
        union all
        select parent.payload,
               parent.seq,
               parent.parent_id,
               parent.timestamp_ms,
               parent.id,
               parent.type,
               parent.custom_type,
               parent.source_session_id,
               parent.source_entry_id,
               branch.path || parent.id
          from visible parent
          join branch
            on parent.id = branch.parent_id
         where not parent.id = any(branch.path)
           and (${oldestFirst}
                or ((${query.stopAtId ?? null}::text is null or branch.id <> ${query.stopAtId ?? null}::text)
                    and (${query.stopAtType ?? null}::text is null or branch.type <> ${query.stopAtType ?? null}::text)))
      ), diagnostics as (
        select not exists (select 1 from branch) as start_missing,
               exists (
                 select 1 from branch child
                  where child.parent_id is not null
                    and child.parent_id = any(child.path)
               ) as cycle_detected,
               exists (
                 select 1 from branch child
                  where child.parent_id is not null
                    and not child.parent_id = any(child.path)
                    and not exists (
                      select 1 from visible parent
                       where parent.id = child.parent_id
                    )
               ) as parent_missing
      ), boundary as (
        select case when ${oldestFirst}
                    then min(branch.seq)
                    else max(branch.seq)
               end as seq
          from branch
         where ((${query.stopAtId ?? null}::text is not null and branch.id = ${query.stopAtId ?? null}::text)
             or (${query.stopAtType ?? null}::text is not null and branch.type = ${query.stopAtType ?? null}::text))
      ), selected as (
        select branch.payload,
               branch.seq,
               branch.parent_id,
               branch.timestamp_ms,
               branch.source_session_id,
               branch.source_entry_id
          from branch, boundary
         where (boundary.seq is null
                or (${oldestFirst} and branch.seq <= boundary.seq)
                or (not ${oldestFirst} and branch.seq >= boundary.seq))
           and (${query.type ?? null}::text is null or type = ${query.type ?? null}::text)
           and (${query.customType ?? null}::text is null or custom_type = ${query.customType ?? null}::text)
           and (${query.cursor?.afterSeq ?? null}::bigint is null
                or branch.seq ${cursorOperator} ${query.cursor?.afterSeq ?? null}::bigint)
         order by branch.seq ${direction}
         limit ${maximum}
      )
      select selected.payload,
             selected.seq,
             selected.parent_id,
             selected.timestamp_ms,
             selected.source_session_id,
             selected.source_entry_id,
             false as diagnostic,
             diagnostics.start_missing,
             diagnostics.cycle_detected,
             diagnostics.parent_missing
        from selected cross join diagnostics
      union all
      select null, null, null, null, null, null, true,
             diagnostics.start_missing,
             diagnostics.cycle_detected,
             diagnostics.parent_missing
        from diagnostics
       where not exists (select 1 from selected)
      order by diagnostic asc, seq ${direction}
    `.execute(this.#database);
    const diagnostics = result.rows[0]!;
    if (diagnostics.start_missing) {
      throw new SessionError("not_found", `Pi entry was not found: ${query.start}`);
    }
    if (diagnostics.cycle_detected || diagnostics.parent_missing) {
      throw new SessionError("invalid_entry", "Pi Session branch is corrupt");
    }
    const selectedRows = result.rows
      .filter(
        (
          row,
        ): row is typeof row & {
          payload: Record<string, unknown>;
          seq: string;
          timestamp_ms: string;
          source_session_id: string;
          source_entry_id: string;
        } =>
          !row.diagnostic &&
          row.seq !== null &&
          row.timestamp_ms !== null &&
          row.source_session_id !== null &&
          row.source_entry_id !== null,
      )
      .map((row) => ({
        payload: row.payload,
        seq: row.seq,
        parent_id: row.parent_id,
        timestamp_ms: row.timestamp_ms,
        source_session_id: row.source_session_id,
        source_entry_id: row.source_entry_id,
      }));
    return (await this.#hydrateEntryRows(selectedRows)).map(entryFromRow);
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
    const boundedLimit = limit(options.limit) ?? Number.MAX_SAFE_INTEGER;
    const rows = await sql<{
      seq: string;
      kind: LogItem["kind"];
      payload: Record<string, unknown>;
    }>`
      select log.seq,
             log.kind,
             case log.kind
               when 'entry' then jsonb_build_object('entry', entry.payload)
               when 'record' then jsonb_build_object('record', record.payload)
               else log.payload
             end as payload
        from pi_session_log log
        left join pi_session_entries entry
          on log.kind = 'entry'
         and entry.tenant_id = log.tenant_id
         and entry.session_id = log.session_id
         and entry.id = log.payload ->> 'entryId'
        left join pi_session_records record
          on log.kind = 'record'
         and record.tenant_id = log.tenant_id
         and record.session_id = log.session_id
         and record.id = log.payload ->> 'recordId'
       where log.tenant_id = ${this.#tenantId}::uuid
         and log.session_id = ${this.#sessionId}::text
         and (${options.afterSeq ?? null}::bigint is null
              or log.seq > ${options.afterSeq ?? null}::bigint)
      union all
      select ref.seq,
             'entry' as kind,
             jsonb_build_object(
               'entry',
               source.payload || jsonb_build_object(
                 'seq', ref.seq,
                 'parentId', ref.parent_id,
                 'timestamp', ref.timestamp_ms
               )
             ) as payload
        from pi_session_entry_refs ref
        join pi_session_entries source
          on source.tenant_id = ref.tenant_id
         and source.session_id = ref.source_session_id
         and source.id = ref.source_entry_id
       where ref.tenant_id = ${this.#tenantId}::uuid
         and ref.session_id = ${this.#sessionId}::text
         and (${options.afterSeq ?? null}::bigint is null
              or ref.seq > ${options.afterSeq ?? null}::bigint)
       order by seq asc
       limit ${boundedLimit}
    `.execute(this.#database);
    return rows.rows.map(
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
    const result = await sql<{
      message_count: string;
      cached_tokens: string;
      uncached_tokens: string;
      total_tokens: string;
      cost_total: string;
    }>`
      select (
               select count(*)
                 from pi_session_visible_entries
                where tenant_id = ${this.#tenantId}::uuid
                  and session_id = ${this.#sessionId}::text
                  and type = 'message'
             )::text as message_count,
             coalesce((
               select sum((payload #>> '{usage,cacheRead}')::numeric)
                 from pi_session_records
                where tenant_id = ${this.#tenantId}::uuid
                  and session_id = ${this.#sessionId}::text
                  and type = 'usage'
             ), 0)::text as cached_tokens,
             coalesce((
               select sum((payload #>> '{usage,input}')::numeric
                        + (payload #>> '{usage,cacheWrite}')::numeric)
                 from pi_session_records
                where tenant_id = ${this.#tenantId}::uuid
                  and session_id = ${this.#sessionId}::text
                  and type = 'usage'
             ), 0)::text as uncached_tokens,
             coalesce((
               select sum((payload #>> '{usage,totalTokens}')::numeric)
                 from pi_session_records
                where tenant_id = ${this.#tenantId}::uuid
                  and session_id = ${this.#sessionId}::text
                  and type = 'usage'
             ), 0)::text as total_tokens,
             coalesce((
               select sum((payload #>> '{usage,cost,total}')::numeric)
                 from pi_session_records
                where tenant_id = ${this.#tenantId}::uuid
                  and session_id = ${this.#sessionId}::text
                  and type = 'usage'
             ), 0)::text as cost_total
    `.execute(this.#database);
    const row = result.rows[0];
    if (row === undefined)
      throw new SessionError("storage", "Pi Session statistics were unavailable");
    return {
      messageCount: safeInteger(row.message_count, "Pi message count"),
      cachedTokens: signedSafeInteger(row.cached_tokens, "Pi cached token count"),
      uncachedTokens: signedSafeInteger(row.uncached_tokens, "Pi uncached token count"),
      totalTokens: signedSafeInteger(row.total_tokens, "Pi total token count"),
      costTotal: finiteNumber(row.cost_total, "Pi total cost"),
    };
  }

  async #mutate<T>(effect: (transaction: Transaction<Database>) => Promise<T>): Promise<T> {
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        await this.#authority?.assertCurrent(transaction);
        return effect(transaction);
      });
    } catch (error) {
      if (error instanceof SessionError) throw error;
      if (postgresErrorCode(error) === "23505") {
        throw new SessionError(
          "already_exists",
          "Pi Session mutation reused an existing id",
          error as Error,
        );
      }
      throw error;
    }
  }

  async #hydrateEntryRows(rows: readonly VisibleEntryRow[]): Promise<HydratedVisibleEntryRow[]> {
    const hydrated = rows.map((row) => ({ ...row }));
    const missingBySession = new Map<string, Set<string>>();
    for (const row of hydrated) {
      const cached = this.#entryPayloadCache?.get(
        this.#tenantId,
        row.source_session_id,
        row.source_entry_id,
      );
      if (cached !== undefined) {
        row.payload = cached;
        continue;
      }
      const ids = missingBySession.get(row.source_session_id) ?? new Set<string>();
      ids.add(row.source_entry_id);
      missingBySession.set(row.source_session_id, ids);
    }
    for (const [sourceSessionId, ids] of missingBySession) {
      const sourceRows = await this.#database
        .selectFrom("pi_session_entries")
        .select(["id", "payload"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sourceSessionId)
        .where("id", "in", [...ids])
        .execute();
      for (const source of sourceRows) {
        this.#entryPayloadCache?.set(this.#tenantId, sourceSessionId, source.id, source.payload);
      }
      const payloadById = new Map(sourceRows.map((source) => [source.id, source.payload] as const));
      for (const row of hydrated) {
        if (row.source_session_id !== sourceSessionId || row.payload !== null) continue;
        row.payload = payloadById.get(row.source_entry_id) ?? null;
      }
    }
    if (hydrated.some((row) => row.payload === null)) {
      throw new SessionError("invalid_entry", "Pi Session references a missing shared entry");
    }
    return hydrated as HydratedVisibleEntryRow[];
  }

  async #nextSequence(transaction: Transaction<Database>): Promise<number> {
    const result = await sql<{ seq: string }>`
      update pi_sessions
         set next_seq = next_seq + 1
       where tenant_id = ${this.#tenantId}::uuid
         and id = ${this.#sessionId}::text
       returning next_seq - 1 as seq
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) throw new SessionError("not_found", "Pi Session was not found");
    return safeInteger(row.seq, "Pi Session sequence");
  }

  async #entryTurnId(transaction: Transaction<Database>, lane: string): Promise<string | null> {
    const open = await sql<{ turn_id: string | null }>`
      select started.turn_id
        from pi_session_records started
       where started.tenant_id = ${this.#tenantId}::uuid
         and started.session_id = ${this.#sessionId}::text
         and started.lane = ${lane}
         and started.type = 'operation_started'
         and not exists (
           select 1
             from pi_session_records finished
            where finished.tenant_id = started.tenant_id
              and finished.session_id = started.session_id
              and finished.type = 'operation_finished'
              and finished.run_id = started.id
         )
       order by started.seq desc
       limit 1
    `.execute(transaction);
    return open.rows[0]?.turn_id ?? this.#turnId ?? null;
  }

  async #recordTurnId(
    transaction: Transaction<Database>,
    record: NewRecord<LaneRecord>,
  ): Promise<string | null> {
    if (record.type === "operation_started") return this.#turnId ?? null;
    if (!("runId" in record) || typeof record.runId !== "string") return this.#turnId ?? null;
    const operation = await transaction
      .selectFrom("pi_session_records")
      .select("turn_id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", record.runId)
      .where("type", "=", "operation_started")
      .executeTakeFirst();
    return operation?.turn_id ?? this.#turnId ?? null;
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
      .selectFrom("pi_session_visible_entries")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) throw new SessionError("not_found", `Pi entry was not found: ${id}`);
  }

  async #requireUnusedId(transaction: Transaction<Database>, id: string): Promise<void> {
    const entry = await transaction
      .selectFrom("pi_session_visible_entries")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (entry !== undefined) {
      throw new SessionError("already_exists", `Pi Session id already exists: ${id}`);
    }
    const record = await transaction
      .selectFrom("pi_session_records")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (record !== undefined) {
      throw new SessionError("already_exists", `Pi Session id already exists: ${id}`);
    }
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
             and finished.seq > started.seq
        )`,
      )
      .orderBy("started.seq", "desc");
    if (maximum !== undefined) query = query.limit(maximum);
    return (await query.execute()).map(recordFromRow) as OperationStartedRecord[];
  }
}
