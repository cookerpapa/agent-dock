import type { Database } from "@agent-dock/database";
import {
  parseAgentDockEvent,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type AgentDockEvent,
  type EventAckMessage,
  type EventPublishBatchMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionEventHub } from "./session-event-hub.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";
import { classifyStructuredTestCommand } from "./structured-test-command.ts";
import type { WorkerEventLogEnvelope, WorkerEventProjectionSink } from "./worker-event-log.ts";

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
  externalWorkerEventLog?: boolean;
};

export type EventReplayWindow = {
  events: readonly AgentDockEvent[];
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
  ): Promise<readonly AgentDockEvent[]>;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function eventContentSha256(tenantId: string, message: EventPublishMessage): string {
  return createHash("sha256")
    .update("agent-dock.worker-event.v1\0", "utf8")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(message), "utf8")
    .digest("hex");
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

type PreparedPublication = {
  publications: readonly EventPublishMessage[];
  last: EventPublishMessage;
};

export class DurableEventStore
  implements DurableEventLog, DurableEventGroupIngestor, WorkerEventProjectionSink
{
  readonly #database: Kysely<Database>;
  readonly #eventHub: SessionEventHub | undefined;
  readonly #eventNotificationPublisher: SessionEventNotificationPublisher | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #externalWorkerEventLog: boolean;

  constructor(options: DurableEventStoreOptions) {
    this.#database = options.database;
    this.#eventHub = options.eventHub;
    this.#eventNotificationPublisher = options.eventNotificationPublisher;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#externalWorkerEventLog = options.externalWorkerEventLog ?? false;
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    const acknowledgement = (await this.ingestGroup([value]))[0];
    if (acknowledgement === undefined) {
      throw new DurableEventStoreError("event_store_invariant", "Event acknowledgement is missing");
    }
    return acknowledgement;
  }

  async ingestGroup(values: readonly unknown[]): Promise<readonly EventAckMessage[]> {
    if (values.length < 1) {
      throw new DurableEventStoreError("invalid_event", "Event publication group was empty");
    }
    const prepared = values.map((value) => this.#prepare(value));
    const now = validDate(this.#clock);
    const results = await this.#database.transaction().execute(async (transaction) => {
      const ingested = await this.#ingestPreparedGroupTransaction(transaction, prepared, now);
      const notifications = ingested.map((result, index) => {
        const publication = prepared[index]!;
        return {
          schemaVersion: 1,
          tenantId: result.tenantId,
          sessionId: publication.last.payload.event.sessionId,
          throughSequence: result.acknowledgedThroughSeq,
        } as const;
      });
      if (
        !this.#externalWorkerEventLog &&
        this.#eventNotificationPublisher?.publishGroup !== undefined
      ) {
        await this.#eventNotificationPublisher.publishGroup(transaction, notifications);
      } else if (!this.#externalWorkerEventLog) {
        for (const notification of notifications) {
          await this.#eventNotificationPublisher?.publish(transaction, notification);
        }
      }
      return ingested;
    });
    return prepared.map((publication, index) => {
      const result = results[index];
      if (result === undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Grouped event acknowledgement is missing",
        );
      }
      if (!this.#externalWorkerEventLog) {
        this.#eventHub?.notifyThrough(
          result.tenantId,
          publication.last.payload.event.sessionId,
          result.acknowledgedThroughSeq,
        );
      }
      return this.#acknowledgement(publication.last, result.acknowledgedThroughSeq, now);
    });
  }

  #prepare(value: unknown): PreparedPublication {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "event.publish" && parsed.type !== "event.publish_batch") {
      throw new DurableEventStoreError("invalid_event", "Expected an event publication");
    }
    const publications = this.#publications(parsed);
    if (
      publications.some(
        ({ payload }) =>
          payload.event.type === "turn.completed" ||
          payload.event.type === "turn.failed" ||
          payload.event.type === "turn.cancelled",
      )
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Terminal Turn events are committed only by the Control Plane",
      );
    }
    const last = publications.at(-1);
    if (publications[0] === undefined || last === undefined) {
      throw new DurableEventStoreError("invalid_event", "Event batch was empty");
    }
    return { publications, last };
  }

  #publications(
    message: EventPublishMessage | EventPublishBatchMessage,
  ): readonly EventPublishMessage[] {
    if (message.type === "event.publish") return [message];
    const events = message.payload.events;
    const first = events[0];
    if (first === undefined) {
      throw new DurableEventStoreError("invalid_event", "Event batch was empty");
    }
    for (const [index, event] of events.entries()) {
      if (
        event.sessionId !== first.sessionId ||
        event.turnId !== first.turnId ||
        event.agentId !== first.agentId ||
        event.seq !== first.seq + index
      ) {
        throw new DurableEventStoreError(
          "invalid_event",
          "Event batch identity or sequence was not contiguous",
        );
      }
    }
    return events.map((event) => ({
      protocolVersion: 1,
      messageId: message.messageId,
      sentAt: message.sentAt,
      type: "event.publish",
      payload: {
        leaseId: message.payload.leaseId,
        fencingToken: message.payload.fencingToken,
        ...(message.payload.commandId === undefined
          ? {}
          : { commandId: message.payload.commandId }),
        event,
      },
    }));
  }

  async #ingestPreparedGroupTransaction(
    transaction: Transaction<Database>,
    prepared: readonly PreparedPublication[],
    now: Date,
  ): Promise<readonly { tenantId: string; acknowledgedThroughSeq: number }[]> {
    if (prepared.length === 1 && !this.#externalWorkerEventLog) {
      return [await this.#ingestBatchTransaction(transaction, prepared[0]!.publications, now)];
    }
    const sessionIds = prepared.map(
      (publication) => publication.publications[0]!.payload.event.sessionId,
    );
    if (new Set(sessionIds).size !== sessionIds.length) {
      const results = [];
      for (const publication of prepared) {
        if (this.#externalWorkerEventLog) {
          results.push(
            ...(await this.#ingestPreparedGroupTransaction(transaction, [publication], now)),
          );
        } else {
          results.push(
            await this.#ingestBatchTransaction(transaction, publication.publications, now),
          );
        }
      }
      return results;
    }
    const sortedSessionIds = [...sessionIds].sort();
    const sessions = await transaction
      .selectFrom("sessions")
      .select(["id", "tenant_id", "next_event_seq", "last_fencing_token"])
      .where("id", "in", sortedSessionIds)
      .orderBy("id", "asc")
      .forUpdate()
      .execute();
    const cursors = await transaction
      .selectFrom("session_event_cursors")
      .select(["session_id", "last_persisted_seq", "acknowledged_through_seq"])
      .where("session_id", "in", sortedSessionIds)
      .orderBy("session_id", "asc")
      .forUpdate()
      .execute();
    const leases = await transaction
      .selectFrom("session_leases")
      .select(["session_id", "lease_id", "fencing_token", "valid_until"])
      .where("session_id", "in", sortedSessionIds)
      .orderBy("session_id", "asc")
      .forUpdate()
      .execute();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const cursorBySession = new Map(cursors.map((cursor) => [cursor.session_id, cursor]));
    const leaseBySession = new Map(leases.map((lease) => [lease.session_id, lease]));

    const turnIds = [
      ...new Set(
        prepared
          .map((publication) => publication.publications[0]!.payload.event.turnId)
          .filter((turnId): turnId is string => turnId !== null),
      ),
    ];
    const turns =
      turnIds.length === 0
        ? []
        : await transaction
            .selectFrom("turns")
            .select(["id", "tenant_id", "session_id", "state"])
            .where("id", "in", turnIds)
            .execute();
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    const commandIds = [
      ...new Set(
        prepared
          .map((publication) => publication.publications[0]!.payload.commandId)
          .filter((commandId): commandId is string => commandId !== undefined),
      ),
    ];
    const commands =
      commandIds.length === 0
        ? []
        : await transaction
            .selectFrom("commands")
            .select(["id", "tenant_id", "session_id", "turn_id", "state"])
            .where("id", "in", commandIds)
            .execute();
    const commandById = new Map(commands.map((command) => [command.id, command]));

    const advances: Array<{
      sessionId: string;
      expectedLast: number;
      expectedNext: number;
      acknowledgedThrough: number;
    }> = [];
    const newPublications: EventPublishMessage[] = [];
    const results: Array<{ tenantId: string; acknowledgedThroughSeq: number }> = [];
    for (const publication of prepared) {
      const messages = publication.publications;
      const first = messages[0]!;
      const firstEvent = first.payload.event;
      const session = sessionById.get(firstEvent.sessionId);
      const cursor = cursorBySession.get(firstEvent.sessionId);
      const lease = leaseBySession.get(firstEvent.sessionId);
      if (session === undefined) {
        throw new DurableEventStoreError("not_found", "Event session was not found");
      }
      if (cursor === undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Session event cursor is missing",
        );
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
      if (
        lease === undefined ||
        normalizedUuid(lease.lease_id) !== normalizedUuid(first.payload.leaseId) ||
        safeInteger(lease.fencing_token, "lease fencing token") !== first.payload.fencingToken ||
        safeInteger(session.last_fencing_token, "session fencing token") !==
          first.payload.fencingToken ||
        new Date(lease.valid_until).valueOf() <= now.valueOf()
      ) {
        throw new DurableEventStoreError("stale_fence", "Event publication lease is stale");
      }
      const turnId = firstEvent.turnId;
      if (turnId === null) {
        if (first.payload.commandId !== undefined) {
          throw new DurableEventStoreError(
            "invalid_event",
            "A session-level event cannot reference a turn command",
          );
        }
      } else {
        const turn = turnById.get(turnId);
        if (
          turn === undefined ||
          turn.tenant_id !== session.tenant_id ||
          turn.session_id !== firstEvent.sessionId
        ) {
          throw new DurableEventStoreError(
            "invalid_event",
            "Event turn does not belong to session",
          );
        }
        if (first.payload.commandId !== undefined) {
          const command = commandById.get(first.payload.commandId);
          if (
            command === undefined ||
            command.tenant_id !== session.tenant_id ||
            command.session_id !== firstEvent.sessionId ||
            command.turn_id !== turnId ||
            command.state !== "acknowledged"
          ) {
            throw new DurableEventStoreError(
              "invalid_event",
              "Event command is not the acknowledged command for this turn",
            );
          }
        }
      }

      const redeliveries = messages.filter((message) => message.payload.event.seq <= lastPersisted);
      await this.#verifyRedeliveries(
        transaction,
        session.tenant_id,
        firstEvent.sessionId,
        redeliveries,
      );
      const newMessages = messages.filter((message) => message.payload.event.seq > lastPersisted);
      if (newMessages.length > 0) {
        const firstNewSequence = newMessages[0]!.payload.event.seq;
        const expectedSequence = lastPersisted + 1;
        const sessionNextSequence = safeInteger(
          session.next_event_seq,
          "session next event sequence",
        );
        if (firstNewSequence !== expectedSequence || firstNewSequence !== sessionNextSequence) {
          throw new DurableEventStoreError(
            "sequence_gap",
            `Expected contiguous event sequence ${expectedSequence}, received ${firstNewSequence}`,
          );
        }
        const throughSequence = newMessages.at(-1)!.payload.event.seq;
        advances.push({
          sessionId: firstEvent.sessionId,
          expectedLast: lastPersisted,
          expectedNext: sessionNextSequence,
          acknowledgedThrough: throughSequence,
        });
        newPublications.push(...newMessages);
      }
      results.push({
        tenantId: session.tenant_id,
        acknowledgedThroughSeq: publication.last.payload.event.seq,
      });
    }

    const eventIds = newPublications.map((message) => message.payload.event.eventId);
    if (new Set(eventIds.map((eventId) => eventId.toLowerCase())).size !== eventIds.length) {
      throw new DurableEventStoreError("event_conflict", "Event ID was reused inside one group");
    }
    if (eventIds.length > 0) {
      const reusedEventId = await transaction
        .selectFrom("session_event_ids")
        .select("event_id")
        .where("event_id", "in", eventIds)
        .executeTakeFirst();
      if (reusedEventId !== undefined) {
        throw new DurableEventStoreError(
          "event_conflict",
          "Event ID was already used by another sequence",
        );
      }
      if (!this.#externalWorkerEventLog) {
        await transaction
          .insertInto("session_events")
          .values(
            newPublications.map((message) =>
              this.#eventRow(
                sessionById.get(message.payload.event.sessionId)!.tenant_id,
                message,
                now,
              ),
            ),
          )
          .executeTakeFirstOrThrow();
        for (const message of newPublications) {
          await this.#recordStructuredTestResult(
            transaction,
            sessionById.get(message.payload.event.sessionId)!.tenant_id,
            message,
          );
          await this.#recordContextCompaction(
            transaction,
            sessionById.get(message.payload.event.sessionId)!.tenant_id,
            message,
          );
        }
      } else {
        await transaction
          .insertInto("session_event_ids")
          .values(
            newPublications.map((message) => ({
              event_id: message.payload.event.eventId,
              session_id: message.payload.event.sessionId,
              seq: message.payload.event.seq,
              content_sha256: eventContentSha256(
                sessionById.get(message.payload.event.sessionId)!.tenant_id,
                message,
              ),
            })),
          )
          .executeTakeFirstOrThrow();
        const batches = prepared
          .map((publication) => {
            const sessionId = publication.publications[0]!.payload.event.sessionId;
            const session = sessionById.get(sessionId)!;
            const cursor = cursorBySession.get(sessionId)!;
            const lastPersisted = safeInteger(cursor.last_persisted_seq, "last persisted sequence");
            const messages = publication.publications.filter(
              (message) => message.payload.event.seq > lastPersisted,
            );
            if (messages.length === 0) return undefined;
            const envelope: WorkerEventLogEnvelope = {
              schemaVersion: 1,
              tenantId: session.tenant_id,
              messages,
            };
            return { session, messages, envelope };
          })
          .filter((value): value is NonNullable<typeof value> => value !== undefined);
        await transaction
          .insertInto("worker_event_outbox")
          .values(
            batches.map(({ session, messages, envelope }) => ({
              id: this.#idGenerator(),
              tenant_id: session.tenant_id,
              session_id: messages[0]!.payload.event.sessionId,
              first_seq: messages[0]!.payload.event.seq,
              last_seq: messages.at(-1)!.payload.event.seq,
              envelope,
              content_sha256: createHash("sha256")
                .update(canonicalJson(envelope), "utf8")
                .digest("hex"),
              state: "pending" as const,
              available_at: now,
              claimed_by: null,
              claimed_until: null,
              last_error: null,
              published_at: null,
            })),
          )
          .executeTakeFirstOrThrow();
      }
    }

    if (advances.length > 0) {
      const advanceJson = JSON.stringify(advances);
      const projectionAdvance = !this.#externalWorkerEventLog
        ? sql`, last_projected_seq = advances."acknowledgedThrough"`
        : sql``;
      const cursorUpdates = await sql<{ session_id: string }>`
        with advances as (
          select * from jsonb_to_recordset(${advanceJson}::jsonb) as value(
            "sessionId" uuid,
            "expectedLast" bigint,
            "expectedNext" bigint,
            "acknowledgedThrough" bigint
          )
        )
        update session_event_cursors as cursor
           set last_persisted_seq = advances."acknowledgedThrough",
               acknowledged_through_seq = advances."acknowledgedThrough",
               updated_at = ${now}
               ${projectionAdvance}
          from advances
         where cursor.session_id = advances."sessionId"
           and cursor.last_persisted_seq = advances."expectedLast"
           and cursor.acknowledged_through_seq = advances."expectedLast"
        returning cursor.session_id
      `.execute(transaction);
      if (cursorUpdates.rows.length !== advances.length) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Grouped event cursor advance lost a compare-and-swap race",
        );
      }
      const sessionUpdates = await sql<{ id: string }>`
        with advances as (
          select * from jsonb_to_recordset(${advanceJson}::jsonb) as value(
            "sessionId" uuid,
            "expectedLast" bigint,
            "expectedNext" bigint,
            "acknowledgedThrough" bigint
          )
        )
        update sessions as session_row
           set next_event_seq = advances."acknowledgedThrough" + 1,
               row_version = session_row.row_version + 1,
               updated_at = ${now},
               last_active_at = ${now}
          from advances
         where session_row.id = advances."sessionId"
           and session_row.next_event_seq = advances."expectedNext"
        returning session_row.id
      `.execute(transaction);
      if (sessionUpdates.rows.length !== advances.length) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Grouped Session sequence advance lost a compare-and-swap race",
        );
      }
    }
    return results;
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
      .select("cursor.last_projected_seq as highWaterMark")
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

  async project(envelope: WorkerEventLogEnvelope): Promise<void> {
    const first = envelope.messages[0];
    const last = envelope.messages.at(-1);
    if (envelope.schemaVersion !== 1 || first === undefined || last === undefined) {
      throw new DurableEventStoreError("invalid_event", "Worker event envelope was invalid");
    }
    const sessionId = first.payload.event.sessionId;
    if (
      envelope.messages.some(
        (message, index) =>
          message.payload.event.sessionId !== sessionId ||
          message.payload.event.seq !== first.payload.event.seq + index,
      )
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Worker event envelope was not one contiguous Session range",
      );
    }
    const now = validDate(this.#clock);
    const projectedThrough = await this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select("tenant_id")
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (session === undefined || session.tenant_id !== envelope.tenantId) {
        throw new DurableEventStoreError("not_found", "Worker event Session was not found");
      }
      const cursor = await transaction
        .selectFrom("session_event_cursors")
        .select(["last_persisted_seq", "last_projected_seq"])
        .where("session_id", "=", sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (cursor === undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Session event cursor is missing",
        );
      }
      const persisted = safeInteger(cursor.last_persisted_seq, "last persisted sequence");
      const projected = safeInteger(cursor.last_projected_seq, "last projected sequence");
      if (last.payload.event.seq > persisted) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Kafka event range was not authorized by the durable Session cursor",
          true,
        );
      }

      const registrations = await transaction
        .selectFrom("session_event_ids")
        .select(["event_id", "seq", "content_sha256"])
        .where("session_id", "=", sessionId)
        .where(
          "seq",
          "in",
          envelope.messages.map((message) => String(message.payload.event.seq)),
        )
        .execute();
      const registeredBySequence = new Map(
        registrations.map((registration) => [
          safeInteger(registration.seq, "registered event sequence"),
          registration,
        ]),
      );
      for (const message of envelope.messages) {
        const event = message.payload.event;
        const registration = registeredBySequence.get(event.seq);
        if (
          registration === undefined ||
          normalizedUuid(registration.event_id) !== normalizedUuid(event.eventId) ||
          registration.content_sha256 !== eventContentSha256(envelope.tenantId, message)
        ) {
          throw new DurableEventStoreError(
            "event_conflict",
            `Kafka event ${event.seq} did not match its durable identity registration`,
          );
        }
      }

      const redeliveries = envelope.messages.filter(
        (message) => message.payload.event.seq <= projected,
      );
      if (redeliveries.length > 0) {
        const rows = await transaction
          .selectFrom("session_events")
          .select(eventSelect())
          .where("tenant_id", "=", envelope.tenantId)
          .where("session_id", "=", sessionId)
          .where(
            "seq",
            "in",
            redeliveries.map((message) => String(message.payload.event.seq)),
          )
          .execute();
        const rowsBySequence = new Map(
          rows.map((row) => [safeInteger(row.seq, "projected event sequence"), row]),
        );
        for (const message of redeliveries) {
          const row = rowsBySequence.get(message.payload.event.seq);
          if (row === undefined || !isExactRedelivery(row, message)) {
            throw new DurableEventStoreError(
              "event_conflict",
              `Kafka redelivery conflicted at sequence ${message.payload.event.seq}`,
            );
          }
        }
      }

      const newMessages = envelope.messages.filter(
        (message) => message.payload.event.seq > projected,
      );
      if (newMessages.length === 0) return projected;
      if (newMessages[0]!.payload.event.seq !== projected + 1) {
        throw new DurableEventStoreError(
          "sequence_gap",
          `Expected projected sequence ${projected + 1}, received ${newMessages[0]!.payload.event.seq}`,
          true,
        );
      }
      await transaction
        .insertInto("session_events")
        .values(newMessages.map((message) => this.#eventRow(envelope.tenantId, message, now)))
        .executeTakeFirstOrThrow();
      for (const message of newMessages) {
        await this.#recordStructuredTestResult(transaction, envelope.tenantId, message);
        await this.#recordContextCompaction(transaction, envelope.tenantId, message);
      }
      const throughSequence = newMessages.at(-1)!.payload.event.seq;
      const update = await transaction
        .updateTable("session_event_cursors")
        .set({ last_projected_seq: throughSequence, updated_at: now })
        .where("session_id", "=", sessionId)
        .where("last_projected_seq", "=", cursor.last_projected_seq)
        .executeTakeFirst();
      expectOne(update.numUpdatedRows, "advancing the projected event cursor");
      const notification = {
        schemaVersion: 1,
        tenantId: envelope.tenantId,
        sessionId,
        throughSequence,
      } as const;
      await this.#eventNotificationPublisher?.publish(transaction, notification);
      return throughSequence;
    });
    this.#eventHub?.notifyThrough(envelope.tenantId, sessionId, projectedThrough);
  }

  async #verifyRedeliveries(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
    messages: readonly EventPublishMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    if (this.#externalWorkerEventLog) {
      const rows = await transaction
        .selectFrom("session_event_ids")
        .select(["event_id", "seq", "content_sha256"])
        .where("session_id", "=", sessionId)
        .where(
          "seq",
          "in",
          messages.map((message) => String(message.payload.event.seq)),
        )
        .execute();
      const bySequence = new Map(
        rows.map((row) => [safeInteger(row.seq, "registered event sequence"), row]),
      );
      for (const message of messages) {
        const event = message.payload.event;
        const row = bySequence.get(event.seq);
        if (row === undefined) {
          throw new DurableEventStoreError(
            "event_store_invariant",
            "Durable event prefix contains a missing identity registration",
          );
        }
        if (
          normalizedUuid(row.event_id) !== normalizedUuid(event.eventId) ||
          row.content_sha256 !== eventContentSha256(tenantId, message)
        ) {
          throw new DurableEventStoreError(
            "event_conflict",
            `Conflicting event publication at sequence ${event.seq}`,
          );
        }
      }
      return;
    }
    const rows = await transaction
      .selectFrom("session_events")
      .select(eventSelect())
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        "in",
        messages.map((message) => String(message.payload.event.seq)),
      )
      .execute();
    const bySequence = new Map(
      rows.map((row) => [safeInteger(row.seq, "persisted event sequence"), row]),
    );
    for (const message of messages) {
      const event = message.payload.event;
      const row = bySequence.get(event.seq);
      if (row === undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Durable event prefix contains a missing sequence",
        );
      }
      if (!isExactRedelivery(row, message)) {
        throw new DurableEventStoreError(
          "event_conflict",
          `Conflicting event publication at sequence ${event.seq}`,
        );
      }
    }
  }

  #eventRow(tenantId: string, message: EventPublishMessage, now: Date) {
    const event = message.payload.event;
    return {
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
    };
  }

  async #ingestBatchTransaction(
    transaction: Transaction<Database>,
    messages: readonly EventPublishMessage[],
    now: Date,
  ): Promise<{ tenantId: string; acknowledgedThroughSeq: number }> {
    const firstMessage = messages[0];
    const lastMessage = messages.at(-1);
    if (firstMessage === undefined || lastMessage === undefined) {
      throw new DurableEventStoreError("invalid_event", "Event batch was empty");
    }
    const firstEvent = firstMessage.payload.event;
    const lastEvent = lastMessage.payload.event;
    const session = await transaction
      .selectFrom("sessions")
      .select(["tenant_id", "next_event_seq", "last_fencing_token"])
      .where("id", "=", firstEvent.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (session === undefined) {
      throw new DurableEventStoreError("not_found", "Event session was not found");
    }
    const tenantId = session.tenant_id;
    const cursor = await transaction
      .selectFrom("session_event_cursors")
      .select(["last_persisted_seq", "acknowledged_through_seq"])
      .where("session_id", "=", firstEvent.sessionId)
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

    const redeliveries = messages.filter((message) => message.payload.event.seq <= lastPersisted);
    if (redeliveries.length > 0) {
      const existingRows = await transaction
        .selectFrom("session_events")
        .select(eventSelect())
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", firstEvent.sessionId)
        .where(
          "seq",
          "in",
          redeliveries.map((message) => String(message.payload.event.seq)),
        )
        .execute();
      const existingBySequence = new Map(
        existingRows.map((row) => [safeInteger(row.seq, "persisted event sequence"), row]),
      );
      for (const message of redeliveries) {
        const event = message.payload.event;
        const existing = existingBySequence.get(event.seq);
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
      }
    }

    const newMessages = messages.filter((message) => message.payload.event.seq > lastPersisted);
    if (newMessages.length === 0) {
      return { tenantId, acknowledgedThroughSeq: lastEvent.seq };
    }
    const firstNewEvent = newMessages[0]!.payload.event;
    const expectedSequence = lastPersisted + 1;
    const sessionNextSequence = safeInteger(session.next_event_seq, "session next event sequence");
    if (firstNewEvent.seq !== expectedSequence || firstNewEvent.seq !== sessionNextSequence) {
      throw new DurableEventStoreError(
        "sequence_gap",
        `Expected contiguous event sequence ${expectedSequence}, received ${firstNewEvent.seq}`,
      );
    }

    // One batch has one Session/Turn/command identity. Validate that ownership
    // once, then persist the contiguous suffix as one set operation.
    await this.#validateEventOwnership(transaction, tenantId, firstMessage);
    const lease = await transaction
      .selectFrom("session_leases")
      .select(["lease_id", "fencing_token", "valid_until"])
      .where("session_id", "=", firstEvent.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      lease === undefined ||
      normalizedUuid(lease.lease_id) !== normalizedUuid(firstMessage.payload.leaseId) ||
      safeInteger(lease.fencing_token, "lease fencing token") !==
        firstMessage.payload.fencingToken ||
      safeInteger(session.last_fencing_token, "session fencing token") !==
        firstMessage.payload.fencingToken ||
      new Date(lease.valid_until).valueOf() <= now.valueOf()
    ) {
      throw new DurableEventStoreError("stale_fence", "Event publication lease is stale");
    }

    const eventIds = newMessages.map((message) => message.payload.event.eventId);
    if (new Set(eventIds.map((eventId) => eventId.toLowerCase())).size !== eventIds.length) {
      throw new DurableEventStoreError("event_conflict", "Event ID was reused inside one batch");
    }
    const reusedEventId = await transaction
      .selectFrom("session_event_ids")
      .select(["session_id", "seq"])
      .where("event_id", "in", eventIds)
      .executeTakeFirst();
    if (reusedEventId !== undefined) {
      throw new DurableEventStoreError(
        "event_conflict",
        "Event ID was already used by another sequence",
      );
    }

    await transaction
      .insertInto("session_events")
      .values(
        newMessages.map((message) => {
          const event = message.payload.event;
          return {
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
          };
        }),
      )
      .executeTakeFirstOrThrow();

    for (const message of newMessages) {
      await this.#recordStructuredTestResult(transaction, tenantId, message);
      await this.#recordContextCompaction(transaction, tenantId, message);
    }

    const acknowledgedThroughSeq = newMessages.at(-1)!.payload.event.seq;
    const cursorUpdate = await transaction
      .updateTable("session_event_cursors")
      .set({
        last_persisted_seq: acknowledgedThroughSeq,
        last_projected_seq: acknowledgedThroughSeq,
        acknowledged_through_seq: acknowledgedThroughSeq,
        updated_at: now,
      })
      .where("session_id", "=", firstEvent.sessionId)
      .where("last_persisted_seq", "=", cursor.last_persisted_seq)
      .where("acknowledged_through_seq", "=", cursor.acknowledged_through_seq)
      .executeTakeFirst();
    expectOne(cursorUpdate.numUpdatedRows, "advancing the event cursor");

    const sessionUpdate = await transaction
      .updateTable("sessions")
      .set({
        next_event_seq: acknowledgedThroughSeq + 1,
        row_version: sql<string>`${sql.ref("row_version")} + 1`,
        updated_at: now,
        last_active_at: now,
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", firstEvent.sessionId)
      .where("next_event_seq", "=", session.next_event_seq)
      .executeTakeFirst();
    expectOne(sessionUpdate.numUpdatedRows, "advancing the session event sequence");

    return { tenantId, acknowledgedThroughSeq };
  }

  async #recordStructuredTestResult(
    transaction: Transaction<Database>,
    tenantId: string,
    message: EventPublishMessage,
  ): Promise<void> {
    const event = message.payload.event;
    if (event.type !== "tool.completed" || event.turnId === null) return;
    const started = await transaction
      .selectFrom("session_events")
      .select(["payload", "occurred_at"])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("turn_id", "=", event.turnId)
      .where("type", "=", "tool.started")
      .where(sql<boolean>`${sql.ref("payload")} ->> 'toolCallId' = ${event.payload.toolCallId}`)
      .orderBy("seq", "desc")
      .executeTakeFirst();
    if (started === undefined || started.payload.toolName !== "bash") return;
    const input = started.payload.input;
    if (typeof input !== "object" || input === null || !("command" in input)) return;
    const command = (input as { command?: unknown }).command;
    if (typeof command !== "string" || command.length < 1 || command.length > 4_096) return;
    const testInvocation = classifyStructuredTestCommand(command);
    if (testInvocation === undefined) return;
    const run = await transaction
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("turn_id", "=", event.turnId)
      .executeTakeFirst();
    if (run === undefined) return;
    const output = event.payload.output;
    const summary =
      output === undefined
        ? null
        : (typeof output === "string" ? output : JSON.stringify(output)).slice(0, 2_000);
    const durationMs = Math.max(
      0,
      new Date(event.occurredAt).valueOf() - new Date(started.occurred_at).valueOf(),
    );
    await transaction
      .insertInto("test_results")
      .values({
        id: event.eventId,
        tenant_id: tenantId,
        session_id: event.sessionId,
        turn_id: event.turnId,
        run_id: run.id,
        workspace_version_id: null,
        tool_call_id: event.payload.toolCallId,
        command,
        suite: testInvocation.suite,
        status: event.payload.outcome === "completed" ? "passed" : "failed",
        exit_code: null,
        duration_ms: Math.min(durationMs, 86_400_000),
        summary,
        artifact_id: event.payload.outputArtifact?.artifactId ?? null,
        created_at: new Date(event.occurredAt),
      })
      .onConflict((conflict) => conflict.columns(["run_id", "tool_call_id"]).doNothing())
      .execute();
  }

  async #recordContextCompaction(
    transaction: Transaction<Database>,
    tenantId: string,
    message: EventPublishMessage,
  ): Promise<void> {
    const event = message.payload.event;
    if (
      (event.type !== "context.compaction.started" &&
        event.type !== "context.compaction.completed") ||
      event.turnId === null
    ) {
      return;
    }
    const run = await transaction
      .selectFrom("runs")
      .select(["id", "current_attempt_id"])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("turn_id", "=", event.turnId)
      .executeTakeFirst();
    if (run === undefined || run.current_attempt_id === null) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Compaction event has no current Run Attempt",
      );
    }
    const occurredAt = new Date(event.occurredAt);
    if (event.type === "context.compaction.started") {
      await transaction
        .insertInto("context_compactions")
        .values({
          id: event.eventId,
          tenant_id: tenantId,
          session_id: event.sessionId,
          turn_id: event.turnId,
          run_id: run.id,
          attempt_id: run.current_attempt_id,
          started_event_id: event.eventId,
          completed_event_id: null,
          reason: event.payload.reason,
          state: "running",
          tokens_before: null,
          estimated_tokens_after: null,
          first_kept_entry_id: null,
          summary_sha256: null,
          summary_version: null,
          will_retry: false,
          started_at: occurredAt,
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
      return;
    }

    const updated = await transaction
      .updateTable("context_compactions")
      .set({
        completed_event_id: event.eventId,
        state: event.payload.status,
        tokens_before: event.payload.tokensBefore ?? null,
        estimated_tokens_after: event.payload.estimatedTokensAfter ?? null,
        first_kept_entry_id: event.payload.firstKeptEntryId ?? null,
        summary_sha256: event.payload.summarySha256 ?? null,
        summary_version: event.payload.summaryVersion ?? null,
        will_retry: event.payload.willRetry,
        completed_at: occurredAt,
      })
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", event.sessionId)
      .where("turn_id", "=", event.turnId)
      .where("run_id", "=", run.id)
      .where("attempt_id", "=", run.current_attempt_id)
      .where("state", "=", "running")
      .where("reason", "=", event.payload.reason)
      .executeTakeFirst();
    expectOne(updated.numUpdatedRows, "settling a native Pi compaction");
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
