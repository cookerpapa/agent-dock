import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiDurableRecoverySuffix } from "./sandbox-checkpoint.ts";
import {
  PI_INTERRUPTION_REPLAY_GUIDANCE,
  PI_INTERRUPTION_STATE_GUIDANCE,
  PI_INTERRUPTION_VERIFICATION_GUIDANCE,
} from "./pi-interrupted-session.ts";

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

function compactRecoveryTurns(suffix: PiDurableRecoverySuffix): unknown[] {
  return suffix.turns.map((turn) => ({
    turnId: turn.turnId,
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
          toolCallId: item.toolCallId,
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
    terminal: {
      stopReason: turn.transcript.stopReason,
      failure:
        turn.transcript.failure === null
          ? null
          : {
              ...turn.transcript.failure,
              message: truncateText(turn.transcript.failure.message, MAX_COMPACT_ITEM_CHARACTERS),
            },
      cancellation: turn.transcript.cancellation,
    },
  }));
}

function recoveryTurns(suffix: PiDurableRecoverySuffix): unknown[] {
  return suffix.turns.map((turn) => ({
    turnId: turn.turnId,
    userPrompt: turn.input,
    visibleItems: turn.transcript.items.map((item) => {
      if (item.kind === "text") {
        return { kind: "assistant_text", text: item.text };
      }
      if (item.kind === "tool") {
        return {
          kind: "tool",
          toolCallId: item.toolCallId,
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
    terminal: {
      stopReason: turn.transcript.stopReason,
      failure: turn.transcript.failure,
      cancellation: turn.transcript.cancellation,
    },
  }));
}

function recoveryEnvelope(suffix: PiDurableRecoverySuffix, turns: unknown[]) {
  return {
    schemaVersion: 2,
    warning:
      "These durable public events were produced after the latest Pi checkpoint. " +
      "The previous Worker ended before it could persist native Pi state. " +
      "Treat running or preparing Tool calls as UNKNOWN.",
    recoveryGuidance: {
      stateUncertain: true,
      verificationRequiredBeforeContinuation: true,
      state: PI_INTERRUPTION_STATE_GUIDANCE,
      nextTurn: PI_INTERRUPTION_VERIFICATION_GUIDANCE,
      replay: PI_INTERRUPTION_REPLAY_GUIDANCE,
    },
    checkpointThroughSequence: suffix.checkpointThroughSequence,
    recoveredThroughSequence: suffix.recoveredThroughSequence,
    turns,
  };
}

export function appendPiDurableRecovery(
  sessionManager: SessionManager,
  suffix: PiDurableRecoverySuffix,
): void {
  const turns = recoveryTurns(suffix);
  const content =
    serializedWithinLimit(recoveryEnvelope(suffix, turns)) ??
    serializedWithinLimit(recoveryEnvelope(suffix, compactRecoveryTurns(suffix))) ??
    JSON.stringify({
      schemaVersion: 2,
      warning: "Durable crash recovery metadata was truncated.",
      recoveryGuidance: {
        stateUncertain: true,
        verificationRequiredBeforeContinuation: true,
        nextTurn: PI_INTERRUPTION_VERIFICATION_GUIDANCE,
        replay: PI_INTERRUPTION_REPLAY_GUIDANCE,
      },
      checkpointThroughSequence: suffix.checkpointThroughSequence,
      recoveredThroughSequence: suffix.recoveredThroughSequence,
      turns: suffix.turns.map((turn) => ({
        turnId: turn.turnId,
        userPrompt: truncateText(turn.input, 512),
      })),
    });
  sessionManager.appendCustomMessageEntry(PI_DURABLE_RECOVERY_CUSTOM_TYPE, content, false, {
    checkpointThroughSequence: suffix.checkpointThroughSequence,
    recoveredThroughSequence: suffix.recoveredThroughSequence,
    recoveredTurnIds: suffix.turns.map((turn) => turn.turnId),
  });
}
