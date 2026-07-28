import { SessionManager } from "@earendil-works/pi-coding-agent";

export const PI_INTERRUPTION_CUSTOM_TYPE = "agent-dock.run_interrupted";

export function piInterruptionMessage(reason: string): string {
  return [
    "<run_interrupted>",
    `The previous Agent Run ended before a successful commit (reason: ${reason}).`,
    "Some Tool commands may have partially executed and Workspace state may have changed.",
    "Inspect the current Workspace before continuing. Do not treat incomplete streamed text as a final answer.",
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
      runId: input.runId,
      attemptId: input.attemptId,
      reason: input.reason,
    },
  );
}
