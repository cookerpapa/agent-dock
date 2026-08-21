import type { Database } from "@pi-cloud/database";
import {
  parsePiCloudEvent,
  parseConversationTurnTranscriptResource,
  type ConversationTranscriptItemResource,
  type ConversationTurnTranscriptResource,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";

export const INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE = "pi-cloud.interrupted_assistant_prefix";

type JsonRecord = Record<string, unknown>;
type TerminalProjectionMetadata = Pick<
  ConversationTurnTranscriptResource,
  | "throughSequence"
  | "terminalSequence"
  | "stopReason"
  | "failure"
  | "cancellation"
  | "workspacePatch"
> & { occurredAt: string };
type DraftItem =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      status: "running" | "completed" | "failed";
      startedAt: string;
      completedAt?: string;
    };

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function timestamp(value: string | Date | number): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new Error("Canonical conversation timestamp is invalid");
  return parsed.toISOString();
}

function messageFromEntry(payload: unknown): JsonRecord | undefined {
  const entry = record(payload);
  return entry?.type === "message" ? record(entry.message) : undefined;
}

function textParts(message: JsonRecord | undefined): string[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((part) => {
    const candidate = record(part);
    return candidate?.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function interruptedPrefix(payload: unknown): string | undefined {
  const entry = record(payload);
  if (entry?.type !== "custom" || entry.customType !== INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE) {
    return undefined;
  }
  const data = record(entry.data);
  return typeof data?.text === "string" && data.text.length > 0 ? data.text : undefined;
}

function terminalMetadata(row: {
  seq: string;
  type: string;
  payload: JsonRecord;
  occurred_at: Date;
}): TerminalProjectionMetadata {
  const sequence = safeInteger(row.seq, "Terminal conversation sequence");
  const payload = row.payload;
  if (row.type === "turn.completed") {
    return {
      throughSequence: sequence,
      terminalSequence: sequence,
      stopReason: typeof payload.stopReason === "string" ? payload.stopReason : "stop",
      failure: null,
      cancellation: null,
      workspacePatch: (payload.workspacePatch ??
        null) as ConversationTurnTranscriptResource["workspacePatch"],
      occurredAt: timestamp(row.occurred_at),
    };
  }
  if (row.type === "turn.failed") {
    return {
      throughSequence: sequence,
      terminalSequence: sequence,
      stopReason: null,
      failure: {
        code: typeof payload.code === "string" ? payload.code : "run_failed",
        message: typeof payload.message === "string" ? payload.message : "Agent Run failed",
        retryable: payload.retryable === true,
      },
      cancellation: null,
      workspacePatch: null,
      occurredAt: timestamp(row.occurred_at),
    };
  }
  return {
    throughSequence: sequence,
    terminalSequence: sequence,
    stopReason: "cancelled",
    failure: null,
    cancellation: {
      reason: typeof payload.reason === "string" ? payload.reason : "user_request",
      forced: payload.forced === true,
    } as ConversationTurnTranscriptResource["cancellation"],
    workspacePatch: null,
    occurredAt: timestamp(row.occurred_at),
  };
}

function outputValue(message: JsonRecord): unknown {
  return Array.isArray(message.content) ? message.content : undefined;
}

function projectPiEntries(
  rows: readonly { seq: string; timestamp_ms: string; payload: JsonRecord }[],
  terminal: ReturnType<typeof terminalMetadata>,
): ConversationTurnTranscriptResource {
  const drafts: DraftItem[] = [];
  const tools = new Map<string, number>();
  for (const row of rows) {
    const occurredAt = timestamp(safeInteger(row.timestamp_ms, "Pi entry timestamp"));
    const message = messageFromEntry(row.payload);
    if (message?.role === "assistant") {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const candidate = record(part);
        if (
          candidate?.type === "text" &&
          typeof candidate.text === "string" &&
          candidate.text.length > 0
        ) {
          const last = drafts.at(-1);
          if (last?.kind === "text") last.text += candidate.text;
          else drafts.push({ kind: "text", text: candidate.text });
          continue;
        }
        if (
          candidate?.type === "toolCall" &&
          typeof candidate.id === "string" &&
          typeof candidate.name === "string"
        ) {
          tools.set(candidate.id, drafts.length);
          drafts.push({
            kind: "tool",
            toolCallId: candidate.id,
            toolName: candidate.name,
            input: candidate.arguments ?? null,
            status: "running",
            startedAt: occurredAt,
          });
        }
      }
      continue;
    }
    if (
      message?.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string"
    ) {
      const index = tools.get(message.toolCallId);
      const status = message.isError === true ? "failed" : "completed";
      if (index === undefined) {
        tools.set(message.toolCallId, drafts.length);
        drafts.push({
          kind: "tool",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          input: null,
          output: outputValue(message),
          status,
          startedAt: occurredAt,
          completedAt: occurredAt,
        });
      } else {
        const current = drafts[index];
        if (current?.kind === "tool") {
          drafts[index] = {
            ...current,
            output: outputValue(message),
            status,
            completedAt: occurredAt,
          };
        }
      }
      continue;
    }
    const prefix = interruptedPrefix(row.payload);
    if (prefix !== undefined) {
      const last = drafts.at(-1);
      if (last?.kind === "text") last.text += prefix;
      else drafts.push({ kind: "text", text: prefix });
    }
  }

  const firstSequence = Math.max(1, terminal.throughSequence - drafts.length);
  const items = drafts.map((item, index): ConversationTranscriptItemResource => {
    const sequence = Math.min(terminal.throughSequence, firstSequence + index);
    if (item.kind === "text") {
      return { ...item, firstSequence: sequence, lastSequence: sequence };
    }
    return {
      ...item,
      firstSequence: sequence,
      ...(item.completedAt === undefined ? {} : { lastSequence: sequence }),
    };
  });
  if (terminal.failure !== null || terminal.cancellation !== null) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.kind === "tool" && (item.status === "preparing" || item.status === "running")) {
        items[index] = {
          ...item,
          status: "unknown",
          lastSequence: terminal.throughSequence,
          completedAt: terminal.occurredAt,
        };
      }
    }
  }
  const { occurredAt: _occurredAt, ...terminalResource } = terminal;
  return parseConversationTurnTranscriptResource({
    schemaVersion: 1,
    ...terminalResource,
    items,
    startedSequence: firstSequence,
  });
}

export async function readCanonicalPiTurnTranscripts(
  database: Kysely<Database>,
  input: { tenantId: string; turnIds: readonly string[] },
): Promise<ReadonlyMap<string, ConversationTurnTranscriptResource>> {
  const turnIds = [...new Set(input.turnIds)];
  if (turnIds.length === 0) return new Map();
  const [entries, durableTerminalRows] = await Promise.all([
    database
      .selectFrom("pi_session_entries")
      .select(["turn_id", "seq", "timestamp_ms", "payload"])
      .where("tenant_id", "=", input.tenantId)
      .where("turn_id", "in", turnIds)
      .orderBy("seq", "asc")
      .execute(),
    database
      .selectFrom("session_terminal_events")
      .select(["turn_id", "seq", "type", "payload", "occurred_at"])
      .where("tenant_id", "=", input.tenantId)
      .where("turn_id", "in", turnIds)
      .execute(),
  ]);
  const durableTurnIds = new Set(durableTerminalRows.map((row) => row.turn_id));
  const localTurnIds = turnIds.filter((turnId) => !durableTurnIds.has(turnId));
  const localEvents =
    localTurnIds.length === 0
      ? []
      : await database
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
          .where("turn_id", "in", localTurnIds)
          .orderBy("seq", "asc")
          .execute();
  const localByTurn = new Map<string, typeof localEvents>();
  for (const event of localEvents) {
    if (event.turn_id === null) continue;
    const existing = localByTurn.get(event.turn_id) ?? [];
    existing.push(event);
    localByTurn.set(event.turn_id, existing);
  }
  const terminalByTurn = new Map<string, (typeof durableTerminalRows)[number]>(
    durableTerminalRows.map((row) => [row.turn_id, row]),
  );
  for (const [turnId, events] of localByTurn) {
    let terminal: (typeof events)[number] | undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]!;
      if (
        candidate.type === "turn.completed" ||
        candidate.type === "turn.failed" ||
        candidate.type === "turn.cancelled"
      ) {
        terminal = candidate;
        break;
      }
    }
    if (terminal !== undefined && !terminalByTurn.has(turnId)) {
      terminalByTurn.set(turnId, {
        turn_id: turnId,
        seq: terminal.seq,
        type: terminal.type as "turn.completed" | "turn.failed" | "turn.cancelled",
        payload: terminal.payload,
        occurred_at: terminal.occurred_at,
      });
    }
  }
  const entriesByTurn = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (entry.turn_id === null) continue;
    const existing = entriesByTurn.get(entry.turn_id) ?? [];
    existing.push(entry);
    entriesByTurn.set(entry.turn_id, existing);
  }

  const result = new Map<string, ConversationTurnTranscriptResource>();
  for (const turnId of turnIds) {
    const terminalRow = terminalByTurn.get(turnId);
    if (terminalRow === undefined) continue;
    const piEntries = entriesByTurn.get(turnId) ?? [];
    if (piEntries.length > 0) {
      result.set(turnId, projectPiEntries(piEntries, terminalMetadata(terminalRow)));
      continue;
    }
    const events = localByTurn.get(turnId) ?? [];
    if (events.length > 0) {
      result.set(
        turnId,
        projectConversationTurnTranscript(
          events.map((event) =>
            parsePiCloudEvent({
              schemaVersion: event.schema_version,
              eventId: event.event_id,
              sessionId: event.session_id,
              turnId: event.turn_id,
              agentId: event.agent_id,
              seq: safeInteger(event.seq, "Local conversation event sequence"),
              occurredAt: timestamp(event.occurred_at),
              type: event.type,
              payload: event.payload,
            }),
          ),
        ),
      );
      continue;
    }
    const terminal = terminalMetadata(terminalRow);
    const { occurredAt: _occurredAt, ...terminalResource } = terminal;
    result.set(
      turnId,
      parseConversationTurnTranscriptResource({
        schemaVersion: 1,
        ...terminalResource,
        items: [],
        startedSequence: terminal.throughSequence,
      }),
    );
  }
  return result;
}

export async function appendInterruptedAssistantPrefix(
  transaction: Transaction<Database>,
  input: {
    tenantId: string;
    sessionId: string;
    turnId: string;
    transcript: ConversationTurnTranscriptResource;
    now: Date;
    entryId: string;
  },
): Promise<boolean> {
  const visibleText = input.transcript.items
    .filter(
      (item): item is Extract<ConversationTranscriptItemResource, { kind: "text" }> =>
        item.kind === "text",
    )
    .map((item) => item.text)
    .join("");
  if (visibleText.length === 0) return false;
  const lane = await transaction
    .selectFrom("pi_session_lanes")
    .select("leaf_id")
    .where("tenant_id", "=", input.tenantId)
    .where("session_id", "=", input.sessionId)
    .where("lane", "=", "main")
    .forUpdate()
    .executeTakeFirst();
  if (lane === undefined) return false;
  const session = await transaction
    .selectFrom("pi_sessions")
    .select("next_seq")
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.sessionId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const existingRows = await transaction
    .selectFrom("pi_session_entries")
    .select("payload")
    .where("tenant_id", "=", input.tenantId)
    .where("turn_id", "=", input.turnId)
    .orderBy("seq", "asc")
    .execute();
  const canonicalText = existingRows
    .flatMap((row) => textParts(messageFromEntry(row.payload)))
    .join("");
  const missingText = visibleText.startsWith(canonicalText)
    ? visibleText.slice(canonicalText.length)
    : visibleText === canonicalText
      ? ""
      : visibleText;
  if (missingText.length === 0) return false;
  const sequence = safeInteger(session.next_seq, "Pi Session next sequence");
  const timestampMs = input.now.valueOf();
  const entry = {
    id: input.entryId,
    type: "custom",
    customType: INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE,
    data: { text: missingText },
    parentId: lane.leaf_id,
    seq: sequence,
    timestamp: timestampMs,
  };
  await transaction
    .insertInto("pi_session_entries")
    .values({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      id: input.entryId,
      seq: sequence,
      parent_id: lane.leaf_id,
      type: "custom",
      custom_type: INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE,
      timestamp_ms: timestampMs,
      payload: entry,
      turn_id: input.turnId,
    })
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("pi_session_lanes")
    .set({ leaf_id: input.entryId })
    .where("tenant_id", "=", input.tenantId)
    .where("session_id", "=", input.sessionId)
    .where("lane", "=", "main")
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("pi_session_log")
    .values({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      seq: sequence,
      kind: "entry",
      payload: { entryId: input.entryId },
    })
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("pi_sessions")
    .set({ next_seq: sql<string>`${sql.ref("next_seq")} + 1` })
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.sessionId)
    .where("next_seq", "=", session.next_seq)
    .executeTakeFirstOrThrow();
  return true;
}
