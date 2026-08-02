import { SessionManager } from "@earendil-works/pi-coding-agent";

export const PI_INTERRUPTION_CUSTOM_TYPE = "agent-dock.run_interrupted";
export const PI_INTERRUPTION_MESSAGE = [
  "<turn_aborted>",
  "The previous turn was interrupted. Any commands that were stopped may have partially executed, and background processes may still be running.",
  "</turn_aborted>",
].join("\n");

export function piInterruptionMessage(): string {
  return PI_INTERRUPTION_MESSAGE;
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
    piInterruptionMessage(),
    false,
    {
      runId: input.runId,
      attemptId: input.attemptId,
      reason: input.reason,
    },
  );
}
