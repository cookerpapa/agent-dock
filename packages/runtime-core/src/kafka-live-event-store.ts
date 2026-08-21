import type { Database } from "@pi-cloud/database";
import {
  parseLiveTurnSnapshotResource,
  parsePiCloudEvent,
  type EventAckMessage,
  type EventPublishMessage,
  type LiveTurnSnapshotResource,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import {
  DurableEventStoreError,
  type DurableEventLog,
  type EventReplayWindow,
} from "./durable-event-store.ts";
import type { KafkaAcceptedAgentEventEnvelope } from "./kafka-agent-event-log.ts";
import type { LiveTurnSnapshotSource } from "./live-turn-snapshot.ts";
import type { SessionEventHub } from "./session-event-hub.ts";
import type {
  PrepareTerminalTurnProjectionInput,
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

type SessionBuffer = {
  tenantId: string;
  sessionId: string;
  floorSequence: number;
  events: PiCloudEvent[];
};

export type KafkaLiveEventStoreOptions = Readonly<{
  database: Kysely<Database>;
  eventHub?: SessionEventHub;
  maximumEventsPerSession?: number;
  maximumSessions?: number;
}>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function eventPublications(
  envelope: KafkaAcceptedAgentEventEnvelope,
): readonly EventPublishMessage[] {
  return envelope.publications.flatMap((publication) =>
    publication.type === "event.publish"
      ? [publication]
      : publication.payload.events.map((event): EventPublishMessage => ({
          protocolVersion: 1,
          messageId: publication.messageId,
          sentAt: publication.sentAt,
          type: "event.publish",
          payload: {
            leaseId: publication.payload.leaseId,
            fencingToken: publication.payload.fencingToken,
            runId: publication.payload.runId,
            attemptId: publication.payload.attemptId,
            ...(publication.payload.commandId === undefined
              ? {}
              : { commandId: publication.payload.commandId }),
            event,
          },
        })),
  );
}

/**
 * Bounded in-process projection of the retained accepted Kafka log. Kafka is
 * the durable replay authority; this projection is rebuilt before a Gateway
 * replica becomes ready and contains no canonical conversation copy.
 */
export class KafkaLiveEventStore implements DurableEventLog {
  readonly #database: Kysely<Database>;
  readonly #eventHub: SessionEventHub | undefined;
  readonly #maximumEventsPerSession: number;
  readonly #maximumSessions: number;
  readonly #buffers = new Map<string, SessionBuffer>();

  constructor(options: KafkaLiveEventStoreOptions) {
    this.#database = options.database;
    this.#eventHub = options.eventHub;
    this.#maximumEventsPerSession = positiveInteger(
      options.maximumEventsPerSession ?? 8_192,
      "maximumEventsPerSession",
    );
    this.#maximumSessions = positiveInteger(options.maximumSessions ?? 10_000, "maximumSessions");
  }

  async ingest(_value: unknown): Promise<EventAckMessage> {
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Accepted Kafka replay projection cannot ingest Worker events directly",
    );
  }

  append(envelope: KafkaAcceptedAgentEventEnvelope): void {
    for (const publication of eventPublications(envelope)) {
      // The accepted-topic consumer already validates the complete public
      // protocol. Avoid a third schema walk on the latency-sensitive SSE path.
      const event = publication.payload.event;
      const key = this.#key(envelope.tenantId, event.sessionId);
      let buffer = this.#buffers.get(key);
      if (buffer === undefined) {
        if (this.#buffers.size >= this.#maximumSessions) {
          const oldest = this.#buffers.keys().next().value as string | undefined;
          if (oldest !== undefined) this.#buffers.delete(oldest);
        }
        buffer = {
          tenantId: envelope.tenantId,
          sessionId: event.sessionId,
          floorSequence: event.seq - 1,
          events: [],
        };
        this.#buffers.set(key, buffer);
      }
      const last = buffer.events.at(-1);
      if (last !== undefined && event.seq <= last.seq) {
        const existing = buffer.events.find((candidate) => candidate.seq === event.seq);
        if (existing !== undefined && isDeepStrictEqual(existing, event)) continue;
        throw new DurableEventStoreError(
          "event_conflict",
          "Accepted Kafka event reused a live sequence with different content",
        );
      }
      if (last !== undefined && event.seq !== last.seq + 1) {
        throw new DurableEventStoreError(
          "sequence_gap",
          "Accepted Kafka event stream contains a sequence gap",
        );
      }
      buffer.events.push(event);
      while (buffer.events.length > this.#maximumEventsPerSession) {
        const removed = buffer.events.shift()!;
        buffer.floorSequence = removed.seq;
      }
      this.#eventHub?.publish(envelope.tenantId, event);
    }
  }

  async openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<EventReplayWindow> {
    const state = await this.#sessionState(tenantId, sessionId);
    const buffer = this.#buffers.get(this.#key(tenantId, sessionId));
    const highWaterMark = Math.max(
      state.canonicalThrough,
      buffer?.events.at(-1)?.seq ?? buffer?.floorSequence ?? 0,
    );
    const floorSequence = buffer?.floorSequence ?? state.canonicalThrough;
    if (afterSequence < floorSequence) {
      throw new DurableEventStoreError(
        "cursor_expired",
        "The retained Kafka replay window no longer contains this cursor",
      );
    }
    if (afterSequence > highWaterMark) {
      throw new DurableEventStoreError("cursor_ahead", "Replay cursor is ahead of the event log");
    }
    return {
      events: (buffer?.events ?? [])
        .filter((event) => event.seq > afterSequence)
        .slice(0, positiveInteger(limit, "limit")),
      highWaterMark,
    };
  }

  async readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit = 500,
  ): Promise<readonly PiCloudEvent[]> {
    await this.#sessionState(tenantId, sessionId);
    const buffer = this.#buffers.get(this.#key(tenantId, sessionId));
    if (buffer === undefined || afterSequence < buffer.floorSequence) {
      throw new DurableEventStoreError(
        "cursor_expired",
        "The retained Kafka replay window no longer contains this cursor",
      );
    }
    return buffer.events
      .filter((event) => event.seq > afterSequence && event.seq <= throughSequence)
      .slice(0, positiveInteger(limit, "limit"));
  }

  async readTurn(
    tenantId: string,
    sessionId: string,
    turnId: string,
  ): Promise<readonly PiCloudEvent[]> {
    await this.#sessionState(tenantId, sessionId);
    return (this.#buffers.get(this.#key(tenantId, sessionId))?.events ?? []).filter(
      (event) => event.turnId === turnId,
    );
  }

  #key(tenantId: string, sessionId: string): string {
    return `${tenantId}\0${sessionId}`;
  }

  async #sessionState(tenantId: string, sessionId: string): Promise<{ canonicalThrough: number }> {
    const row = await this.#database
      .selectFrom("sessions")
      .select("next_event_seq")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (row === undefined) throw new DurableEventStoreError("not_found", "Session was not found");
    const next = Number(row.next_event_seq);
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Session event sequence is invalid",
      );
    }
    return { canonicalThrough: next - 1 };
  }
}

export class KafkaLiveTurnSnapshotSource implements LiveTurnSnapshotSource {
  readonly #database: Kysely<Database>;
  readonly #events: KafkaLiveEventStore;

  constructor(options: { database: Kysely<Database>; events: KafkaLiveEventStore }) {
    this.#database = options.database;
    this.#events = options.events;
  }

  async read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource> {
    const activeTurn = await this.#database
      .selectFrom("turns")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("state", "not in", ["completed", "failed", "cancelled"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const replay = await this.#events
      .openReplayWindow(tenantId, sessionId, 0)
      .catch((error: unknown) => {
        if (error instanceof DurableEventStoreError && error.code === "cursor_expired") {
          return { events: [], highWaterMark: 0 } satisfies EventReplayWindow;
        }
        throw error;
      });
    if (activeTurn === undefined) {
      return parseLiveTurnSnapshotResource({
        sessionId,
        replayAfterSequence: replay.highWaterMark,
        turn: null,
      });
    }
    const events = await this.#events.readTurn(tenantId, sessionId, activeTurn.id);
    return parseLiveTurnSnapshotResource({
      sessionId,
      replayAfterSequence: events.at(-1)?.seq ?? replay.highWaterMark,
      turn:
        events.length === 0
          ? null
          : { turnId: activeTurn.id, transcript: projectConversationTurnTranscript(events) },
    });
  }
}

export class KafkaTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #events: KafkaLiveEventStore;

  constructor(options: { events: KafkaLiveEventStore }) {
    this.#events = options.events;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const events = await this.#events.readTurn(input.tenantId, input.sessionId, input.turnId);
    if (events.length === 0) throw new Error("No accepted Kafka live prefix is available");
    const previousSequence = events.at(-1)?.seq ?? 0;
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
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript: projectConversationTurnTranscript([...events, terminalEvent]),
    };
  }
}
