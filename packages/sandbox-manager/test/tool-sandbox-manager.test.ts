import type {
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
} from "@agent-dock/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxManagerError,
  ToolSandboxManager,
  loadSandboxManagerConfig,
  type SandboxCreateSpec,
  type SandboxHandle,
  type SandboxProvider,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const CAPABILITY = `adts_${"c".repeat(43)}`;
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-provider-test",
  supervisorId: "supervisor-provider-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-provider-test",
  sessionId: "session-provider-test",
  turnId: "turn-provider-test",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000003",
  fencingToken: 5,
};

const createRequest: ToolSandboxCreateRequest = {
  managerProtocolVersion: 1,
  type: "tool_sandbox.create",
  requestId: "10000000-0000-4000-8000-000000000011",
  assignment,
  workspaceSeed: { kind: "sample_java" },
};

function providerFixture() {
  let createSpec: SandboxCreateSpec | undefined;
  let stopped = false;
  const exec = vi.fn<SandboxProvider["exec"]>(async (_handle, request) => ({
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: "bash.exec",
    exitCode: 0,
    output: Buffer.from("ok\n").toString("base64"),
  }));
  const provider: SandboxProvider = {
    providerId: "docker",
    async checkHealth() {},
    async create(spec) {
      createSpec = spec;
      return {
        providerApiVersion: 1,
        providerId: "docker",
        activationId: spec.activationId,
        runtimeId: "a".repeat(64),
        runtimeName: `agent-dock-tool-${spec.activationId}`.slice(0, 63),
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
      };
    },
    exec,
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async snapshot() {
      throw new Error("unused");
    },
    async stop() {
      stopped = true;
    },
    async destroy() {},
    async inspect(handle) {
      return {
        providerApiVersion: 1,
        providerId: "docker",
        state: "running",
        handle,
        effectiveIsolation: {
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: true,
          networkMode: "none",
          mountCount: 0,
          hasDockerSocket: false,
          pidLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          droppedCapabilities: ["ALL"],
          securityOptions: ["no-new-privileges"],
        },
      };
    },
    async destroyActivation() {},
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async importGitHub() {
      return Buffer.alloc(0);
    },
    async close() {},
  };
  return {
    provider,
    exec,
    get createSpec() {
      return createSpec;
    },
    get stopped() {
      return stopped;
    },
  };
}

function operation(operationId: string): ToolSandboxOperationRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId: ACTIVATION_ID,
    operationId,
    operation: "bash.exec",
    command: "pwd",
    cwd: "/workspace",
    timeoutMs: 1_000,
  };
}

describe("provider-backed Tool Sandbox Manager", () => {
  it("keeps capabilities above the provider and binds an immutable identity handle", async () => {
    const fixture = providerFixture();
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });

    const created = await manager.create(createRequest);
    expect(created).toMatchObject({ activationId: ACTIVATION_ID, capability: CAPABILITY });
    expect(fixture.createSpec).toMatchObject({
      activationId: ACTIVATION_ID,
      assignment: {
        tenantId: assignment.tenantId,
        sessionId: assignment.sessionId,
        turnId: assignment.turnId,
        attemptId: assignment.attemptId,
      },
      policy: { network: { mode: "deny_all" } },
    });
    expect(fixture.createSpec).not.toHaveProperty("capability");

    await expect(
      manager.execute(`adts_${"x".repeat(43)}`, operation("10000000-0000-4000-8000-000000000012")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
    const request = operation("10000000-0000-4000-8000-000000000013");
    await expect(manager.execute(CAPABILITY, request)).resolves.toMatchObject({ exitCode: 0 });
    await expect(manager.execute(CAPABILITY, request)).rejects.toMatchObject({
      code: "tool_operation_replay",
    });
    expect(fixture.exec).toHaveBeenCalledTimes(1);

    await expect(manager.inspect(ACTIVATION_ID, assignment)).resolves.toMatchObject({
      state: "running",
      handle: { assignment: { tenantId: assignment.tenantId, attemptId: assignment.attemptId } },
    });
    await manager.stop(ACTIVATION_ID, assignment);
    expect(fixture.stopped).toBe(true);
    expect(manager.activeCount).toBe(0);
    await expect(
      manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000014")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
  });

  it("revokes the capability before a provider stop failure escapes", async () => {
    const fixture = providerFixture();
    fixture.provider.stop = async () => {
      throw new SandboxManagerError("cleanup_failed", "cleanup failed", true);
    };
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    await manager.create(createRequest);
    await expect(manager.stop(ACTIVATION_ID, assignment)).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(manager.activeCount).toBe(0);
    await expect(
      manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000015")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
  });

  it("fails startup configuration closed for an unimplemented provider", async () => {
    await expect(
      loadSandboxManagerConfig({ AGENT_DOCK_SANDBOX_PROVIDER: "vercel" }),
    ).rejects.toThrow("not supported");
  });
});
