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
import { isDeepStrictEqual } from "node:util";
import type { SessionEventHub } from "./session-event-hub.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";
import { materializeConversationTurnProjection } from "./conversation-turn-projection.ts";
import { classifyStructuredTestCommand } from "./structured-test-command.ts";

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
    if (parsed.type !== "event.publish" && parsed.type !== "event.publish_batch") {
      throw new DurableEventStoreError("invalid_event", "Expected an event publication");
    }
    const publications = this.#publications(parsed);
    const first = publications[0];
    const last = publications.at(-1);
    if (first === undefined || last === undefined) {
      throw new DurableEventStoreError("invalid_event", "Event batch was empty");
    }
    const now = validDate(this.#clock);
    const result = await this.#database.transaction().execute(async (transaction) => {
      let ingested: { tenantId: string; acknowledgedThroughSeq: number } | undefined;
      for (const publication of publications) {
        ingested = await this.#ingestTransaction(transaction, publication, now);
      }
      if (ingested === undefined) {
        throw new DurableEventStoreError("invalid_event", "Event batch was empty");
      }
      await this.#eventNotificationPublisher?.publish(transaction, {
        schemaVersion: 1,
        tenantId: ingested.tenantId,
        sessionId: last.payload.event.sessionId,
        throughSequence: ingested.acknowledgedThroughSeq,
      });
      return ingested;
    });
    this.#eventHub?.notifyThrough(
      result.tenantId,
      last.payload.event.sessionId,
      result.acknowledgedThroughSeq,
    );
    return this.#acknowledgement(last, result.acknowledgedThroughSeq, now);
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

    await this.#recordStructuredTestResult(transaction, tenantId, message, now);
    await this.#recordContextCompaction(transaction, tenantId, message);
    if (
      event.turnId !== null &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled")
    ) {
      await materializeConversationTurnProjection(transaction, {
        tenantId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        projectedAt: now,
      });
    }

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

  async #recordStructuredTestResult(
    transaction: Transaction<Database>,
    tenantId: string,
    message: EventPublishMessage,
    now: Date,
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
        status: event.payload.isError ? "failed" : "passed",
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
