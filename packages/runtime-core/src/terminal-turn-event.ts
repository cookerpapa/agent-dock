import type { Database } from "@agent-dock/database";
import {
  parseAgentDockEvent,
  type AgentDockEvent,
  type AgentDockEventBody,
} from "@agent-dock/protocol";
import { sql, type Transaction } from "kysely";
import { materializeConversationTurnProjection } from "./conversation-turn-projection.ts";
import type { SessionEventNotificationPublisher } from "./session-event-notifications.ts";

type TerminalEventBody = Extract<
  AgentDockEventBody,
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
): Promise<AgentDockEvent> {
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
    projected !== persisted ||
    acknowledged !== persisted
  ) {
    throw new Error("Terminal event stream is not contiguous");
  }

  const event = parseAgentDockEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentId: input.agentId,
    seq: sequence,
    occurredAt: input.now.toISOString(),
    ...input.body,
  });
  await transaction
    .insertInto("session_events")
    .values({
      event_id: event.eventId,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      agent_node_id: null,
      agent_id: input.agentId,
      command_id: input.commandId,
      seq: sequence,
      schema_version: event.schemaVersion,
      type: event.type,
      payload: event.payload,
      lease_id: input.leaseId,
      fencing_token: input.fencingToken,
      occurred_at: input.now,
      persisted_at: input.now,
    })
    .executeTakeFirstOrThrow();

  await materializeConversationTurnProjection(transaction, {
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    projectedAt: input.now,
  });

  const cursorUpdate = await transaction
    .updateTable("session_event_cursors")
    .set({
      last_persisted_seq: sequence,
      last_projected_seq: sequence,
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

  await input.notificationPublisher?.publish(transaction, {
    schemaVersion: 1,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    throughSequence: sequence,
  });
  return event;
}
