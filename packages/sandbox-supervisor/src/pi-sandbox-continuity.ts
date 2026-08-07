import { createHash } from "node:crypto";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CloudStepWorldState } from "./cloud-step-context.ts";

export const PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE = "agent-dock.runtime_world_state";
export const PI_SANDBOX_RESET_CUSTOM_TYPE = "agent-dock.sandbox_reset";
export const PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE = "agent-dock.environment_changed";
export const PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE = "agent-dock.tool_policy_changed";

export const PI_SANDBOX_RESET_MESSAGE = [
  "<sandbox_reset>",
  "The previous sandbox is no longer available. The committed workspace is preserved, but running processes and in-memory environment state were not carried forward.",
  "</sandbox_reset>",
].join("\n");

export const PI_ENVIRONMENT_CHANGED_MESSAGE = [
  "<environment_changed>",
  "The execution environment available to tools differs from the previous model step.",
  "</environment_changed>",
].join("\n");

export const PI_TOOL_POLICY_CHANGED_MESSAGE = [
  "<tool_policy_changed>",
  "The available tools or their network policy differ from the previous model step.",
  "</tool_policy_changed>",
].join("\n");

export type PiRuntimeWorldState = Readonly<{
  schemaVersion: 2;
  sandbox: Readonly<{
    status: "inactive" | "active" | "unavailable";
    continuityId: string | null;
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

export type PiWorldStateModelMessage = Readonly<{
  customType:
    | typeof PI_SANDBOX_RESET_CUSTOM_TYPE
    | typeof PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE
    | typeof PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE;
  content: string;
  display: false;
  details: Readonly<{ schemaVersion: 1; changeSha256: string }>;
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
    candidate.schemaVersion !== 2 ||
    (sandboxCandidate.status !== "inactive" &&
      sandboxCandidate.status !== "active" &&
      sandboxCandidate.status !== "unavailable") ||
    (sandboxCandidate.continuityId !== null && typeof sandboxCandidate.continuityId !== "string") ||
    !sha256(candidate.environmentSha256) ||
    (candidate.committedWorkspaceRevision !== null &&
      !sha256(candidate.committedWorkspaceRevision)) ||
    !sha256(candidate.toolPolicySha256)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
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
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = runtimeWorldState(entries[index]!);
    if (state !== undefined) return state;
  }
  return undefined;
}

function sameState(left: PiRuntimeWorldState, right: PiRuntimeWorldState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function modelMessage(
  customType: PiWorldStateModelMessage["customType"],
  previous: PiRuntimeWorldState,
  current: PiRuntimeWorldState,
): PiWorldStateModelMessage {
  const details = {
    schemaVersion: 1,
    changeSha256: createHash("sha256")
      .update(JSON.stringify({ customType, previous, current }), "utf8")
      .digest("hex"),
  } as const;
  if (customType === PI_SANDBOX_RESET_CUSTOM_TYPE) {
    return { customType, content: PI_SANDBOX_RESET_MESSAGE, display: false, details };
  }
  if (customType === PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE) {
    return { customType, content: PI_ENVIRONMENT_CHANGED_MESSAGE, display: false, details };
  }
  return { customType, content: PI_TOOL_POLICY_CHANGED_MESSAGE, display: false, details };
}

/**
 * Owns the typed execution-world baseline for one Pi runtime. The tracker is
 * sampled by the public Pi `context` extension hook before every provider
 * request and is also updated at Tool terminal boundaries.
 */
export class PiStepWorldStateController {
  readonly #sessionManager: SessionManager;
  readonly #continuity: PiSandboxContinuity;
  readonly #messagesAppendedDuringRun: PiWorldStateModelMessage[] = [];
  #status: PiRuntimeWorldState["sandbox"]["status"];
  #previous: PiRuntimeWorldState | undefined;

  constructor(sessionManager: SessionManager, continuity: PiSandboxContinuity) {
    this.#sessionManager = sessionManager;
    this.#continuity = continuity;
    this.#status = continuity.continuity === "warm_reuse" ? "active" : "inactive";
    this.#previous = latestRuntimeWorldState(sessionManager);
  }

  capture(): Readonly<{
    worldState: CloudStepWorldState;
    modelMessages: readonly PiWorldStateModelMessage[];
  }> {
    const state = this.#reconcile();
    return {
      worldState: {
        sandbox: {
          status: state.sandbox.status,
          continuitySha256:
            state.sandbox.continuityId === null
              ? null
              : createHash("sha256").update(state.sandbox.continuityId, "utf8").digest("hex"),
        },
        environmentSha256: state.environmentSha256,
        committedWorkspaceRevision: state.committedWorkspaceRevision,
        toolPolicySha256: state.toolPolicySha256,
      },
      modelMessages: [...this.#messagesAppendedDuringRun],
    };
  }

  recordActive(): void {
    this.#status = "active";
    this.#reconcile();
  }

  recordUnavailable(): void {
    this.#status = "unavailable";
    this.#reconcile();
  }

  #current(): PiRuntimeWorldState {
    return {
      schemaVersion: 2,
      sandbox: {
        status: this.#status,
        continuityId: this.#status === "inactive" ? null : this.#continuity.activationId,
      },
      environmentSha256: this.#continuity.environmentSha256,
      committedWorkspaceRevision: this.#continuity.committedWorkspaceRevision,
      toolPolicySha256: this.#continuity.toolPolicySha256,
    };
  }

  #reconcile(): PiRuntimeWorldState {
    const current = this.#current();
    const previous = this.#previous;
    if (previous !== undefined && sameState(previous, current)) return current;

    const material: PiWorldStateModelMessage["customType"][] = [];
    if (
      previous?.sandbox.status === "active" &&
      (current.sandbox.status !== "active" ||
        previous.sandbox.continuityId !== current.sandbox.continuityId)
    ) {
      material.push(PI_SANDBOX_RESET_CUSTOM_TYPE);
    }
    if (previous !== undefined && previous.environmentSha256 !== current.environmentSha256) {
      material.push(PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE);
    }
    if (previous !== undefined && previous.toolPolicySha256 !== current.toolPolicySha256) {
      material.push(PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE);
    }

    for (const customType of material) {
      const message = modelMessage(customType, previous!, current);
      this.#sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      this.#messagesAppendedDuringRun.push(message);
    }
    this.#sessionManager.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, current);
    this.#previous = current;
    return current;
  }
}
