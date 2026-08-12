import type { Database } from "@agent-dock/database";
import {
  parseLiveTurnSnapshotResource,
  type AgentDockEvent,
  type LiveTurnSnapshotResource,
} from "@agent-dock/protocol";
import type { Kysely } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import type { LiveSessionEventStore } from "./live-session-event-store.ts";

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

/**
 * Materializes the already-projected prefix of the current Turn. This is a
 * browser catch-up optimization only: PostgreSQL owns the watermark, Valkey
 * owns the retained payload and Pi's native Session remains model authority.
 */
export class ValkeyLiveTurnSnapshotSource implements LiveTurnSnapshotSource {
  readonly #database: Kysely<Database>;
  readonly #liveEvents: LiveSessionEventStore;

  constructor(options: { database: Kysely<Database>; liveEvents: LiveSessionEventStore }) {
    this.#database = options.database;
    this.#liveEvents = options.liveEvents;
  }

  async read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource> {
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
      const session = await this.#database
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (session === undefined) throw new Error("Live Turn Session was not found");
      return { sessionId, replayAfterSequence: 0, turn: null };
    }

    const cursor = await this.#database
      .selectFrom("session_event_cursors")
      .select(["last_projected_seq as projectedThrough", "replay_floor_seq as replayFloor"])
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const projectedThrough = safeSequence(cursor.projectedThrough, "Projected event sequence");
    const replayFloor = safeSequence(cursor.replayFloor, "Live replay floor");
    const terminalAtWatermark = await this.#database
      .selectFrom("session_terminal_events")
      .select("seq as sequence")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("seq", "=", String(projectedThrough))
      .executeTakeFirst();
    // Terminal events live in PostgreSQL rather than the retained Valkey
    // stream. A Run can settle between the active-Turn lookup and this cursor
    // read, so leave that terminal sequence for the following SSE catch-up.
    const liveThrough = terminalAtWatermark === undefined ? projectedThrough : projectedThrough - 1;
    const previousTerminal = await this.#database
      .selectFrom("session_terminal_events")
      .select((expression) => expression.fn.max<string>("seq").as("sequence"))
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("seq", "<=", String(liveThrough))
      .executeTakeFirstOrThrow();
    const rangeStart = Math.max(
      replayFloor,
      previousTerminal.sequence === null
        ? 0
        : safeSequence(previousTerminal.sequence, "Previous terminal event sequence"),
    );
    if (liveThrough <= rangeStart) {
      return { sessionId, replayAfterSequence: rangeStart, turn: null };
    }

    const turnEvents: AgentDockEvent[] = [];
    let sequence = rangeStart;
    while (sequence < liveThrough) {
      const page = await this.#liveEvents.readPage(tenantId, sessionId, sequence, liveThrough, 500);
      if (page.length === 0 || page[0]!.seq !== sequence + 1) {
        throw new Error(`Live Turn snapshot is missing event ${String(sequence + 1)}`);
      }
      for (const event of page) {
        if (event.seq !== sequence + 1) {
          throw new Error(`Live Turn snapshot is missing event ${String(sequence + 1)}`);
        }
        sequence = event.seq;
        if (event.turnId === activeTurn.turnId) turnEvents.push(event);
      }
    }
    if (turnEvents.length === 0) {
      return { sessionId, replayAfterSequence: rangeStart, turn: null };
    }
    return parseLiveTurnSnapshotResource({
      sessionId,
      replayAfterSequence: liveThrough,
      turn: {
        turnId: activeTurn.turnId,
        transcript: projectConversationTurnTranscript(turnEvents),
      },
    });
  }
}
