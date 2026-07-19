import type {
  AgentDockEvent,
  AgentDockEventFactory,
  CancelTurnCommandMessage,
} from "@agent-dock/protocol";

type JsonRecord = Record<string, unknown>;

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type TurnCancellationReason = CancelTurnCommandMessage["payload"]["reason"];

export type PiRpcAgentEventAdapterOutcome =
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
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);

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

/**
 * Converts the reviewed, public subset of Pi agent events into AgentDock v1
 * events. Pi event objects never leave this adapter.
 */
export class PiRpcAgentEventAdapter {
  readonly #eventFactory: AgentDockEventFactory;
  readonly #inputKind: "prompt" | "continue";
  #agentStarted = false;
  #settled = false;
  #lastAssistantStopReason: AssistantStopReason | undefined;
  #cancellationReason: TurnCancellationReason | undefined;

  constructor(eventFactory: AgentDockEventFactory, options: { inputKind: "prompt" | "continue" }) {
    this.#eventFactory = eventFactory;
    this.#inputKind = options.inputKind;
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

  forceCancellation(reason: TurnCancellationReason): PiRpcAgentEventAdapterOutcome {
    this.requestCancellation(reason);
    this.#settled = true;
    return this.#cancelled(reason, true);
  }

  adapt(value: unknown): PiRpcAgentEventAdapterOutcome {
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
            ...(value.result === undefined ? {} : { output: value.result }),
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

  #cancelled(reason: TurnCancellationReason, forced: boolean): PiRpcAgentEventAdapterOutcome {
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
