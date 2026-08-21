import type { Database } from "@pi-cloud/database";
import {
  parsePiCloudEvent,
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  type PiCloudEvent,
  type PiCloudEventBody,
} from "@pi-cloud/protocol";
import { sql, type Transaction } from "kysely";
import { appendInterruptedAssistantPrefix } from "./canonical-pi-conversation.ts";
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
  preparedProjection?: PreparedTerminalTurnProjection;
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
  const execution = await transaction
    .selectFrom("runs as run")
    .innerJoin("run_attempts as attempt", (join) =>
      join
        .onRef("attempt.tenant_id", "=", "run.tenant_id")
        .onRef("attempt.run_id", "=", "run.id")
        .onRef("attempt.id", "=", "run.current_attempt_id"),
    )
    .select([
      "run.id as runId",
      "attempt.id as attemptId",
      "attempt.last_event_seq as lastEventSeq",
    ])
    .where("run.tenant_id", "=", input.tenantId)
    .where("run.session_id", "=", input.sessionId)
    .where("run.turn_id", "=", input.turnId)
    .where("run.command_id", "=", input.commandId)
    .executeTakeFirst();
  if (session === undefined || execution === undefined) {
    throw new Error("Terminal event stream is missing");
  }
  const nextSequence = safeSequence(session.next_event_seq, "Session next event sequence");
  const previousSequence = safeSequence(execution.lastEventSeq, "Run event boundary");
  const sequence = previousSequence + 1;
  if (nextSequence < 1 || previousSequence < nextSequence - 1) {
    throw new Error("Terminal event boundary precedes the current Session stream");
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
      prepared.previousSequence !== previousSequence ||
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
  await transaction
    .insertInto("outbox")
    .values({
      id: input.eventId,
      tenant_id: input.tenantId,
      aggregate_type: "session_terminal_event",
      aggregate_id: input.eventId,
      topic: SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
      payload: {
        schemaVersion: 1,
        tenantId: input.tenantId,
        publications: [
          {
            protocolVersion: 1,
            messageId: input.eventId,
            sentAt: input.now.toISOString(),
            type: "event.publish",
            payload: {
              leaseId: input.leaseId,
              fencingToken: input.fencingToken,
              commandId: input.commandId,
              runId: execution.runId,
              attemptId: execution.attemptId,
              event,
            },
          },
        ],
      },
      attempts: 0,
      available_at: input.now,
      created_at: input.now,
      published_at: null,
      last_error: null,
    })
    .executeTakeFirstOrThrow();

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
  return event;
}
