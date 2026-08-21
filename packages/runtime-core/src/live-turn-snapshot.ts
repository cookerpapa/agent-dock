import type { Database } from "@pi-cloud/database";
import {
  parseLiveTurnSnapshotResource,
  parsePiCloudEvent,
  type LiveTurnSnapshotResource,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";

export interface LiveTurnSnapshotSource {
  read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource>;
}

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} is outside the non-negative safe integer range`);
  }
  return parsed;
}

/** Builds a reconnect snapshot directly from the durable PostgreSQL hot tail. */
export class PostgresLiveTurnSnapshotSource implements LiveTurnSnapshotSource {
  readonly #database: Kysely<Database>;

  constructor(options: { database: Kysely<Database> }) {
    this.#database = options.database;
  }

  async read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource> {
    const state = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .select("cursor.last_persisted_seq as persistedThrough")
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", sessionId)
      .executeTakeFirst();
    if (state === undefined) throw new Error("Live Turn Session was not found");
    const persistedThrough = safeSequence(state.persistedThrough, "Persisted event sequence");
    const activeTurn = await this.#database
      .selectFrom("turns as turn_row")
      .innerJoin("commands as command_row", (join) =>
        join
          .onRef("command_row.tenant_id", "=", "turn_row.tenant_id")
          .onRef("command_row.session_id", "=", "turn_row.session_id")
          .onRef("command_row.turn_id", "=", "turn_row.id"),
      )
      .select("turn_row.id as turnId")
      .where("turn_row.tenant_id", "=", tenantId)
      .where("turn_row.session_id", "=", sessionId)
      .where("turn_row.state", "not in", ["completed", "failed", "cancelled"])
      .where("command_row.kind", "=", "turn.execute")
      .orderBy("command_row.mailbox_position", "desc")
      .orderBy("command_row.id", "desc")
      .executeTakeFirst();
    if (activeTurn === undefined) {
      return { sessionId, replayAfterSequence: persistedThrough, turn: null };
    }

    const rows = await this.#database
      .selectFrom("session_events")
      .select([
        "event_id",
        "session_id",
        "turn_id",
        "agent_id",
        "seq",
        "schema_version",
        "type",
        "payload",
        "occurred_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("turn_id", "=", activeTurn.turnId)
      .where("seq", "<=", String(persistedThrough))
      .orderBy("seq", "asc")
      .execute();
    if (rows.length === 0) {
      return { sessionId, replayAfterSequence: persistedThrough, turn: null };
    }
    const events = rows.map((row) =>
      parsePiCloudEvent({
        schemaVersion: row.schema_version,
        eventId: row.event_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        agentId: row.agent_id,
        seq: safeSequence(row.seq, "Event sequence"),
        occurredAt: new Date(row.occurred_at).toISOString(),
        type: row.type,
        payload: row.payload,
      }),
    );
    return parseLiveTurnSnapshotResource({
      sessionId,
      replayAfterSequence: persistedThrough,
      turn: {
        turnId: activeTurn.turnId,
        transcript: projectConversationTurnTranscript(events),
      },
    });
  }
}
