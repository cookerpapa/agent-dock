import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  createCloudAttemptContext,
  createCloudStepContext,
  createCloudTurnContext,
} from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "10000000-0000-4000-8000-000000000001",
  sentAt: "2026-08-04T00:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "10000000-0000-4000-8000-000000000002",
    idempotencyKey: "frozen-step",
    tenantId: "tenant-step",
    projectId: "project-step",
    workspaceId: "workspace-step",
    sessionId: "session-step",
    runId: "10000000-0000-4000-8000-000000000003",
    turnId: "turn-step",
    attemptId: "10000000-0000-4000-8000-000000000004",
    agentId: "root",
    leaseId: "10000000-0000-4000-8000-000000000005",
    fencingToken: 9,
    nextEventSeq: 1,
    input: { kind: "prompt", text: "test" },
    sandboxRetention: "ephemeral",
    model: {
      profileId: "profile-step",
      provider: "agent-dock-fake",
      modelId: "agent-dock-fake",
      thinkingLevel: "off",
      credentialBindingId: "binding-step",
      credentialBindingVersion: 3,
    },
    environment: {
      environmentVersionId: "10000000-0000-4000-8000-000000000006",
      versionNumber: 2,
      profileKey: "agent-dock-fullstack",
      profileVersion: "1",
      imageRevision: "development",
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
  },
};

const runtimeIdentity = {
  supervisorId: "supervisor-step",
  bootId: "10000000-0000-4000-8000-000000000007",
  sandboxId: "sandbox-step",
};

describe("Cloud Turn, Attempt and sampling Step contexts", () => {
  it("keeps the logical Turn stable while rotating Attempt ownership", () => {
    const first = createCloudTurnContext(command, "c".repeat(64));
    const repeated = createCloudTurnContext(command, "c".repeat(64));
    const changedWorkspace = createCloudTurnContext(command, "d".repeat(64));
    const changedRetention = createCloudTurnContext(
      {
        ...command,
        payload: { ...command.payload, sandboxRetention: "persistent" },
      },
      "c".repeat(64),
    );
    const retryCommand: ExecuteTurnCommandMessage = {
      ...command,
      messageId: "20000000-0000-4000-8000-000000000001",
      payload: {
        ...command.payload,
        commandId: "20000000-0000-4000-8000-000000000002",
        idempotencyKey: "frozen-step-retry",
        attemptId: "20000000-0000-4000-8000-000000000004",
        leaseId: "20000000-0000-4000-8000-000000000005",
        fencingToken: 10,
      },
    };
    const retriedTurn = createCloudTurnContext(retryCommand, "c".repeat(64));
    const firstAttempt = createCloudAttemptContext({
      command,
      runtimeIdentity,
      turnContextSha256: first.sha256,
    });
    const retryAttempt = createCloudAttemptContext({
      command: retryCommand,
      runtimeIdentity: {
        supervisorId: "supervisor-step-2",
        bootId: "20000000-0000-4000-8000-000000000007",
        sandboxId: "sandbox-step-2",
      },
      turnContextSha256: retriedTurn.sha256,
    });

    expect(first.sha256).toBe(repeated.sha256);
    expect(first.sha256).toBe(retriedTurn.sha256);
    expect(first.sha256).not.toBe(changedWorkspace.sha256);
    expect(first.sha256).not.toBe(changedRetention.sha256);
    expect(firstAttempt.sha256).not.toBe(retryAttempt.sha256);
    expect(firstAttempt.context.turnContextSha256).toBe(first.sha256);
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(Object.isFrozen(first.context.model)).toBe(true);
    expect(first.context.tools.names).toEqual(["read", "write", "edit", "bash"]);
    expect(JSON.stringify(first.context)).not.toContain("apiKey");
    expect(JSON.stringify(first.context)).not.toContain("capability");
  });

  it("captures a distinct immutable Step for every provider request", () => {
    const turn = createCloudTurnContext(command, "c".repeat(64));
    const attempt = createCloudAttemptContext({
      command,
      runtimeIdentity,
      turnContextSha256: turn.sha256,
    });
    const worldState = {
      sandbox: { status: "active" as const, continuitySha256: "e".repeat(64) },
      environmentSha256: turn.environmentSha256,
      committedWorkspaceRevision: "c".repeat(64),
      toolPolicySha256: turn.toolPolicySha256,
    };
    const first = createCloudStepContext({
      sequence: 1,
      turnContextSha256: turn.sha256,
      attemptContextSha256: attempt.sha256,
      activeTools: ["read", "write", "edit", "bash"],
      worldState,
    });
    const second = createCloudStepContext({
      sequence: 2,
      turnContextSha256: turn.sha256,
      attemptContextSha256: attempt.sha256,
      activeTools: ["read", "write", "edit", "bash"],
      worldState,
    });

    expect(first.sha256).not.toBe(second.sha256);
    expect(first.context.turnContextSha256).toBe(turn.sha256);
    expect(first.context.attemptContextSha256).toBe(attempt.sha256);
    expect(first.context.activeTools).toEqual(["bash", "edit", "read", "write"]);
    expect(Object.isFrozen(first.context.worldState)).toBe(true);
  });
});
