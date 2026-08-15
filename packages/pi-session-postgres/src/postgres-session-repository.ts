import type { Database } from "@agent-dock/database";
import {
  Session,
  SessionError,
  type Entry,
  type ForkOptions,
  type SessionCreateOptions,
  type SessionRepo,
} from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ExecutionAuthority } from "./execution-authority.ts";
import {
  PostgresPiSessionStorage,
  type AgentDockPiSessionMetadata,
} from "./postgres-session-storage.ts";

export type PostgresPiSessionRepositoryOptions = {
  database: Kysely<Database>;
  tenantId: string;
  authority?: ExecutionAuthority;
};

export type PostgresPiSessionCreateOptions = SessionCreateOptions;

type StoredEntryRow = {
  id: string;
  seq: string;
  parent_id: string | null;
  type: string;
  custom_type: string | null;
  timestamp_ms: string;
  payload: Record<string, unknown>;
};

function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionError("storage", `${name} is outside the JavaScript safe-integer range`);
  }
  return parsed;
}

function completeEntry(row: StoredEntryRow, sequence: number): Entry {
  return {
    ...structuredClone(row.payload),
    id: row.id,
    parentId: row.parent_id,
    seq: sequence,
    timestamp: safeInteger(row.timestamp_ms, "Pi entry timestamp"),
  } as Entry;
}

/** Tenant-scoped implementation of Pi 0.84.1's public SessionRepo port. */
export class PostgresPiSessionRepository implements SessionRepo<
  AgentDockPiSessionMetadata,
  PostgresPiSessionCreateOptions,
  void
> {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #authority: ExecutionAuthority | undefined;

  constructor(options: PostgresPiSessionRepositoryOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#authority = options.authority;
  }

  async create(
    options: PostgresPiSessionCreateOptions = {},
  ): Promise<Session<AgentDockPiSessionMetadata>> {
    const storage = await PostgresPiSessionStorage.create({
      database: this.#database,
      tenantId: this.#tenantId,
      sessionId: options.id ?? uuidv7(),
      ...(options.parentSessionId === undefined
        ? {}
        : { parentSessionId: options.parentSessionId }),
      ...(this.#authority === undefined ? {} : { authority: this.#authority }),
    });
    return storage.asSession();
  }

  async open(metadata: AgentDockPiSessionMetadata): Promise<Session<AgentDockPiSessionMetadata>> {
    this.#requireTenant(metadata);
    const storage = this.#storage(metadata.id);
    await storage.getMetadata();
    return storage.asSession();
  }

  async openById(sessionId: string): Promise<Session<AgentDockPiSessionMetadata>> {
    const storage = this.#storage(sessionId);
    await storage.getMetadata();
    return storage.asSession();
  }

  async openOrCreate(
    options: PostgresPiSessionCreateOptions,
  ): Promise<Session<AgentDockPiSessionMetadata>> {
    if (options.id === undefined) return this.create(options);
    try {
      return await this.openById(options.id);
    } catch (error) {
      if (!(error instanceof SessionError) || error.code !== "not_found") throw error;
    }
    try {
      return await this.create(options);
    } catch (error) {
      if (!(error instanceof SessionError) || error.code !== "already_exists") throw error;
      return this.openById(options.id);
    }
  }

  async list(): Promise<AgentDockPiSessionMetadata[]> {
    const rows = await this.#database
      .selectFrom("pi_sessions")
      .select(["id", "tenant_id", "created_at_ms", "parent_session_id"])
      .where("tenant_id", "=", this.#tenantId)
      .orderBy("created_at_ms", "desc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      createdAt: safeInteger(row.created_at_ms, "Pi Session creation timestamp"),
      ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    }));
  }

  async delete(metadata: AgentDockPiSessionMetadata): Promise<void> {
    this.#requireTenant(metadata);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#authority?.assertCurrent(transaction);
      await transaction
        .deleteFrom("pi_sessions")
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", metadata.id)
        .execute();
    });
  }

  async fork(
    source: AgentDockPiSessionMetadata,
    options: ForkOptions & PostgresPiSessionCreateOptions,
  ): Promise<Session<AgentDockPiSessionMetadata>> {
    this.#requireTenant(source);
    const destinationId = options.id ?? uuidv7();
    await this.#database.transaction().execute(async (transaction) => {
      await this.#authority?.assertCurrent(transaction);
      await this.#forkInTransaction(transaction, source.id, destinationId, options);
    });
    return this.#storage(destinationId).asSession();
  }

  #storage(sessionId: string): PostgresPiSessionStorage {
    return new PostgresPiSessionStorage({
      database: this.#database,
      tenantId: this.#tenantId,
      sessionId,
      ...(this.#authority === undefined ? {} : { authority: this.#authority }),
    });
  }

  #requireTenant(metadata: AgentDockPiSessionMetadata): void {
    if (metadata.tenantId !== this.#tenantId) {
      throw new SessionError("not_found", `Pi Session was not found: ${metadata.id}`);
    }
  }

  async #forkInTransaction(
    transaction: Transaction<Database>,
    sourceId: string,
    destinationId: string,
    options: ForkOptions & PostgresPiSessionCreateOptions,
  ): Promise<void> {
    const source = await transaction
      .selectFrom("pi_sessions")
      .select(["id", "name"])
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (source === undefined) {
      throw new SessionError("not_found", `Pi Session was not found: ${sourceId}`);
    }

    const createdAt = Date.now();
    const created = await transaction
      .insertInto("pi_sessions")
      .values({
        tenant_id: this.#tenantId,
        id: destinationId,
        created_at_ms: createdAt,
        parent_session_id: options.parentSessionId ?? sourceId,
        next_seq: 1,
        name: source.name,
      })
      .onConflict((conflict) => conflict.columns(["tenant_id", "id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (created === undefined) {
      throw new SessionError("already_exists", `Pi Session already exists: ${destinationId}`);
    }

    let entries: StoredEntryRow[];
    let lanes: { lane: string; leaf_id: string | null }[];
    if (options.scope === "tree") {
      entries = await transaction
        .selectFrom("pi_session_entries")
        .select(["id", "seq", "parent_id", "type", "custom_type", "timestamp_ms", "payload"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sourceId)
        .orderBy("seq", "asc")
        .execute();
      lanes = await transaction
        .selectFrom("pi_session_lanes")
        .select(["lane", "leaf_id"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sourceId)
        .orderBy("lane", "asc")
        .execute();
    } else {
      const main = await transaction
        .selectFrom("pi_session_lanes")
        .select("leaf_id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sourceId)
        .where("lane", "=", "main")
        .executeTakeFirstOrThrow();
      const selectedId = options.entryId ?? main.leaf_id;
      let targetId: string | null = null;
      if (selectedId !== null) {
        const selected = await transaction
          .selectFrom("pi_session_entries")
          .select(["id", "parent_id", "type"])
          .where("tenant_id", "=", this.#tenantId)
          .where("session_id", "=", sourceId)
          .where("id", "=", selectedId)
          .executeTakeFirst();
        if (selected === undefined || selected.type !== "message") {
          throw new SessionError(
            "invalid_fork_target",
            `Fork target is not a message entry: ${selectedId}`,
          );
        }
        const position = options.position ?? (options.entryId === undefined ? "at" : "before");
        targetId = position === "at" ? selected.id : selected.parent_id;
      }
      if (targetId === null) {
        entries = [];
      } else {
        const result = await sql<StoredEntryRow>`
          with recursive branch as (
            select id, seq, parent_id, type, custom_type, timestamp_ms, payload
              from pi_session_entries
             where tenant_id = ${this.#tenantId}::uuid
               and session_id = ${sourceId}::text
               and id = ${targetId}::text
            union all
            select parent.id,
                   parent.seq,
                   parent.parent_id,
                   parent.type,
                   parent.custom_type,
                   parent.timestamp_ms,
                   parent.payload
              from pi_session_entries parent
              join branch child
                on parent.tenant_id = ${this.#tenantId}::uuid
               and parent.session_id = ${sourceId}::text
               and parent.id = child.parent_id
          )
          select id, seq, parent_id, type, custom_type, timestamp_ms, payload
            from branch
           order by seq asc
        `.execute(transaction);
        entries = result.rows;
      }
      lanes = [{ lane: "main", leaf_id: targetId }];
    }

    let nextSequence = 1;
    const copiedEntries = entries.map((row) => completeEntry(row, nextSequence++));
    if (copiedEntries.length > 0) {
      await transaction
        .insertInto("pi_session_entries")
        .values(
          copiedEntries.map((entry) => ({
            tenant_id: this.#tenantId,
            session_id: destinationId,
            id: entry.id,
            seq: entry.seq,
            parent_id: entry.parentId,
            type: entry.type,
            custom_type: entry.type === "custom" ? entry.customType : null,
            timestamp_ms: entry.timestamp,
            payload: entry as unknown as Record<string, unknown>,
          })),
        )
        .execute();
      await transaction
        .insertInto("pi_session_log")
        .values(
          copiedEntries.map((entry) => ({
            tenant_id: this.#tenantId,
            session_id: destinationId,
            seq: entry.seq,
            kind: "entry",
            payload: { entry },
          })),
        )
        .execute();
    }

    for (const lane of lanes) {
      const sequence = nextSequence++;
      await transaction
        .insertInto("pi_session_lanes")
        .values({
          tenant_id: this.#tenantId,
          session_id: destinationId,
          lane: lane.lane,
          leaf_id: lane.leaf_id,
        })
        .executeTakeFirst();
      await transaction
        .insertInto("pi_session_log")
        .values({
          tenant_id: this.#tenantId,
          session_id: destinationId,
          seq: sequence,
          kind: "lane",
          payload: { lane: lane.lane, leafId: lane.leaf_id },
        })
        .executeTakeFirst();
    }

    if (source.name !== null) {
      const sequence = nextSequence++;
      await transaction
        .insertInto("pi_session_log")
        .values({
          tenant_id: this.#tenantId,
          session_id: destinationId,
          seq: sequence,
          kind: "fact",
          payload: { fact: "name", name: source.name },
        })
        .executeTakeFirst();
    }

    const copiedIds = copiedEntries.map((entry) => entry.id);
    const labels =
      copiedIds.length === 0
        ? []
        : await transaction
            .selectFrom("pi_session_labels")
            .select(["target_id", "label"])
            .where("tenant_id", "=", this.#tenantId)
            .where("session_id", "=", sourceId)
            .where("target_id", "in", copiedIds)
            .execute();
    const labelsByTarget = new Map(labels.map((label) => [label.target_id, label.label]));
    for (const entry of copiedEntries) {
      const label = labelsByTarget.get(entry.id);
      if (label === undefined) continue;
      const sequence = nextSequence++;
      await transaction
        .insertInto("pi_session_labels")
        .values({
          tenant_id: this.#tenantId,
          session_id: destinationId,
          target_id: entry.id,
          label,
          updated_seq: sequence,
        })
        .executeTakeFirst();
      await transaction
        .insertInto("pi_session_log")
        .values({
          tenant_id: this.#tenantId,
          session_id: destinationId,
          seq: sequence,
          kind: "fact",
          payload: { fact: "label", targetId: entry.id, label },
        })
        .executeTakeFirst();
    }

    await transaction
      .updateTable("pi_sessions")
      .set({ next_seq: nextSequence })
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", destinationId)
      .executeTakeFirstOrThrow();
  }
}
