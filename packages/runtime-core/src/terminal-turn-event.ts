import type { Database } from "@pi-cloud/database";
import { parsePiCloudEvent, type PiCloudEvent, type PiCloudEventBody } from "@pi-cloud/protocol";
import { sql, type Transaction } from "kysely";
import { appendInterruptedAssistantPrefix } from "./canonical-pi-conversation.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";
import type { PreparedTerminalTurnProjection } from "./terminal-turn-projection.ts";

type TerminalEventBody = Extract<
  PiCloudEventBody,
  { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
>;

export type CommitTerminalTurnEventInput = {
  tenantId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
  agentId: string;
  leaseId: string;
  fencingToken: number;
  body: TerminalEventBody;
  now: Date;
  eventId: string;
  notificationPublisher?: SessionEventNotificationPublisher;
  preparedProjection?: PreparedTerminalTurnProjection;
  liveStreamRetentionMs?: number;
};

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} is outside the non-negative safe integer range`);
  }
  return parsed;
}

function expectOne(value: bigint, description: string): void {
  if (value !== 1n) throw new Error(`${description} changed ${String(value)} rows`);
}

/**
 * Writes the only public terminal event for a Turn. Callers must invoke this
 * inside the same transaction that settles the Run and its checkpoint heads.
 */
export async function commitTerminalTurnEvent(
  transaction: Transaction<Database>,
  input: CommitTerminalTurnEventInput,
): Promise<PiCloudEvent> {
  const session = await transaction
    .selectFrom("sessions")
    .select("next_event_seq")
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.sessionId)
    .forUpdate()
    .executeTakeFirst();
  const cursor = await transaction
    .selectFrom("session_event_cursors")
    .select(["last_persisted_seq", "last_projected_seq", "acknowledged_through_seq"])
    .where("session_id", "=", input.sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (session === undefined || cursor === undefined) {
    throw new Error("Terminal event stream is missing");
  }
  const sequence = safeSequence(session.next_event_seq, "Session next event sequence");
  const persisted = safeSequence(cursor.last_persisted_seq, "Persisted event cursor");
  const acknowledged = safeSequence(cursor.acknowledged_through_seq, "Acknowledged event cursor");
  const projected = safeSequence(cursor.last_projected_seq, "Projected event cursor");
  if (
    sequence < 1 ||
    persisted !== sequence - 1 ||
    projected > persisted ||
    acknowledged !== persisted
  ) {
    throw new Error("Terminal event stream is not contiguous");
  }

  const event = parsePiCloudEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentId: input.agentId,
    seq: sequence,
    occurredAt: input.now.toISOString(),
    ...input.body,
  });
  if (
    event.type !== "turn.completed" &&
    event.type !== "turn.failed" &&
    event.type !== "turn.cancelled"
  ) {
    throw new Error("Constructed terminal Turn event is not terminal");
  }
  const prepared = input.preparedProjection;
  if (prepared !== undefined) {
    if (event.type === "turn.completed") {
      throw new Error("A successful Turn cannot depend on a live-stream projection");
    }
    const preparedEvent = prepared.terminalEvent;
    if (
      prepared.previousSequence !== persisted ||
      preparedEvent.eventId !== event.eventId ||
      preparedEvent.sessionId !== event.sessionId ||
      preparedEvent.turnId !== event.turnId ||
      preparedEvent.agentId !== event.agentId ||
      preparedEvent.seq !== event.seq ||
      preparedEvent.occurredAt !== event.occurredAt ||
      preparedEvent.type !== event.type ||
      JSON.stringify(preparedEvent.payload) !== JSON.stringify(event.payload)
    ) {
      throw new Error("Prepared interrupted Turn projection no longer matches durable state");
    }
  }
  await transaction
    .insertInto("session_terminal_events")
    .values({
      event_id: event.eventId,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      agent_id: input.agentId,
      command_id: input.commandId,
      seq: sequence,
      schema_version: event.schemaVersion,
      type: event.type,
      payload: event.payload,
      occurred_at: input.now,
      persisted_at: input.now,
    })
    .executeTakeFirstOrThrow();
  if (prepared !== undefined) {
    await appendInterruptedAssistantPrefix(transaction, {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      transcript: prepared.transcript,
      now: input.now,
      entryId: globalThis.crypto.randomUUID(),
    });
  }
  const retentionMs = input.liveStreamRetentionMs ?? 60 * 60 * 1_000;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) {
    throw new TypeError("Live event retention must be at least one minute");
  }
  await transaction
    .insertInto("session_live_stream_compactions")
    .values({
      id: globalThis.crypto.randomUUID(),
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      through_seq: sequence,
      state: "pending",
      attempts: 0,
      available_at: new Date(input.now.valueOf() + retentionMs),
      claim_owner: null,
      claim_until: null,
      last_error: null,
      created_at: input.now,
      completed_at: null,
    })
    .executeTakeFirstOrThrow();

  const projectedAfter = projected === persisted ? sequence : projected;
  const cursorUpdate = await transaction
    .updateTable("session_event_cursors")
    .set({
      last_persisted_seq: sequence,
      last_projected_seq: projectedAfter,
      acknowledged_through_seq: sequence,
      updated_at: input.now,
    })
    .where("session_id", "=", input.sessionId)
    .where("last_persisted_seq", "=", cursor.last_persisted_seq)
    .where("last_projected_seq", "=", cursor.last_projected_seq)
    .where("acknowledged_through_seq", "=", cursor.acknowledged_through_seq)
    .executeTakeFirst();
  expectOne(cursorUpdate.numUpdatedRows, "Advancing the terminal event cursor");

  const sessionUpdate = await transaction
    .updateTable("sessions")
    .set({
      next_event_seq: sequence + 1,
      row_version: sql<string>`${sql.ref("row_version")} + 1`,
      updated_at: input.now,
      last_active_at: input.now,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.sessionId)
    .where("next_event_seq", "=", session.next_event_seq)
    .executeTakeFirst();
  expectOne(sessionUpdate.numUpdatedRows, "Advancing the terminal session sequence");

  if (projectedAfter > projected) {
    await input.notificationPublisher?.publish(transaction, {
      schemaVersion: 1,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      throughSequence: projectedAfter,
    });
  }
  return event;
}
