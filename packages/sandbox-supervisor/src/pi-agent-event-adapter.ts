import type {
  PiCloudEvent,
  PiCloudEventFactory,
  CancelTurnCommandMessage,
  ModelSamplingIdentity,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type TurnCancellationReason = CancelTurnCommandMessage["payload"]["reason"];

export type PiAgentEventAdapterOutcome =
  | { kind: "mapped"; event: PiCloudEvent; terminal: false }
  | {
      kind: "settled";
      terminal: true;
      result:
        | { status: "completed"; stopReason: AssistantStopReason }
        | { status: "failed"; code: string; message: string; retryable: boolean }
        | { status: "cancelled"; reason: TurnCancellationReason; forced: boolean };
    }
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
  "auto_retry_end",
  // Pi 0.84 emits these around retryable compaction/branch-summary requests.
  // The governed model-request ledger already records every attempt; these
  // transient UI lifecycle events carry no additional canonical conversation
  // state and therefore stay out of the public PiCloud event stream.
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

const DEFAULT_MAXIMUM_TOOL_OUTPUT_BYTES = 65_536;

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
  const marker = "\n[PiCloud truncated tool output]";
  const previewBytes = Math.max(0, maximumBytes - Buffer.byteLength(marker, "utf8"));
  return {
    truncated: true,
    preview: `${Buffer.from(serialized, "utf8").subarray(0, previewBytes).toString("utf8")}${marker}`,
  };
}

function toolResultIsUnknown(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.includes("cubesandbox_tool_result_unknown");
  } catch {
    return false;
  }
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

/**
 * Converts the reviewed, public subset of Pi agent events into PiCloud v1
 * events. Pi event objects never leave this adapter.
 */
export class PiAgentEventAdapter {
  readonly #eventFactory: PiCloudEventFactory;
  readonly #inputKind: "prompt" | "continue";
  #agentStarted = false;
  #piTurnActive = false;
  #settled = false;
  #lastAssistantStopReason: AssistantStopReason | undefined;
  #cancellationReason: TurnCancellationReason | undefined;
  #compactionActive = false;
  #activeSampling: ModelSamplingIdentity | undefined;
  #lastCompletedSampling: ModelSamplingIdentity | undefined;
  readonly #maximumToolOutputBytes: number;
  readonly #requireSamplingIdentity: boolean;

  constructor(
    eventFactory: PiCloudEventFactory,
    options: {
      inputKind: "prompt" | "continue";
      maximumToolOutputBytes?: number;
      requireSamplingIdentity?: boolean;
    },
  ) {
    this.#eventFactory = eventFactory;
    this.#inputKind = options.inputKind;
    const maximum = options.maximumToolOutputBytes ?? DEFAULT_MAXIMUM_TOOL_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1_024 || maximum > 1_048_576) {
      throw new TypeError("maximumToolOutputBytes must be between 1024 and 1048576");
    }
    this.#maximumToolOutputBytes = maximum;
    this.#requireSamplingIdentity = options.requireSamplingIdentity ?? false;
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

  samplingStarted(identity: ModelSamplingIdentity): PiCloudEvent {
    if (this.#settled || !this.#agentStarted || this.#activeSampling !== undefined) {
      throw new Error("Model sampling started outside an idle active Run boundary");
    }
    if (
      this.#lastCompletedSampling !== undefined &&
      (identity.stepSequence < this.#lastCompletedSampling.stepSequence ||
        (identity.stepSequence === this.#lastCompletedSampling.stepSequence &&
          identity.samplingAttempt !== this.#lastCompletedSampling.samplingAttempt + 1))
    ) {
      throw new Error("Model sampling identity did not advance monotonically");
    }
    this.#activeSampling = identity;
    return this.#eventFactory.next({
      type: "model.sampling.started",
      payload: identity,
    });
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
      if (this.#piTurnActive || this.#settled) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi emitted overlapping agent_start boundaries",
        };
      }
      this.#piTurnActive = true;
      if (this.#agentStarted) {
        // A Run can contain multiple native Pi turns: transient retry,
        // compaction recovery, Tool continuation, or a bounded follow-up.
        return { kind: "ignored", sourceType: value.type };
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
        // Tool arguments can arrive as hundreds of tiny provider fragments.
        // The validated complete arguments are published once at
        // tool_execution_start, so partial JSON is not a public event.
        return { kind: "ignored", sourceType: "message_update.toolcall_delta" };
      }
      if (streamEvent.type === "toolcall_end") {
        return { kind: "ignored", sourceType: "message_update.toolcall_end" };
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
            ...(this.#lastCompletedSampling ?? {}),
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
            ...(this.#lastCompletedSampling ?? {}),
            outcome: value.isError
              ? toolResultIsUnknown(value.result)
                ? "unknown"
                : "failed"
              : "completed",
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
      const stopReason = assistantStopReason(value.message);
      this.#lastAssistantStopReason = stopReason ?? this.#lastAssistantStopReason;
      if (stopReason === undefined) return { kind: "ignored", sourceType: value.type };
      if (this.#activeSampling === undefined) {
        if (!this.#requireSamplingIdentity) {
          return { kind: "ignored", sourceType: value.type };
        }
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi completed an assistant sampling without an active Cloud Step",
        };
      }
      const sampling = this.#activeSampling;
      this.#activeSampling = undefined;
      this.#lastCompletedSampling = sampling;
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "model.sampling.completed",
          payload: {
            ...sampling,
            outcome:
              stopReason === "error"
                ? "failed"
                : stopReason === "aborted"
                  ? "aborted"
                  : "completed",
            stopReason,
          },
        }),
      };
    }

    if (value.type === "auto_retry_start") {
      if (!this.#requireSamplingIdentity && this.#lastCompletedSampling === undefined) {
        return { kind: "ignored", sourceType: value.type };
      }
      const attempt = nonNegativeInteger(value.attempt);
      const maxAttempts = nonNegativeInteger(value.maxAttempts);
      const delayMs = nonNegativeInteger(value.delayMs);
      if (
        attempt === undefined ||
        attempt < 1 ||
        maxAttempts === undefined ||
        maxAttempts < attempt ||
        delayMs === undefined ||
        delayMs > 300_000 ||
        this.#lastCompletedSampling === undefined ||
        this.#lastCompletedSampling.samplingAttempt !== attempt
      ) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi model retry scheduling did not match the completed Cloud Step attempt",
        };
      }
      return {
        kind: "mapped",
        terminal: false,
        event: this.#eventFactory.next({
          type: "model.sampling.retry.scheduled",
          payload: {
            stepSequence: this.#lastCompletedSampling.stepSequence,
            stepSha256: this.#lastCompletedSampling.stepSha256,
            completedSamplingAttempt: attempt,
            nextSamplingAttempt: attempt + 1,
            maximumSamplingAttempts: maxAttempts + 1,
            delayMs,
          },
        }),
      };
    }

    if (value.type === "turn_end") {
      this.#lastAssistantStopReason =
        assistantStopReason(value.message) ?? this.#lastAssistantStopReason;
      return { kind: "ignored", sourceType: value.type };
    }

    if (value.type === "agent_end" && Array.isArray(value.messages)) {
      if (!this.#piTurnActive) {
        return {
          kind: "invalid",
          sourceType: value.type,
          reason: "Pi emitted agent_end without an active Pi turn",
        };
      }
      this.#piTurnActive = false;
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
      this.#piTurnActive = false;
      this.#settled = true;
      if (this.#cancellationReason !== undefined) {
        return this.#cancelled(this.#cancellationReason, false);
      }
      if (this.#lastAssistantStopReason === "error") {
        return {
          kind: "settled",
          terminal: true,
          result: {
            status: "failed",
            code: "model_error",
            message: "Model request failed",
            retryable: true,
          },
        };
      }
      if (this.#lastAssistantStopReason === "aborted") {
        return {
          kind: "settled",
          terminal: true,
          result: {
            status: "failed",
            code: "turn_aborted",
            message: "Turn was aborted",
            retryable: false,
          },
        };
      }
      if (this.#lastAssistantStopReason === undefined) {
        return {
          kind: "settled",
          terminal: true,
          result: {
            status: "failed",
            code: "pi_protocol_error",
            message: "Pi settled without an assistant result",
            retryable: false,
          },
        };
      }
      return {
        kind: "settled",
        terminal: true,
        result: { status: "completed", stopReason: this.#lastAssistantStopReason },
      };
    }

    if (REVIEWED_IGNORED_EVENT_TYPES.has(value.type)) {
      return { kind: "ignored", sourceType: value.type };
    }

    return {
      kind: "invalid",
      sourceType: value.type,
      reason: `No reviewed PiCloud v1 mapping exists for Pi event type: ${value.type.slice(0, 128)}`,
    };
  }

  #cancelled(reason: TurnCancellationReason, forced: boolean): PiAgentEventAdapterOutcome {
    return {
      kind: "settled",
      terminal: true,
      result: { status: "cancelled", reason, forced },
    };
  }
}
