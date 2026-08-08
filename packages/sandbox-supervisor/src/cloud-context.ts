import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import type { SandboxRuntimeIdentity } from "./sandbox-assignment-inventory.ts";

export const CLOUD_TURN_CONTEXT_SCHEMA_VERSION = 1 as const;
export const CLOUD_ATTEMPT_CONTEXT_SCHEMA_VERSION = 1 as const;
export const CLOUD_STEP_CONTEXT_SCHEMA_VERSION = 1 as const;
export const REMOTE_TOOL_REGISTRY_VERSION = "pi-remote-tools.v1" as const;
export const TOOL_NETWORK_POLICY_VERSION = "cube-proxy-public-egress.v1" as const;

/** The logical contract for one accepted user Turn, stable across retries. */
export type CloudTurnContext = Readonly<{
  schemaVersion: typeof CLOUD_TURN_CONTEXT_SCHEMA_VERSION;
  identity: Readonly<{
    tenantId: string;
    projectId: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    agentId: string;
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

export type FrozenCloudTurn = Readonly<{
  context: CloudTurnContext;
  sha256: string;
  toolPolicySha256: string;
  environmentSha256: string;
}>;

/** Physical ownership of one Turn execution, rotated on Worker takeover. */
export type CloudAttemptContext = Readonly<{
  schemaVersion: typeof CLOUD_ATTEMPT_CONTEXT_SCHEMA_VERSION;
  turnContextSha256: string;
  identity: Readonly<{
    commandId: string;
    idempotencyKey: string;
    attemptId: string;
    leaseId: string;
    fencingToken: number;
    supervisorId: string;
    bootId: string;
    sandboxId: string;
  }>;
}>;

export type FrozenCloudAttempt = Readonly<{
  context: CloudAttemptContext;
  sha256: string;
}>;

export type CloudStepWorldState = Readonly<{
  sandbox: Readonly<{
    status: "inactive" | "active" | "unavailable";
    continuitySha256: string | null;
  }>;
  environmentSha256: string;
  committedWorkspaceRevision: string | null;
  toolPolicySha256: string;
}>;

export type CloudStepContext = Readonly<{
  schemaVersion: typeof CLOUD_STEP_CONTEXT_SCHEMA_VERSION;
  sequence: number;
  turnContextSha256: string;
  attemptContextSha256: string;
  activeTools: readonly string[];
  worldState: CloudStepWorldState;
}>;

export type FrozenCloudStep = Readonly<{
  context: CloudStepContext;
  sha256: string;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function freezeContext<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeContext(entry);
    Object.freeze(value);
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validSha256(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} digest is invalid`);
  return value;
}

/** Captures the immutable, credential-free logical Turn contract. */
export function createCloudTurnContext(
  command: ExecuteTurnCommandMessage,
  workspaceBaseRevision: string | undefined,
): FrozenCloudTurn {
  const { payload } = command;
  const context = freezeContext<CloudTurnContext>({
    schemaVersion: CLOUD_TURN_CONTEXT_SCHEMA_VERSION,
    identity: {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      runId: payload.runId,
      turnId: payload.turnId,
      agentId: payload.agentId,
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
    sha256: sha256(context),
    toolPolicySha256: sha256(context.tools),
    environmentSha256: sha256(context.environment),
  });
}

/** Captures the current Worker/lease/fence ownership beneath one Turn. */
export function createCloudAttemptContext(input: {
  command: ExecuteTurnCommandMessage;
  runtimeIdentity: SandboxRuntimeIdentity;
  turnContextSha256: string;
}): FrozenCloudAttempt {
  const { payload } = input.command;
  const context = freezeContext<CloudAttemptContext>({
    schemaVersion: CLOUD_ATTEMPT_CONTEXT_SCHEMA_VERSION,
    turnContextSha256: validSha256(input.turnContextSha256, "Cloud Turn context"),
    identity: {
      commandId: payload.commandId,
      idempotencyKey: payload.idempotencyKey,
      attemptId: payload.attemptId,
      leaseId: payload.leaseId,
      fencingToken: payload.fencingToken,
      supervisorId: input.runtimeIdentity.supervisorId,
      bootId: input.runtimeIdentity.bootId,
      sandboxId: input.runtimeIdentity.sandboxId,
    },
  });
  return Object.freeze({ context, sha256: sha256(context) });
}

/** Capture one provider-request boundary after Pi has selected its active Tools. */
export function createCloudStepContext(input: {
  sequence: number;
  turnContextSha256: string;
  attemptContextSha256: string;
  activeTools: readonly string[];
  worldState: CloudStepWorldState;
}): FrozenCloudStep {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("Cloud Step sequence must be a positive safe integer");
  }
  const activeTools = [...input.activeTools].sort();
  if (
    activeTools.length !== 4 ||
    activeTools.some((name, index) => name !== ["bash", "edit", "read", "write"][index])
  ) {
    throw new TypeError("Cloud Step remote Tool registry is invalid");
  }
  const context = freezeContext<CloudStepContext>({
    schemaVersion: CLOUD_STEP_CONTEXT_SCHEMA_VERSION,
    sequence: input.sequence,
    turnContextSha256: validSha256(input.turnContextSha256, "Cloud Turn context"),
    attemptContextSha256: validSha256(input.attemptContextSha256, "Cloud Attempt context"),
    activeTools,
    worldState: {
      sandbox: { ...input.worldState.sandbox },
      environmentSha256: input.worldState.environmentSha256,
      committedWorkspaceRevision: input.worldState.committedWorkspaceRevision,
      toolPolicySha256: input.worldState.toolPolicySha256,
    },
  });
  return Object.freeze({ context, sha256: sha256(context) });
}
