import type { Database } from "@agent-dock/database";
import {
  parseAgentDockEvent,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type AgentDockEvent,
  type EventAckMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { SessionEventHub } from "./session-event-hub.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";

const DEFAULT_REPLAY_PAGE_SIZE = 500;

export type DurableEventStoreErrorCode =
  | "not_found"
  | "invalid_event"
  | "event_conflict"
  | "sequence_gap"
  | "stale_fence"
  | "cursor_ahead"
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

export type DurableEventStoreOptions = {
  database: Kysely<Database>;
  eventHub?: SessionEventHub;
  eventNotificationPublisher?: SessionEventNotificationPublisher;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type EventReplayWindow = {
  events: readonly AgentDockEvent[];
  highWaterMark: number;
};

export interface DurableEventIngestor {
  ingest(value: unknown): Promise<EventAckMessage>;
}

type PersistedEventRow = {
  event_id: string;
  session_id: string;
  turn_id: string | null;
  agent_id: string;
  command_id: string | null;
  seq: string;
  schema_version: number;
  type: string;
  payload: Record<string, unknown>;
  lease_id: string;
  fencing_token: string;
  occurred_at: Date;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("durable event store clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DurableEventStoreError(
      "event_store_invariant",
      `${name} is outside the supported integer range`,
    );
  }
  return parsed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function expectOne(changedRows: bigint, description: string): void {
  if (changedRows !== 1n) {
    throw new DurableEventStoreError(
      "event_store_invariant",
      `${description} changed ${changedRows} rows`,
    );
  }
}

function normalizedUuid(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toLowerCase();
}

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Persisted event timestamp is invalid",
    );
  }
  return parsed.toISOString();
}

function eventFromRow(row: PersistedEventRow): AgentDockEvent {
  return parseAgentDockEvent({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    seq: safeInteger(row.seq, "persisted event sequence"),
    occurredAt: isoTimestamp(row.occurred_at),
    type: row.type,
    payload: row.payload,
  });
}

function isExactRedelivery(row: PersistedEventRow, message: EventPublishMessage): boolean {
  const event = message.payload.event;
  return (
    normalizedUuid(row.event_id) === normalizedUuid(event.eventId) &&
    normalizedUuid(row.session_id) === normalizedUuid(event.sessionId) &&
    normalizedUuid(row.turn_id) === normalizedUuid(event.turnId) &&
    row.agent_id === event.agentId &&
    safeInteger(row.seq, "persisted event sequence") === event.seq &&
    row.schema_version === event.schemaVersion &&
    row.type === event.type &&
    isDeepStrictEqual(row.payload, event.payload) &&
    normalizedUuid(row.command_id) === normalizedUuid(message.payload.commandId) &&
    normalizedUuid(row.lease_id) === normalizedUuid(message.payload.leaseId) &&
    safeInteger(row.fencing_token, "persisted event fence") === message.payload.fencingToken &&
    isoTimestamp(row.occurred_at) === event.occurredAt
  );
}

function eventSelect() {
  return [
    "event_id",
    "session_id",
    "turn_id",
    "agent_id",
    "command_id",
    "seq",
    "schema_version",
    "type",
    "payload",
    "lease_id",
    "fencing_token",
    "occurred_at",
  ] as const;
}

export class DurableEventStore implements DurableEventIngestor {
  readonly #database: Kysely<Database>;
  readonly #eventHub: SessionEventHub | undefined;
  readonly #eventNotificationPublisher: SessionEventNotificationPublisher | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: DurableEventStoreOptions) {
    this.#database = options.database;
    this.#eventHub = options.eventHub;
    this.#eventNotificationPublisher = options.eventNotificationPublisher;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "event.publish") {
      throw new DurableEventStoreError("invalid_event", "Expected an event publication");
    }
    const now = validDate(this.#clock);
    const result = await this.#database.transaction().execute(async (transaction) => {
      const ingested = await this.#ingestTransaction(transaction, parsed, now);
      await this.#eventNotificationPublisher?.publish(transaction, {
        schemaVersion: 1,
        tenantId: ingested.tenantId,
        sessionId: parsed.payload.event.sessionId,
        throughSequence: ingested.acknowledgedThroughSeq,
      });
      return ingested;
    });
    this.#eventHub?.notifyThrough(
      result.tenantId,
      parsed.payload.event.sessionId,
      result.acknowledgedThroughSeq,
    );
    return this.#acknowledgement(parsed, result.acknowledgedThroughSeq, now);
  }

  async openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    pageSize = DEFAULT_REPLAY_PAGE_SIZE,
  ): Promise<EventReplayWindow> {
    positiveInteger(pageSize, "pageSize");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer");
    }
    const cursor = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .select("cursor.last_persisted_seq as highWaterMark")
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", sessionId)
      .executeTakeFirst();
    if (cursor === undefined) {
      throw new DurableEventStoreError("not_found", "Session event stream was not found");
    }
    const highWaterMark = safeInteger(cursor.highWaterMark, "session event high-water mark");
    if (afterSequence > highWaterMark) {
      throw new DurableEventStoreError(
        "cursor_ahead",
        "Last-Event-ID is ahead of the durable session event stream",
      );
    }
    return {
      events: await this.readReplayPage(
        tenantId,
        sessionId,
        afterSequence,
        highWaterMark,
        pageSize,
      ),
      highWaterMark,
    };
  }

  async readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    pageSize = DEFAULT_REPLAY_PAGE_SIZE,
  ): Promise<readonly AgentDockEvent[]> {
    positiveInteger(pageSize, "pageSize");
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(throughSequence) ||
      throughSequence < afterSequence
    ) {
      throw new TypeError("replay sequence bounds are invalid");
    }
    const rows = await this.#database
      .selectFrom("session_events")
      .select(eventSelect())
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("seq", ">", String(afterSequence))
      .where("seq", "<=", String(throughSequence))
      .orderBy("seq", "asc")
      .limit(pageSize)
      .execute();
    return rows.map((row) => eventFromRow(row));
  }

  async #ingestTransaction(
    transaction: Transaction<Database>,
    message: EventPublishMessage,
    now: Date,
  ): Promise<{ tenantId: string; acknowledgedThroughSeq: number }> {
    const event = message.payload.event;
    const session = await transaction
      .selectFrom("sessions")
      .select(["tenant_id", "next_event_seq", "last_fencing_token"])
      .where("id", "=", event.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (session === undefined) {
      throw new DurableEventStoreError("not_found", "Event session was not found");
    }
    const tenantId = session.tenant_id;
    const cursor = await transaction
      .selectFrom("session_event_cursors")
      .select(["last_persisted_seq", "acknowledged_through_seq"])
      .where("session_id", "=", event.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (cursor === undefined) {
      throw new DurableEventStoreError("event_store_invariant", "Session event cursor is missing");
    }

    const lastPersisted = safeInteger(cursor.last_persisted_seq, "last persisted sequence");
    const acknowledged = safeInteger(
      cursor.acknowledged_through_seq,
      "acknowledged event sequence",
    );
    if (acknowledged !== lastPersisted) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Durable event cursor is not a fully ACK-eligible prefix",
      );
    }

    if (event.seq <= lastPersisted) {
      const existing = await transaction
        .selectFrom("session_events")
        .select(eventSelect())
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", event.sessionId)
        .where("seq", "=", String(event.seq))
        .executeTakeFirst();
      if (existing === undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Durable event prefix contains a missing sequence",
        );
      }
      if (!isExactRedelivery(existing, message)) {
        throw new DurableEventStoreError(
          "event_conflict",
          `Conflicting event publication at sequence ${event.seq}`,
        );
      }
      return { tenantId, acknowledgedThroughSeq: event.seq };
    }

    const expectedSequence = lastPersisted + 1;
    const sessionNextSequence = safeInteger(session.next_event_seq, "session next event sequence");
    if (event.seq !== expectedSequence || event.seq !== sessionNextSequence) {
      throw new DurableEventStoreError(
        "sequence_gap",
        `Expected contiguous event sequence ${expectedSequence}, received ${event.seq}`,
      );
    }

    await this.#validateEventOwnership(transaction, tenantId, message);
    const lease = await transaction
      .selectFrom("session_leases")
      .select(["lease_id", "fencing_token", "valid_until"])
      .where("session_id", "=", event.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      lease === undefined ||
      normalizedUuid(lease.lease_id) !== normalizedUuid(message.payload.leaseId) ||
      safeInteger(lease.fencing_token, "lease fencing token") !== message.payload.fencingToken ||
      safeInteger(session.last_fencing_token, "session fencing token") !==
        message.payload.fencingToken ||
      new Date(lease.valid_until).valueOf() <= now.valueOf()
    ) {
      throw new DurableEventStoreError("stale_fence", "Event publication lease is stale");
    }

    const reusedEventId = await transaction
      .selectFrom("session_events")
      .select(["session_id", "seq"])
      .where("event_id", "=", event.eventId)
      .executeTakeFirst();
    if (reusedEventId !== undefined) {
      throw new DurableEventStoreError(
        "event_conflict",
        "Event ID was already used by another sequence",
      );
    }

    await transaction
      .insertInto("session_events")
      .values({
        event_id: event.eventId,
        tenant_id: tenantId,
        session_id: event.sessionId,
        turn_id: event.turnId,
        agent_node_id: null,
        agent_id: event.agentId,
        command_id: message.payload.commandId ?? null,
        seq: event.seq,
        schema_version: event.schemaVersion,
        type: event.type,
        payload: event.payload,
        lease_id: message.payload.leaseId,
        fencing_token: message.payload.fencingToken,
        occurred_at: new Date(event.occurredAt),
        persisted_at: now,
      })
      .executeTakeFirstOrThrow();

    const cursorUpdate = await transaction
      .updateTable("session_event_cursors")
      .set({
        last_persisted_seq: event.seq,
        acknowledged_through_seq: event.seq,
        updated_at: now,
      })
      .where("session_id", "=", event.sessionId)
      .where("last_persisted_seq", "=", cursor.last_persisted_seq)
      .where("acknowledged_through_seq", "=", cursor.acknowledged_through_seq)
      .executeTakeFirst();
    expectOne(cursorUpdate.numUpdatedRows, "advancing the event cursor");

    const sessionUpdate = await transaction
      .updateTable("sessions")
      .set({
        next_event_seq: event.seq + 1,
        row_version: sql<string>`${sql.ref("row_version")} + 1`,
        updated_at: now,
        last_active_at: now,
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", event.sessionId)
      .where("next_event_seq", "=", session.next_event_seq)
      .executeTakeFirst();
    expectOne(sessionUpdate.numUpdatedRows, "advancing the session event sequence");

    return { tenantId, acknowledgedThroughSeq: event.seq };
  }

  async #validateEventOwnership(
    transaction: Transaction<Database>,
    tenantId: string,
    message: EventPublishMessage,
  ): Promise<void> {
    const event = message.payload.event;
    if (event.turnId === null) {
      if (message.payload.commandId !== undefined) {
        throw new DurableEventStoreError(
          "invalid_event",
          "A session-level event cannot reference a turn command",
        );
      }
      return;
    }

    const turn = await transaction
      .selectFrom("turns")
      .select(["id", "state"])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("id", "=", event.turnId)
      .executeTakeFirst();
    if (turn === undefined) {
      throw new DurableEventStoreError("invalid_event", "Event turn does not belong to session");
    }
    if (
      turn.state === "cancelling" &&
      (event.type === "turn.completed" || event.type === "turn.failed")
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "A cancelling turn cannot publish a completion or failure terminal event",
      );
    }
    if (event.type === "turn.cancelled" && turn.state !== "cancelling") {
      throw new DurableEventStoreError(
        "invalid_event",
        "A cancellation terminal event requires a cancelling turn",
      );
    }

    if (message.payload.commandId === undefined) return;
    const command = await transaction
      .selectFrom("commands")
      .select(["id", "state"])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("turn_id", "=", event.turnId)
      .where("id", "=", message.payload.commandId)
      .executeTakeFirst();
    if (command === undefined || command.state !== "acknowledged") {
      throw new DurableEventStoreError(
        "invalid_event",
        "Event command is not the acknowledged command for this turn",
      );
    }
  }

  #acknowledgement(
    message: EventPublishMessage,
    acknowledgedThroughSeq: number,
    now: Date,
  ): EventAckMessage {
    const parsed = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: now.toISOString(),
      type: "event.ack",
      payload: {
        sessionId: message.payload.event.sessionId,
        leaseId: message.payload.leaseId,
        fencingToken: message.payload.fencingToken,
        acknowledgedThroughSeq,
      },
    });
    if (parsed.type !== "event.ack") {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Constructed event acknowledgement was invalid",
      );
    }
    return parsed;
  }
}
