import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE = "agent-dock.runtime_world_state";
export const PI_SANDBOX_RESET_CUSTOM_TYPE = "agent-dock.sandbox_reset";
export const PI_SANDBOX_RESET_MESSAGE = [
  "<sandbox_reset>",
  "The previous sandbox is no longer available. The committed workspace is preserved, but running processes and in-memory environment state were not carried forward.",
  "</sandbox_reset>",
].join("\n");

export type PiRuntimeWorldState = Readonly<{
  schemaVersion: 1;
  sandbox: Readonly<{
    status: "active" | "unavailable";
    continuityId: string;
  }>;
  environmentSha256: string;
  committedWorkspaceRevision: string | null;
  toolPolicySha256: string;
}>;

export type PiSandboxContinuity = Readonly<{
  activationId: string;
  continuity: "cold_restore" | "warm_reuse";
  environmentSha256: string;
  committedWorkspaceRevision: string | null;
  toolPolicySha256: string;
}>;

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function runtimeWorldState(entry: SessionEntry): PiRuntimeWorldState | undefined {
  if (entry.type !== "custom" || entry.customType !== PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as Record<string, unknown>;
  const sandbox = candidate.sandbox;
  if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) return undefined;
  const sandboxCandidate = sandbox as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    (sandboxCandidate.status !== "active" && sandboxCandidate.status !== "unavailable") ||
    typeof sandboxCandidate.continuityId !== "string" ||
    !sha256(candidate.environmentSha256) ||
    (candidate.committedWorkspaceRevision !== null &&
      !sha256(candidate.committedWorkspaceRevision)) ||
    !sha256(candidate.toolPolicySha256)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sandbox: {
      status: sandboxCandidate.status,
      continuityId: sandboxCandidate.continuityId,
    },
    environmentSha256: candidate.environmentSha256,
    committedWorkspaceRevision: candidate.committedWorkspaceRevision,
    toolPolicySha256: candidate.toolPolicySha256,
  };
}

function latestRuntimeWorldState(sessionManager: SessionManager): PiRuntimeWorldState | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = runtimeWorldState(entries[index]!);
    if (state !== undefined) return state;
  }
  return undefined;
}

function worldState(
  input: Omit<PiSandboxContinuity, "continuity">,
  status: "active" | "unavailable",
): PiRuntimeWorldState {
  return {
    schemaVersion: 1,
    sandbox: { status, continuityId: input.activationId },
    environmentSha256: input.environmentSha256,
    committedWorkspaceRevision: input.committedWorkspaceRevision,
    toolPolicySha256: input.toolPolicySha256,
  };
}

function appendSandboxReset(sessionManager: SessionManager, previous: PiRuntimeWorldState): void {
  sessionManager.appendCustomMessageEntry(
    PI_SANDBOX_RESET_CUSTOM_TYPE,
    PI_SANDBOX_RESET_MESSAGE,
    false,
  );
  sessionManager.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, {
    ...previous,
    sandbox: { ...previous.sandbox, status: "unavailable" },
  } satisfies PiRuntimeWorldState);
}

export function preparePiSandboxContinuity(
  sessionManager: SessionManager,
  input: PiSandboxContinuity,
): void {
  const previous = latestRuntimeWorldState(sessionManager);
  if (previous?.sandbox.status !== "active") return;
  if (
    input.continuity === "warm_reuse" &&
    previous.sandbox.continuityId === input.activationId &&
    previous.environmentSha256 === input.environmentSha256 &&
    previous.toolPolicySha256 === input.toolPolicySha256
  ) {
    return;
  }
  appendSandboxReset(sessionManager, previous);
}

export function recordPiSandboxActive(
  sessionManager: SessionManager,
  input: Omit<PiSandboxContinuity, "continuity">,
): void {
  const next = worldState(input, "active");
  const previous = latestRuntimeWorldState(sessionManager);
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return;
  sessionManager.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, next);
}

export function recordPiSandboxUnavailable(
  sessionManager: SessionManager,
  input: Omit<PiSandboxContinuity, "continuity">,
): void {
  const previous = latestRuntimeWorldState(sessionManager);
  if (previous?.sandbox.status === "unavailable") return;
  appendSandboxReset(sessionManager, previous ?? worldState(input, "active"));
}
