import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { createCloudExecutionContext, createCloudStepContext } from "../src/index.ts";

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

describe("Cloud execution and sampling Step contexts", () => {
  it("freezes and hashes the exact accepted execution view without credentials", () => {
    const first = createCloudExecutionContext(command, "c".repeat(64));
    const repeated = createCloudExecutionContext(command, "c".repeat(64));
    const changedWorkspace = createCloudExecutionContext(command, "d".repeat(64));

    expect(first.sha256).toBe(repeated.sha256);
    expect(first.sha256).not.toBe(changedWorkspace.sha256);
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(Object.isFrozen(first.context.model)).toBe(true);
    expect(first.context.tools.names).toEqual(["read", "write", "edit", "bash"]);
    expect(JSON.stringify(first.context)).not.toContain("apiKey");
    expect(JSON.stringify(first.context)).not.toContain("capability");
  });

  it("captures a distinct immutable Step for every provider request", () => {
    const execution = createCloudExecutionContext(command, "c".repeat(64));
    const worldState = {
      sandbox: { status: "active" as const, continuitySha256: "e".repeat(64) },
      environmentSha256: execution.environmentSha256,
      committedWorkspaceRevision: "c".repeat(64),
      toolPolicySha256: execution.toolPolicySha256,
    };
    const first = createCloudStepContext({
      sequence: 1,
      executionContextSha256: execution.sha256,
      activeTools: ["read", "write", "edit", "bash"],
      worldState,
    });
    const second = createCloudStepContext({
      sequence: 2,
      executionContextSha256: execution.sha256,
      activeTools: ["read", "write", "edit", "bash"],
      worldState,
    });

    expect(first.sha256).not.toBe(second.sha256);
    expect(first.context.executionContextSha256).toBe(execution.sha256);
    expect(first.context.activeTools).toEqual(["bash", "edit", "read", "write"]);
    expect(Object.isFrozen(first.context.worldState)).toBe(true);
  });
});
