import type {
  AgentDockEvent,
  AgentDockEventFactory,
  CancelTurnCommandMessage,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type TurnCancellationReason = CancelTurnCommandMessage["payload"]["reason"];

export type PiAgentEventAdapterOutcome =
  | { kind: "mapped"; event: AgentDockEvent; terminal: boolean }
  | { kind: "ignored"; sourceType: string }
  | { kind: "invalid"; sourceType: string; reason: string };

const REVIEWED_IGNORED_EVENT_TYPES = new Set([
  "turn_start",
  "message_start",
  "turn_end",
  "agent_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  // The public v1 protocol publishes durable tool boundaries and the final
  // result. Pi's partial tool output is intentionally not persisted yet.
  "tool_execution_update",
  "auto_retry_start",
  "auto_retry_end",
]);

const DEFAULT_MAXIMUM_TOOL_OUTPUT_BYTES = 65_536;
const MINIMUM_TOOL_INPUT_DELTA_BYTES = 128;

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function compactionReason(value: unknown): "manual" | "threshold" | "overflow" | undefined {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function boundedToolOutput(value: unknown, maximumBytes: number): unknown {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return { truncated: true, preview: "[unserializable tool output]" };
  }
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return value;
  const marker = "\n[AgentDock truncated tool output]";
  const previewBytes = Math.max(0, maximumBytes - Buffer.byteLength(marker, "utf8"));
  return {
    truncated: true,
    preview: `${Buffer.from(serialized, "utf8").subarray(0, previewBytes).toString("utf8")}${marker}`,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}

function assistantStopReason(value: unknown): AssistantStopReason | undefined {
  if (!isRecord(value) || value.role !== "assistant") return undefined;
  switch (value.stopReason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return value.stopReason;
    default:
      return undefined;
  }
}

type StreamedToolCallIdentity = { toolCallId: string; toolName: string };

function toolCallIdentity(value: unknown): StreamedToolCallIdentity | undefined {
  if (!isRecord(value) || value.type !== "toolCall") return undefined;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    return undefined;
  }
  return { toolCallId: value.id, toolName: value.name };
}

function streamedToolCallIdentity(streamEvent: JsonRecord): StreamedToolCallIdentity | undefined {
  const contentIndex = nonNegativeInteger(streamEvent.contentIndex);
  const partial = isRecord(streamEvent.partial) ? streamEvent.partial : undefined;
  const content =
    partial !== undefined && Array.isArray(partial.content) ? partial.content : undefined;
  const toolCall = contentIndex === undefined ? undefined : content?.[contentIndex];
  return toolCallIdentity(toolCall) ?? toolCallIdentity(streamEvent.toolCall);
}

/**
 * Converts the reviewed, public subset of Pi agent events into AgentDock v1
 * events. Pi event objects never leave this adapter.
 */
export class PiAgentEventAdapter {
  readonly #eventFactory: AgentDockEventFactory;
  readonly #inputKind: "prompt" | "continue";
  #agentStarted = false;
  #settled = false;
  #lastAssistantStopReason: AssistantStopReason | undefined;
  #cancellationReason: TurnCancellationReason | undefined;
  #compactionActive = false;
  readonly #pendingToolInputDeltas = new Map<string, { toolName: string; delta: string }>();
  readonly #maximumToolOutputBytes: number;

  constructor(
    eventFactory: AgentDockEventFactory,
    options: { inputKind: "prompt" | "continue"; maximumToolOutputBytes?: number },
  ) {
    this.#eventFactory = eventFactory;
    this.#inputKind = options.inputKind;
    const maximum = options.maximumToolOutputBytes ?? DEFAULT_MAXIMUM_TOOL_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1_024 || maximum > 1_048_576) {
      throw new TypeError("maximumToolOutputBytes must be between 1024 and 1048576");
    }
    this.#maximumToolOutputBytes = maximum;
  }

  requestCancellation(reason: TurnCancellationReason): void {
    if (this.#settled) {
      throw new Error("Pi run already settled before cancellation");
    }
    if (this.#cancellationReason !== undefined && this.#cancellationReason !== reason) {
      throw new Error("Pi cancellation reason changed during one run");
    }
    this.#cancellationReason = reason;
  }

  forceCancellation(reason: TurnCancellationReason): PiAgentEventAdapterOutcome {
    this.requestCancellation(reason);
    this.#settled = true;
    return this.#cancelled(reason, true);
  }

  #toolInputDelta(
    identity: StreamedToolCallIdentity,
    delta: string,
    flush: boolean,
  ): PiAgentEventAdapterOutcome {
    const pending = this.#pendingToolInputDeltas.get(identity.toolCallId);
    if (pending !== undefined && pending.toolName !== identity.toolName) {
      return {
        kind: "invalid",
        sourceType: "message_update.toolcall_delta",
        reason: "Pi changed a streamed tool name for one call ID",
      };
    }
    const combined = `${pending?.delta ?? ""}${delta}`;
    if (!flush && Buffer.byteLength(combined, "utf8") < MINIMUM_TOOL_INPUT_DELTA_BYTES) {
      this.#pendingToolInputDeltas.set(identity.toolCallId, {
        toolName: identity.toolName,
        delta: combined,
      });
      return { kind: "ignored", sourceType: "message_update.toolcall_delta.buffered" };
    }
    this.#pendingToolInputDeltas.delete(identity.toolCallId);
    if (combined.length === 0) {
      return { kind: "ignored", sourceType: "message_update.toolcall_delta.empty" };
    }
    return {
      kind: "mapped",
      terminal: false,
      event: this.#eventFactory.next({
        type: "tool.input.delta",
        payload: { ...identity, delta: combined },
      }),
    };
  }

  adapt(value: unknown): PiAgentEventAdapterOutcome {
    const type = sourceType(value);
    if (!isRecord(value) || typeof value.type !== "string") {
      return { kind: "invalid", sourceType: type, reason: "Pi event must be a JSON object" };
    }
    if (this.#settled) {
      return {
        kind: "invalid",
        sourceType: value.type,
        reason: "Pi emitted an event after the run settled",
      };
    }

    if (value.type === "agent_start") {
      if (this.#agentStarted || this.#settled) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi emitted agent_start outside the initial run boundary",
        };
      }
      this.#agentStarted = true;
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "turn.started",
          payload: { inputKind: this.#inputKind },
        }),
      };
    }

    if (value.type === "message_update") {
      const streamEvent = value.assistantMessageEvent;
      if (!isRecord(streamEvent) || typeof streamEvent.type !== "string") {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi message_update is missing assistantMessageEvent",
        };
      }
      if (streamEvent.type === "toolcall_delta") {
        if (typeof streamEvent.delta !== "string") {
          return {
            kind: "invalid",
            sourceType: "message_update.toolcall_delta",
            reason: "Pi toolcall_delta is missing its JSON fragment",
          };
        }
        if (streamEvent.delta.length === 0) {
          return { kind: "ignored", sourceType: "message_update.toolcall_delta.empty" };
        }
        const identity = streamedToolCallIdentity(streamEvent);
        if (identity === undefined) {
          // Some compatible providers do not attach a tool-call ID until a
          // later chunk. The final tool_execution_start remains authoritative,
          // so a missing optional preview identity must not fail the run.
          return { kind: "ignored", sourceType: "message_update.toolcall_delta.unidentified" };
        }
        return this.#toolInputDelta(identity, streamEvent.delta, false);
      }
      if (streamEvent.type === "toolcall_end") {
        const identity = streamedToolCallIdentity(streamEvent);
        if (identity === undefined) {
          return { kind: "ignored", sourceType: "message_update.toolcall_end.unidentified" };
        }
        return this.#toolInputDelta(identity, "", true);
      }
      if (streamEvent.type !== "text_delta") {
        return { kind: "ignored", sourceType: `message_update.${streamEvent.type}` };
      }
      if (typeof streamEvent.delta !== "string") {
        return {
          kind: "invalid",
          sourceType: "message_update.text_delta",
          reason: "Pi text_delta is missing its text",
        };
      }
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "assistant.text.delta",
          payload: { text: streamEvent.delta },
        }),
      };
    }

    if (value.type === "tool_execution_start") {
      if (
        typeof value.toolCallId !== "string" ||
        value.toolCallId.length === 0 ||
        typeof value.toolName !== "string" ||
        value.toolName.length === 0
      ) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi tool start is missing its call ID or tool name",
        };
      }
      this.#pendingToolInputDeltas.delete(value.toolCallId);
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "tool.started",
          payload: {
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.args ?? null,
          },
        }),
      };
    }

    if (value.type === "tool_execution_end") {
      if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi tool completion is missing its call ID",
        };
      }
      if (typeof value.isError !== "boolean") {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi tool completion is missing its error state",
        };
      }
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "tool.completed",
          payload: {
            toolCallId: value.toolCallId,
            isError: value.isError,
            ...(value.result === undefined
              ? {}
              : { output: boundedToolOutput(value.result, this.#maximumToolOutputBytes) }),
          },
        }),
      };
    }

    if (value.type === "compaction_start") {
      const reason = compactionReason(value.reason);
      if (!this.#agentStarted || this.#compactionActive || reason === undefined) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi compaction start is outside a valid active boundary",
        };
      }
      this.#compactionActive = true;
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "context.compaction.started",
          payload: { reason },
        }),
      };
    }

    if (value.type === "compaction_end") {
      const reason = compactionReason(value.reason);
      if (!this.#agentStarted || !this.#compactionActive || reason === undefined) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi compaction completion has no matching active compaction",
        };
      }
      if (typeof value.aborted !== "boolean" || typeof value.willRetry !== "boolean") {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi compaction completion is missing its settlement state",
        };
      }
      const result = isRecord(value.result) ? value.result : undefined;
      const tokensBefore = nonNegativeInteger(result?.tokensBefore);
      const estimatedTokensAfter = nonNegativeInteger(result?.estimatedTokensAfter);
      const firstKeptEntryId =
        typeof result?.firstKeptEntryId === "string" && result.firstKeptEntryId.length > 0
          ? result.firstKeptEntryId.slice(0, 256)
          : undefined;
      const summarySha256 =
        typeof result?.summary === "string"
          ? createHash("sha256").update(result.summary, "utf8").digest("hex")
          : undefined;
      this.#compactionActive = false;
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "context.compaction.completed",
          payload: {
            reason,
            status: value.aborted ? "aborted" : result === undefined ? "failed" : "completed",
            willRetry: value.willRetry,
            ...(tokensBefore === undefined ? {} : { tokensBefore }),
            ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
            ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
            ...(summarySha256 === undefined ? {} : { summarySha256, summaryVersion: 1 }),
          },
        }),
      };
    }

    if (value.type === "message_end") {
      this.#lastAssistantStopReason =
        assistantStopReason(value.message) ?? this.#lastAssistantStopReason;
      return { kind: "ignored", sourceType: value.type };
    }

    if (value.type === "turn_end") {
      this.#lastAssistantStopReason =
        assistantStopReason(value.message) ?? this.#lastAssistantStopReason;
      return { kind: "ignored", sourceType: value.type };
    }

    if (value.type === "agent_end" && Array.isArray(value.messages)) {
      for (let index = value.messages.length - 1; index >= 0; index -= 1) {
        const stopReason = assistantStopReason(value.messages[index]);
        if (stopReason !== undefined) {
          this.#lastAssistantStopReason = stopReason;
          break;
        }
      }
      return { kind: "ignored", sourceType: value.type };
    }

    if (value.type === "agent_settled") {
      if (!this.#agentStarted || this.#settled) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi emitted agent_settled without one active run",
        };
      }
      this.#settled = true;
      if (this.#cancellationReason !== undefined) {
        return this.#cancelled(this.#cancellationReason, false);
      }
      if (this.#lastAssistantStopReason === "error") {
        return {
          kind: "mapped",
          terminal: true,
          event: this.#eventFactory.next({
            type: "turn.failed",
            payload: { code: "model_error", message: "Model request failed", retryable: true },
          }),
        };
      }
      if (this.#lastAssistantStopReason === "aborted") {
        return {
          kind: "mapped",
          terminal: true,
          event: this.#eventFactory.next({
            type: "turn.failed",
            payload: { code: "turn_aborted", message: "Turn was aborted", retryable: false },
          }),
        };
      }
      if (this.#lastAssistantStopReason === undefined) {
        return {
          kind: "mapped",
          terminal: true,
          event: this.#eventFactory.next({
            type: "turn.failed",
            payload: {
              code: "pi_protocol_error",
              message: "Pi settled without an assistant result",
              retryable: false,
            },
          }),
        };
      }
      return {
        kind: "mapped",
        terminal: true,
        event: this.#eventFactory.next({
          type: "turn.completed",
          payload: { stopReason: this.#lastAssistantStopReason },
        }),
      };
    }

    if (REVIEWED_IGNORED_EVENT_TYPES.has(value.type)) {
      return { kind: "ignored", sourceType: value.type };
    }

    return {
      kind: "invalid",
      sourceType: value.type,
      reason: "No reviewed AgentDock v1 mapping exists for this Pi event type",
    };
  }

  #cancelled(reason: TurnCancellationReason, forced: boolean): PiAgentEventAdapterOutcome {
    return {
      kind: "mapped",
      terminal: true,
      event: this.#eventFactory.next({
        type: "turn.cancelled",
        payload: { reason, forced },
      }),
    };
  }
}
