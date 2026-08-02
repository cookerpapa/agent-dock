import { SessionManager } from "@earendil-works/pi-coding-agent";

export const PI_INTERRUPTION_CUSTOM_TYPE = "agent-dock.run_interrupted";
export const PI_INTERRUPTION_STATE_GUIDANCE =
  "Tool calls or commands may have partially executed, and background processes may still be running.";
export const PI_INTERRUPTION_VERIFICATION_GUIDANCE =
  "If the next request continues or depends on the interrupted work, proactively establish the current Workspace and process state with the least-invasive relevant checks before making more changes.";
export const PI_INTERRUPTION_REPLAY_GUIDANCE =
  "Do not blindly repeat a side-effecting command whose completion is uncertain; verify its effects first.";

const MAX_REASON_CHARACTERS = 160;

function safeReason(reason: string): string {
  const bounded = reason.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_REASON_CHARACTERS);
  return bounded.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function piInterruptionMessage(reason: string): string {
  return [
    "<run_interrupted>",
    `The previous Agent Run was interrupted before a successful commit (reason: ${safeReason(reason)}).`,
    PI_INTERRUPTION_STATE_GUIDANCE,
    PI_INTERRUPTION_VERIFICATION_GUIDANCE,
    PI_INTERRUPTION_REPLAY_GUIDANCE,
    "Do not treat incomplete streamed text as a final answer. Follow the user's newest request if it supersedes the interrupted work.",
    "</run_interrupted>",
  ].join("\n");
}

export function piSessionEntryIds(bytes: Uint8Array | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (bytes === undefined) return ids;
  for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "id" in parsed &&
        typeof parsed.id === "string"
      ) {
        ids.add(parsed.id);
      }
    } catch {
      // The checkpoint validator remains authoritative. This helper only
      // identifies entries that predated the current Run.
    }
  }
  return ids;
}

export function appendPiInterruption(
  sessionManager: SessionManager,
  input: {
    baseEntryIds: ReadonlySet<string>;
    acceptedPrompt: string;
    reason: string;
    runId: string;
    attemptId: string;
    timestamp: number;
  },
): void {
  const currentEntries = () =>
    sessionManager.getEntries().filter((entry) => !input.baseEntryIds.has(entry.id));
  const acceptedPromptPresent = currentEntries().some(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!acceptedPromptPresent) {
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: input.acceptedPrompt }],
      timestamp: input.timestamp,
    });
  }
  const markerPresent = currentEntries().some(
    (entry) => entry.type === "custom_message" && entry.customType === PI_INTERRUPTION_CUSTOM_TYPE,
  );
  if (markerPresent) return;
  sessionManager.appendCustomMessageEntry(
    PI_INTERRUPTION_CUSTOM_TYPE,
    piInterruptionMessage(input.reason),
    false,
    {
      schemaVersion: 2,
      runId: input.runId,
      attemptId: input.attemptId,
      reason: input.reason,
      stateUncertain: true,
      verificationRequiredBeforeContinuation: true,
    },
  );
}
