import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { SessionEventHub } from "./session-event-hub.ts";

export type DurableEventStoreErrorCode =
  | "not_found"
  | "invalid_event"
  | "event_conflict"
  | "sequence_gap"
  | "stale_fence"
  | "cursor_ahead"
  | "cursor_expired"
  | "event_store_invariant";

export class DurableEventStoreError extends Error {
  readonly code: DurableEventStoreErrorCode;
  readonly retryable: boolean;

  constructor(code: DurableEventStoreErrorCode, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "DurableEventStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type EventReplayWindow = {
  events: readonly PiCloudEvent[];
  highWaterMark: number;
};

export interface DurableEventIngestor {
  ingest(value: unknown): Promise<EventAckMessage>;
}

export interface DurableEventGroupIngestor extends DurableEventIngestor {
  ingestGroup(values: readonly unknown[]): Promise<readonly EventAckMessage[]>;
}

export interface DurableEventLog extends DurableEventIngestor {
  openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<EventReplayWindow>;
  readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit?: number,
  ): Promise<readonly PiCloudEvent[]>;
}

export type DurableEventStoreOptions = Readonly<{
  eventHub?: SessionEventHub;
  database?: Kysely<Database>;
}>;

/**
 * Deterministic process-local event log for unit/development composition. The
 * maintained production path injects KafkaLiveEventStore and never constructs
 * this class.
 */
export class DurableEventStore implements DurableEventLog, DurableEventGroupIngestor {
  readonly #events = new Map<string, PiCloudEvent[]>();
  readonly #database: Kysely<Database> | undefined;

  constructor(options: DurableEventStoreOptions = {}) {
    this.#database = options.database;
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    return (await this.ingestGroup([value]))[0]!;
  }

  async ingestGroup(values: readonly unknown[]): Promise<readonly EventAckMessage[]> {
    if (values.length < 1) {
      throw new DurableEventStoreError("invalid_event", "Event publication group was empty");
    }
    return values.map((value) => {
      const parsed = parseSupervisorToControlMessage(value);
      if (parsed.type !== "event.publish" && parsed.type !== "event.publish_batch") {
        throw new DurableEventStoreError("invalid_event", "Expected an event publication");
      }
      const publications: EventPublishMessage[] =
        parsed.type === "event.publish"
          ? [parsed]
          : parsed.payload.events.map((event) => ({
              protocolVersion: 1,
              messageId: parsed.messageId,
              sentAt: parsed.sentAt,
              type: "event.publish",
              payload: {
                leaseId: parsed.payload.leaseId,
                fencingToken: parsed.payload.fencingToken,
                runId: parsed.payload.runId,
                attemptId: parsed.payload.attemptId,
                ...(parsed.payload.commandId === undefined
                  ? {}
                  : { commandId: parsed.payload.commandId }),
                event,
              },
            }));
      for (const publication of publications) this.#append(publication.payload.event);
      const last = publications.at(-1)!;
      const acknowledgement = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: globalThis.crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        type: "event.ack",
        payload: {
          sessionId: last.payload.event.sessionId,
          leaseId: last.payload.leaseId,
          fencingToken: last.payload.fencingToken,
          acknowledgedThroughSeq: last.payload.event.seq,
        },
      });
      if (acknowledgement.type !== "event.ack") throw new Error("Invalid event ACK");
      return acknowledgement;
    });
  }

  async openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<EventReplayWindow> {
    await this.#assertSession(tenantId, sessionId);
    const events = this.#events.get(sessionId) ?? [];
    const highWaterMark = events.at(-1)?.seq ?? 0;
    if (afterSequence > highWaterMark) {
      throw new DurableEventStoreError("cursor_ahead", "Replay cursor is ahead of the event log");
    }
    return {
      events: events.filter((event) => event.seq > afterSequence).slice(0, limit),
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
    await this.#assertSession(tenantId, sessionId);
    return (this.#events.get(sessionId) ?? [])
      .filter((event) => event.seq > afterSequence && event.seq <= throughSequence)
      .slice(0, limit);
  }

  #append(event: PiCloudEvent): void {
    const events = this.#events.get(event.sessionId) ?? [];
    const existing = events.find((candidate) => candidate.seq === event.seq);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, event)) return;
      throw new DurableEventStoreError("event_conflict", "Event sequence was reused");
    }
    const previous = events.at(-1)?.seq ?? 0;
    if (event.seq !== previous + 1) {
      throw new DurableEventStoreError("sequence_gap", "Event stream contains a sequence gap");
    }
    events.push(event);
    this.#events.set(event.sessionId, events);
  }

  async #assertSession(tenantId: string, sessionId: string): Promise<void> {
    if (this.#database === undefined) return;
    const session = await this.#database
      .selectFrom("sessions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (session === undefined)
      throw new DurableEventStoreError("not_found", "Session was not found");
  }
}
