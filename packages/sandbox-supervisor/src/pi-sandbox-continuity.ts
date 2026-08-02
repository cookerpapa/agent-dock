import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const PI_SANDBOX_STATE_CUSTOM_TYPE = "agent-dock.sandbox_state";
export const PI_SANDBOX_RESET_CUSTOM_TYPE = "agent-dock.sandbox_reset";
export const PI_SANDBOX_RESET_MESSAGE = [
  "<sandbox_reset>",
  "The previous sandbox is no longer available. The committed workspace is preserved, but running processes and in-memory environment state were not carried forward.",
  "</sandbox_reset>",
].join("\n");

type SandboxState =
  { status: "active"; activationId: string } | { status: "unavailable"; activationId: string };

function sandboxState(entry: SessionEntry): SandboxState | undefined {
  if (entry.type !== "custom" || entry.customType !== PI_SANDBOX_STATE_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("status" in data) ||
    !("activationId" in data)
  ) {
    return undefined;
  }
  if (
    (data.status !== "active" && data.status !== "unavailable") ||
    typeof data.activationId !== "string"
  ) {
    return undefined;
  }
  return { status: data.status, activationId: data.activationId };
}

function latestSandboxState(sessionManager: SessionManager): SandboxState | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = sandboxState(entries[index]!);
    if (state !== undefined) return state;
  }
  return undefined;
}

function appendSandboxReset(sessionManager: SessionManager, activationId: string): void {
  sessionManager.appendCustomMessageEntry(
    PI_SANDBOX_RESET_CUSTOM_TYPE,
    PI_SANDBOX_RESET_MESSAGE,
    false,
  );
  sessionManager.appendCustomEntry(PI_SANDBOX_STATE_CUSTOM_TYPE, {
    status: "unavailable",
    activationId,
  } satisfies SandboxState);
}

export function preparePiSandboxContinuity(
  sessionManager: SessionManager,
  input: { activationId: string; continuity: "cold_restore" | "warm_reuse" },
): void {
  const previous = latestSandboxState(sessionManager);
  if (previous?.status !== "active") return;
  if (input.continuity === "warm_reuse" && previous.activationId === input.activationId) return;
  appendSandboxReset(sessionManager, previous.activationId);
}

export function recordPiSandboxActive(sessionManager: SessionManager, activationId: string): void {
  const previous = latestSandboxState(sessionManager);
  if (previous?.status === "active" && previous.activationId === activationId) return;
  sessionManager.appendCustomEntry(PI_SANDBOX_STATE_CUSTOM_TYPE, {
    status: "active",
    activationId,
  } satisfies SandboxState);
}

export function recordPiSandboxUnavailable(
  sessionManager: SessionManager,
  activationId: string,
): void {
  const previous = latestSandboxState(sessionManager);
  if (previous?.status === "unavailable" && previous.activationId === activationId) return;
  appendSandboxReset(sessionManager, activationId);
}
