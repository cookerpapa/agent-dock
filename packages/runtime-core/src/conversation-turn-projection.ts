import type { Database } from "@agent-dock/database";
import {
  parseAgentDockEvent,
  parseConversationTurnTranscriptResource,
  type AgentDockEvent,
  type ConversationTranscriptItemResource,
  type ConversationTurnTranscriptResource,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";

type ProjectionDatabase = Kysely<Database> | Transaction<Database>;

export type StoreConversationTurnProjectionInput = {
  tenantId: string;
  sessionId: string;
  turnId: string;
  transcript: ConversationTurnTranscriptResource;
  sourceEventCount: number;
  projectedAt?: Date;
};

type ProjectionEventRow = {
  event_id: string;
  session_id: string;
  turn_id: string | null;
  agent_id: string;
  seq: string;
  schema_version: number;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
};

export type MaterializeConversationTurnProjectionInput = {
  tenantId: string;
  sessionId: string;
  turnId: string;
  projectedAt?: Date;
};

export type MaterializeConversationTurnProjectionsInput = {
  tenantId: string;
  sessionId: string;
  turnIds: readonly string[];
  projectedAt?: Date;
};

function positiveSafeInteger(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${description} is outside the positive safe integer range`);
  }
  return parsed;
}

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error("Conversation projection event timestamp is invalid");
  }
  return parsed.toISOString();
}

function projectionEvent(row: ProjectionEventRow): AgentDockEvent {
  return parseAgentDockEvent({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    seq: positiveSafeInteger(row.seq, "Conversation projection event sequence"),
    occurredAt: isoTimestamp(row.occurred_at),
    type: row.type,
    payload: row.payload,
  });
}

function toolItemIndex(
  items: readonly ConversationTranscriptItemResource[],
  toolCallId: string,
): number {
  return items.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
}

/**
 * Reduces the durable public event history for one Turn into the bounded
 * semantic transcript used by conversation discovery. Pi SessionStorage
 * remains the model-context authority; Kafka/Valkey supplies live deltas and
 * PostgreSQL stores this canonical terminal view.
 */
export function projectConversationTurnTranscript(
  events: readonly AgentDockEvent[],
): ConversationTurnTranscriptResource {
  if (events.length === 0) {
    throw new TypeError("A conversation turn projection requires at least one event");
  }
  const first = events[0]!;
  if (first.turnId === null) {
    throw new TypeError("A conversation turn projection cannot contain a session-level event");
  }

  const items: ConversationTranscriptItemResource[] = [];
  let previousSequence = 0;
  let startedSequence: number | null = null;
  let terminalSequence: number | null = null;
  let stopReason: string | null = null;
  let failure: ConversationTurnTranscriptResource["failure"] = null;
  let cancellation: ConversationTurnTranscriptResource["cancellation"] = null;
  let workspacePatch: ConversationTurnTranscriptResource["workspacePatch"] = null;

  for (const event of events) {
    if (
      event.sessionId !== first.sessionId ||
      event.turnId !== first.turnId ||
      event.seq <= previousSequence
    ) {
      throw new TypeError(
        "Conversation turn projection events must share one identity and increase by sequence",
      );
    }
    previousSequence = event.seq;

    if (event.type === "turn.started") {
      startedSequence = event.seq;
      continue;
    }
    if (event.type === "assistant.text.delta") {
      const last = items.at(-1);
      if (last?.kind === "text") {
        items[items.length - 1] = {
          ...last,
          text: `${last.text}${event.payload.text}`,
          lastSequence: event.seq,
        };
      } else {
        items.push({
          kind: "text",
          text: event.payload.text,
          firstSequence: event.seq,
          lastSequence: event.seq,
        });
      }
      continue;
    }
    if (event.type === "tool.input.delta") {
      const index = toolItemIndex(items, event.payload.toolCallId);
      if (index < 0) {
        items.push({
          kind: "tool",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: null,
          inputJson: event.payload.delta,
          status: "preparing",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      } else {
        const existing = items[index]!;
        if (existing.kind !== "tool") throw new Error("Tool projection index was corrupted");
        items[index] = {
          ...existing,
          toolName: event.payload.toolName,
          inputJson: `${existing.inputJson ?? ""}${event.payload.delta}`,
        };
      }
      continue;
    }
    if (event.type === "tool.started") {
      const index = toolItemIndex(items, event.payload.toolCallId);
      if (index < 0) {
        items.push({
          kind: "tool",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      } else {
        const existing = items[index]!;
        if (existing.kind !== "tool") throw new Error("Tool projection index was corrupted");
        items[index] = {
          ...existing,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          startedAt: event.occurredAt,
        };
      }
      continue;
    }
    if (event.type === "tool.completed") {
      const index = toolItemIndex(items, event.payload.toolCallId);
      if (index < 0) {
        items.push({
          kind: "tool",
          toolCallId: event.payload.toolCallId,
          toolName: "unknown",
          input: null,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          firstSequence: event.seq,
          lastSequence: event.seq,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
        });
      } else {
        const existing = items[index]!;
        if (existing.kind !== "tool") throw new Error("Tool projection index was corrupted");
        items[index] = {
          ...existing,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          lastSequence: event.seq,
          completedAt: event.occurredAt,
        };
      }
      continue;
    }
    if (event.type === "approval.requested") {
      items.push({
        kind: "approval",
        approval: event.payload,
        firstSequence: event.seq,
      });
      continue;
    }
    if (event.type === "approval.resolved") {
      const index = items.findIndex(
        (item) => item.kind === "approval" && item.approval.approvalId === event.payload.approvalId,
      );
      if (index >= 0) {
        const existing = items[index]!;
        if (existing.kind !== "approval") {
          throw new Error("Approval projection index was corrupted");
        }
        items[index] = {
          ...existing,
          outcome: event.payload.outcome,
          ...(event.payload.value === undefined ? {} : { value: event.payload.value }),
          lastSequence: event.seq,
        };
      }
      continue;
    }
    if (event.type === "ui.notification") {
      items.push({
        kind: "notification",
        level: event.payload.level,
        message: event.payload.message,
        sequence: event.seq,
      });
      continue;
    }
    if (event.type === "turn.completed") {
      terminalSequence = event.seq;
      stopReason = event.payload.stopReason;
      workspacePatch = event.payload.workspacePatch ?? null;
      continue;
    }
    if (event.type === "turn.failed") {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === "tool" && (item.status === "preparing" || item.status === "running")) {
          items[index] = {
            ...item,
            status: "unknown",
            lastSequence: event.seq,
            completedAt: event.occurredAt,
          };
        }
      }
      terminalSequence = event.seq;
      failure = event.payload;
      continue;
    }
    if (event.type === "turn.cancelled") {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === "tool" && (item.status === "preparing" || item.status === "running")) {
          items[index] = {
            ...item,
            status: "unknown",
            lastSequence: event.seq,
            completedAt: event.occurredAt,
          };
        }
      }
      terminalSequence = event.seq;
      stopReason = "cancelled";
      cancellation = event.payload;
    }
  }

  return parseConversationTurnTranscriptResource({
    schemaVersion: 1,
    throughSequence: events.at(-1)!.seq,
    items,
    startedSequence,
    terminalSequence,
    stopReason,
    failure,
    cancellation,
    workspacePatch,
  });
}

export async function materializeConversationTurnProjection(
  database: ProjectionDatabase,
  input: MaterializeConversationTurnProjectionInput,
): Promise<ConversationTurnTranscriptResource | undefined> {
  return (
    await materializeConversationTurnProjections(database, {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnIds: [input.turnId],
      ...(input.projectedAt === undefined ? {} : { projectedAt: input.projectedAt }),
    })
  ).get(input.turnId);
}

export async function storeConversationTurnProjection(
  database: ProjectionDatabase,
  input: StoreConversationTurnProjectionInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.sourceEventCount) || input.sourceEventCount < 1) {
    throw new TypeError("Conversation projection source event count must be positive");
  }
  const transcript = parseConversationTurnTranscriptResource(input.transcript);
  await database
    .insertInto("conversation_turn_projections")
    .values({
      turn_id: input.turnId,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      schema_version: 1,
      through_seq: transcript.throughSequence,
      source_event_count: input.sourceEventCount,
      transcript: transcript as unknown as Record<string, unknown>,
      projected_at: input.projectedAt ?? new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("turn_id").doUpdateSet({
        tenant_id: sql`excluded.tenant_id`,
        session_id: sql`excluded.session_id`,
        schema_version: sql`excluded.schema_version`,
        through_seq: sql`excluded.through_seq`,
        source_event_count: sql`excluded.source_event_count`,
        transcript: sql`excluded.transcript`,
        projected_at: sql`excluded.projected_at`,
      }),
    )
    .executeTakeFirstOrThrow();
}

export async function materializeConversationTurnProjections(
  database: ProjectionDatabase,
  input: MaterializeConversationTurnProjectionsInput,
): Promise<ReadonlyMap<string, ConversationTurnTranscriptResource>> {
  const turnIds = [...new Set(input.turnIds)];
  if (turnIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("session_events")
    .select([
      "event_id",
      "session_id",
      "turn_id",
      "agent_id",
      "seq",
      "schema_version",
      "type",
      "payload",
      "occurred_at",
    ])
    .where("tenant_id", "=", input.tenantId)
    .where("session_id", "=", input.sessionId)
    .where("turn_id", "in", turnIds)
    .orderBy("seq", "asc")
    .execute();
  const eventsByTurnId = new Map<string, AgentDockEvent[]>();
  for (const row of rows) {
    if (row.turn_id === null) {
      throw new Error("Conversation projection query returned a session-level event");
    }
    const projected = eventsByTurnId.get(row.turn_id) ?? [];
    projected.push(projectionEvent(row));
    eventsByTurnId.set(row.turn_id, projected);
  }
  if (eventsByTurnId.size === 0) return new Map();

  const projectedAt = input.projectedAt ?? new Date();
  const transcripts = new Map<string, ConversationTurnTranscriptResource>();
  const values = [...eventsByTurnId].map(([turnId, events]) => {
    const transcript = projectConversationTurnTranscript(events);
    transcripts.set(turnId, transcript);
    return {
      turn_id: turnId,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      schema_version: 1,
      through_seq: transcript.throughSequence,
      source_event_count: events.length,
      transcript: transcript as unknown as Record<string, unknown>,
      projected_at: projectedAt,
    };
  });
  await database
    .insertInto("conversation_turn_projections")
    .values(values)
    .onConflict((conflict) =>
      conflict.column("turn_id").doUpdateSet({
        tenant_id: sql`excluded.tenant_id`,
        session_id: sql`excluded.session_id`,
        schema_version: sql`excluded.schema_version`,
        through_seq: sql`excluded.through_seq`,
        source_event_count: sql`excluded.source_event_count`,
        transcript: sql`excluded.transcript`,
        projected_at: sql`excluded.projected_at`,
      }),
    )
    .executeTakeFirstOrThrow();
  return transcripts;
}
