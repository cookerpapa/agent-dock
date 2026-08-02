import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiDurableRecoverySuffix } from "./sandbox-checkpoint.ts";

export const PI_DURABLE_RECOVERY_CUSTOM_TYPE = "agent-dock.durable_crash_recovery";
const MAX_RECOVERY_MESSAGE_BYTES = 512 * 1_024;
const MAX_COMPACT_PROMPT_CHARACTERS = 2_048;
const MAX_COMPACT_VISIBLE_ITEMS = 8;
const MAX_COMPACT_ITEM_CHARACTERS = 1_024;

function truncateText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  return `${value.slice(0, maximumCharacters)}\n[truncated]`;
}

function serializedWithinLimit(value: unknown): string | undefined {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8") <= MAX_RECOVERY_MESSAGE_BYTES
    ? serialized
    : undefined;
}

function compactJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return truncateText(serialized ?? String(value), MAX_COMPACT_ITEM_CHARACTERS);
}

function terminalSummary(turn: PiDurableRecoverySuffix["turns"][number]): unknown {
  if (turn.transcript.failure !== null) {
    return {
      status: "failed",
      message: truncateText(turn.transcript.failure.message, MAX_COMPACT_ITEM_CHARACTERS),
    };
  }
  if (turn.transcript.cancellation !== null) return { status: "cancelled" };
  return { status: turn.transcript.stopReason ?? "interrupted" };
}

function compactRecoveryTurns(suffix: PiDurableRecoverySuffix): unknown[] {
  return suffix.turns.map((turn) => ({
    userPrompt: truncateText(turn.input, MAX_COMPACT_PROMPT_CHARACTERS),
    visibleItems: turn.transcript.items.slice(0, MAX_COMPACT_VISIBLE_ITEMS).map((item): unknown => {
      if (item.kind === "text") {
        return {
          kind: "assistant_text",
          text: truncateText(item.text, MAX_COMPACT_ITEM_CHARACTERS),
        };
      }
      if (item.kind === "tool") {
        return {
          kind: "tool",
          toolName: item.toolName,
          input: compactJson(item.input),
          ...(item.output === undefined ? {} : { output: compactJson(item.output) }),
          status:
            item.status === "preparing" || item.status === "running" ? "unknown" : item.status,
        };
      }
      if (item.kind === "notification") {
        return {
          kind: "notification",
          level: item.level,
          message: truncateText(item.message, MAX_COMPACT_ITEM_CHARACTERS),
        };
      }
      return {
        kind: "approval",
        approval: compactJson(item.approval),
        ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      };
    }),
    terminal: terminalSummary(turn),
  }));
}

function recoveryTurns(suffix: PiDurableRecoverySuffix): unknown[] {
  return suffix.turns.map((turn) => ({
    userPrompt: turn.input,
    visibleItems: turn.transcript.items.map((item) => {
      if (item.kind === "text") {
        return { kind: "assistant_text", text: item.text };
      }
      if (item.kind === "tool") {
        return {
          kind: "tool",
          toolName: item.toolName,
          input: item.input,
          ...(item.output === undefined ? {} : { output: item.output }),
          status:
            item.status === "preparing" || item.status === "running" ? "unknown" : item.status,
        };
      }
      if (item.kind === "notification") {
        return { kind: "notification", level: item.level, message: item.message };
      }
      return {
        kind: "approval",
        approval: item.approval,
        ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      };
    }),
    terminal: terminalSummary(turn),
  }));
}

function recoveryEnvelope(turns: unknown[]) {
  return {
    notice:
      "The previous turn ended unexpectedly before Pi persisted its native session. " +
      "The following user-visible events were durably recorded. " +
      "Tool calls marked unknown may or may not have completed.",
    turns,
  };
}

export function appendPiDurableRecovery(
  sessionManager: SessionManager,
  suffix: PiDurableRecoverySuffix,
): void {
  const turns = recoveryTurns(suffix);
  const content =
    serializedWithinLimit(recoveryEnvelope(turns)) ??
    serializedWithinLimit(recoveryEnvelope(compactRecoveryTurns(suffix))) ??
    JSON.stringify({
      notice: "The previous turn ended unexpectedly. Some durably recorded context was truncated.",
      turns: suffix.turns.map((turn) => ({
        userPrompt: truncateText(turn.input, 512),
      })),
    });
  sessionManager.appendCustomMessageEntry(PI_DURABLE_RECOVERY_CUSTOM_TYPE, content, false, {
    checkpointThroughSequence: suffix.checkpointThroughSequence,
    recoveredThroughSequence: suffix.recoveredThroughSequence,
    recoveredTurnIds: suffix.turns.map((turn) => turn.turnId),
  });
}
