import type { Database } from "@pi-cloud/database";
import {
  parsePiCloudEvent,
  type PiCloudEvent,
  type PiCloudEventBody,
  type ConversationTurnTranscriptResource,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";

type TerminalEventBody = Extract<PiCloudEventBody, { type: "turn.failed" | "turn.cancelled" }>;

export type PrepareTerminalTurnProjectionInput = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
  agentId: string;
  body: TerminalEventBody;
  eventId: string;
  occurredAt: string;
}>;

export type PreparedTerminalTurnProjection = Readonly<{
  schemaVersion: 1;
  previousSequence: number;
  terminalEvent: PiCloudEvent;
  transcript: ConversationTurnTranscriptResource;
}>;

export interface TerminalTurnProjectionSource {
  prepare(input: PrepareTerminalTurnProjectionInput): Promise<PreparedTerminalTurnProjection>;
}

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} is outside the non-negative safe integer range`);
  }
  return parsed;
}

/**
 * Reads the durable PostgreSQL hot tail when a failed/cancelled Run needs to
 * preserve text that reached the browser before Pi emitted message_end.
 * Successful Runs use the complete Pi message already in SessionStorage.
 */
export class PostgresTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #database: Kysely<Database>;

  constructor(options: { database: Kysely<Database> }) {
    this.#database = options.database;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const state = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .innerJoin("turns as turn_row", (join) =>
        join
          .onRef("turn_row.session_id", "=", "session_row.id")
          .on("turn_row.id", "=", input.turnId),
      )
      .innerJoin("commands as command_row", (join) =>
        join
          .onRef("command_row.session_id", "=", "session_row.id")
          .onRef("command_row.turn_id", "=", "turn_row.id")
          .on("command_row.id", "=", input.commandId),
      )
      .select([
        "session_row.next_event_seq as nextSequence",
        "cursor.last_persisted_seq as persistedThrough",
      ])
      .where("session_row.tenant_id", "=", input.tenantId)
      .where("session_row.id", "=", input.sessionId)
      .executeTakeFirst();
    if (state === undefined) throw new Error("Terminal Turn identity was not found");

    const previousSequence = safeSequence(state.persistedThrough, "Persisted event sequence");
    if (safeSequence(state.nextSequence, "Next event sequence") !== previousSequence + 1) {
      throw new Error("Terminal Turn event stream is not a committed PostgreSQL prefix");
    }

    const terminalEvent = parsePiCloudEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      seq: previousSequence + 1,
      occurredAt: input.occurredAt,
      ...input.body,
    });
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
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .where("turn_id", "=", input.turnId)
      .where("seq", "<=", String(previousSequence))
      .orderBy("seq", "asc")
      .execute();
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
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript: projectConversationTurnTranscript([...events, terminalEvent]),
    };
  }
}
