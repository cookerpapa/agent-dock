import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { createHash } from "node:crypto";

export const CLOUD_STEP_CONTEXT_SCHEMA_VERSION = 1 as const;
export const REMOTE_TOOL_REGISTRY_VERSION = "pi-remote-tools.v1" as const;
export const TOOL_NETWORK_POLICY_VERSION = "cube-proxy-public-egress.v1" as const;

export type CloudStepContext = Readonly<{
  schemaVersion: typeof CLOUD_STEP_CONTEXT_SCHEMA_VERSION;
  identity: Readonly<{
    tenantId: string;
    projectId: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    attemptId: string;
    commandId: string;
    leaseId: string;
    fencingToken: number;
  }>;
  model: Readonly<{
    profileId: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    credentialBindingId: string;
    credentialBindingVersion: number;
  }>;
  environment: Readonly<{
    environmentVersionId: string;
    versionNumber: number;
    profileKey: string;
    profileVersion: string;
    imageRevision: string;
    specSha256: string;
    recipeSha256: string;
  }>;
  workspace: Readonly<{ baseRevision: string | null }>;
  tools: Readonly<{
    registryVersion: typeof REMOTE_TOOL_REGISTRY_VERSION;
    names: readonly ["read", "write", "edit", "bash"];
    networkPolicyVersion: typeof TOOL_NETWORK_POLICY_VERSION;
  }>;
  budgets: ExecuteTurnCommandMessage["payload"]["budgets"] | null;
}>;

export type FrozenCloudStep = Readonly<{
  context: CloudStepContext;
  sha256: string;
  toolPolicySha256: string;
  environmentSha256: string;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function freezeStep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeStep(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Captures the exact accepted view used by both Pi and the remote Tool plane.
 * It deliberately contains no API keys or signed capabilities.
 */
export function createCloudStepContext(
  command: ExecuteTurnCommandMessage,
  workspaceBaseRevision: string | undefined,
): FrozenCloudStep {
  const { payload } = command;
  const context = freezeStep<CloudStepContext>({
    schemaVersion: CLOUD_STEP_CONTEXT_SCHEMA_VERSION,
    identity: {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      runId: payload.runId,
      turnId: payload.turnId,
      attemptId: payload.attemptId,
      commandId: payload.commandId,
      leaseId: payload.leaseId,
      fencingToken: payload.fencingToken,
    },
    model: { ...payload.model },
    environment: {
      environmentVersionId: payload.environment.environmentVersionId,
      versionNumber: payload.environment.versionNumber,
      profileKey: payload.environment.profileKey,
      profileVersion: payload.environment.profileVersion,
      imageRevision: payload.environment.imageRevision,
      specSha256: payload.environment.specSha256,
      recipeSha256: payload.environment.recipeSha256,
    },
    workspace: { baseRevision: workspaceBaseRevision ?? null },
    tools: {
      registryVersion: REMOTE_TOOL_REGISTRY_VERSION,
      names: ["read", "write", "edit", "bash"],
      networkPolicyVersion: TOOL_NETWORK_POLICY_VERSION,
    },
    budgets: payload.budgets === undefined ? null : { ...payload.budgets },
  });
  return Object.freeze({
    context,
    sha256: createHash("sha256").update(canonicalJson(context), "utf8").digest("hex"),
    toolPolicySha256: createHash("sha256")
      .update(canonicalJson(context.tools), "utf8")
      .digest("hex"),
    environmentSha256: createHash("sha256")
      .update(canonicalJson(context.environment), "utf8")
      .digest("hex"),
  });
}
