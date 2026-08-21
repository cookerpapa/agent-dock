import type { Database } from "@pi-cloud/database";
import {
  parsePiCloudEvent,
  parseConversationTurnTranscriptResource,
  type PiCloudEvent,
  type PiCloudEventBody,
  type ConversationTurnTranscriptResource,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import type { LiveSessionEventStore } from "./live-session-event-store.ts";

export const TERMINAL_TURN_PROJECTION_PATH = "/internal/v1/terminal-turn-projections";

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

export function parsePrepareTerminalTurnProjectionInput(
  value: unknown,
): PrepareTerminalTurnProjectionInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Terminal Turn projection request is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const requiredIdentities = [
    "tenantId",
    "sessionId",
    "turnId",
    "commandId",
    "agentId",
    "eventId",
  ] as const;
  for (const field of requiredIdentities) {
    if (typeof candidate[field] !== "string" || candidate[field].length < 1) {
      throw new TypeError(`Terminal Turn projection ${field} is invalid`);
    }
  }
  if (typeof candidate.occurredAt !== "string" || candidate.occurredAt.length < 1) {
    throw new TypeError("Terminal Turn projection occurredAt is invalid");
  }
  if (typeof candidate.body !== "object" || candidate.body === null) {
    throw new TypeError("Terminal Turn projection body is invalid");
  }
  const event = parsePiCloudEvent({
    schemaVersion: 1,
    eventId: candidate.eventId,
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
    agentId: candidate.agentId,
    seq: 1,
    occurredAt: candidate.occurredAt,
    ...(candidate.body as Record<string, unknown>),
  });
  if (event.type !== "turn.failed" && event.type !== "turn.cancelled") {
    throw new TypeError("Interrupted Turn projection body is invalid");
  }
  return {
    tenantId: candidate.tenantId as string,
    sessionId: candidate.sessionId as string,
    turnId: candidate.turnId as string,
    commandId: candidate.commandId as string,
    agentId: candidate.agentId as string,
    body: { type: event.type, payload: event.payload } as TerminalEventBody,
    eventId: candidate.eventId as string,
    occurredAt: event.occurredAt,
  };
}

function nonNegativeSafeInteger(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${description} must be a non-negative safe integer`);
  }
  return value;
}

export function parsePreparedTerminalTurnProjection(
  value: unknown,
): PreparedTerminalTurnProjection {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Prepared terminal Turn projection is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    throw new TypeError("Prepared terminal Turn projection schema is invalid");
  }
  const previousSequence = nonNegativeSafeInteger(
    candidate.previousSequence,
    "Prepared terminal previous sequence",
  );
  const terminalEvent = parsePiCloudEvent(candidate.terminalEvent);
  if (terminalEvent.type !== "turn.failed" && terminalEvent.type !== "turn.cancelled") {
    throw new TypeError("Prepared interrupted Turn projection has an invalid event");
  }
  const transcript = parseConversationTurnTranscriptResource(candidate.transcript);
  if (
    terminalEvent.seq !== previousSequence + 1 ||
    transcript.throughSequence !== terminalEvent.seq ||
    transcript.terminalSequence !== terminalEvent.seq
  ) {
    throw new TypeError("Prepared terminal Turn projection sequence is inconsistent");
  }
  return { schemaVersion: 1, previousSequence, terminalEvent, transcript };
}

export class LiveTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #database: Kysely<Database>;
  readonly #liveEvents: LiveSessionEventStore;

  constructor(options: { database: Kysely<Database>; liveEvents: LiveSessionEventStore }) {
    this.#database = options.database;
    this.#liveEvents = options.liveEvents;
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
        "cursor.last_projected_seq as projectedThrough",
        "cursor.acknowledged_through_seq as acknowledgedThrough",
      ])
      .where("session_row.tenant_id", "=", input.tenantId)
      .where("session_row.id", "=", input.sessionId)
      .executeTakeFirst();
    if (state === undefined) throw new Error("Terminal Turn identity was not found");
    const nextSequence = Number(state.nextSequence);
    const previousSequence = Number(state.projectedThrough);
    if (
      !Number.isSafeInteger(nextSequence) ||
      !Number.isSafeInteger(previousSequence) ||
      nextSequence !== previousSequence + 1 ||
      Number(state.persistedThrough) !== previousSequence ||
      Number(state.acknowledgedThrough) !== previousSequence
    ) {
      throw new Error("Terminal Turn event stream is not fully projected");
    }
    const previousTerminal = await this.#database
      .selectFrom("session_terminal_events")
      .select((expression) => expression.fn.max<string>("seq").as("sequence"))
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .where("seq", "<=", String(previousSequence))
      .executeTakeFirstOrThrow();
    const turnRangeStart =
      previousTerminal.sequence === null
        ? 0
        : nonNegativeSafeInteger(
            Number(previousTerminal.sequence),
            "Previous terminal Turn sequence",
          );
    const terminalEvent = parsePiCloudEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      seq: nextSequence,
      occurredAt: input.occurredAt,
      ...input.body,
    });
    const events: PiCloudEvent[] = [];
    let cursor = turnRangeStart;
    while (cursor < previousSequence) {
      const page = await this.#liveEvents.readPage(
        input.tenantId,
        input.sessionId,
        cursor,
        previousSequence,
        500,
      );
      if (page.length === 0 || page[0]!.seq !== cursor + 1) {
        throw new Error(`Terminal Turn projection is missing live event ${cursor + 1}`);
      }
      for (const event of page) {
        if (event.seq !== cursor + 1) {
          throw new Error(`Terminal Turn projection is missing live event ${cursor + 1}`);
        }
        cursor = event.seq;
        if (event.turnId === input.turnId) events.push(event);
      }
    }
    const transcript = projectConversationTurnTranscript([...events, terminalEvent]);
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript,
    };
  }
}

export class HttpTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #endpoint: URL;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    serviceToken: string;
    fetchImplementation?: typeof fetch;
  }) {
    const base = new URL(options.baseUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password
    ) {
      throw new TypeError("Terminal projection service URL is invalid");
    }
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(options.serviceToken)) {
      throw new TypeError("Terminal projection service token is invalid");
    }
    this.#endpoint = new URL(TERMINAL_TURN_PROJECTION_PATH, base);
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { authorization: this.#authorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, ...input }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Terminal projection service returned HTTP ${response.status}`);
    return parsePreparedTerminalTurnProjection(await response.json());
  }
}
