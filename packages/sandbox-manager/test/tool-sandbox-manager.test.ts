import type {
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxManagerError,
  ToolSandboxManager,
  loadSandboxManagerConfig,
  type SandboxCreateSpec,
  type SandboxProvider,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const CAPABILITY = `adts_${"c".repeat(43)}`;
const SECOND_ACTIVATION_ID = "20000000-0000-4000-8000-000000000020";
const SECOND_CAPABILITY = `adts_${"d".repeat(43)}`;
const STEP_CONTEXT_SHA256 = "a".repeat(64);
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-provider-test",
  projectId: "project-provider-test",
  workspaceId: "workspace-provider-test",
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
const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000004",
  versionNumber: 1,
  profileKey: "agent-dock-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};
const environmentValidation = {
  profileKey: "agent-dock-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  isolationBoundary: "microvm" as const,
  runtime: "cubesandbox-kvm" as const,
  networkMode: "public_web_proxy_private_denied" as const,
  runAsUser: "1000:1000" as const,
  readOnlyRootFilesystem: false as const,
  tools: [
    { name: "node" as const, version: "v24.18.0" },
    { name: "java" as const, version: 'openjdk version "17.0.19"' },
    { name: "python" as const, version: "Python 3.11.2" },
    { name: "git" as const, version: "git version 2.39.5" },
  ],
  recipeCommands: [],
};

const createRequest: ToolSandboxCreateRequest = {
  managerProtocolVersion: 1,
  type: "tool_sandbox.create",
  requestId: "10000000-0000-4000-8000-000000000011",
  assignment,
  executionContextSha256: STEP_CONTEXT_SHA256,
  environment,
  workspaceSeed: { kind: "sample_java" },
};

function providerFixture() {
  let createSpec: SandboxCreateSpec | undefined;
  let createCount = 0;
  let stopped = false;
  const exec = vi.fn<SandboxProvider["exec"]>(async (_handle, request) => ({
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: "bash.exec",
    exitCode: 0,
    outputChunks: [{ seq: 1, stream: "stdout", data: Buffer.from("ok\n").toString("base64") }],
    outputSha256: createHash("sha256").update("ok\n").digest("hex"),
  }));
  const rebind = vi.fn<SandboxProvider["rebind"]>(async (handle, nextAssignment) => ({
    ...handle,
    assignment: nextAssignment,
  }));
  const provider: SandboxProvider = {
    providerId: "cubesandbox",
    async checkHealth() {},
    async create(spec) {
      createCount += 1;
      createSpec = spec;
      return {
        providerApiVersion: 1,
        providerId: "cubesandbox",
        activationId: spec.activationId,
        runtimeId: "66666666-6666-4666-8666-666666666666",
        runtimeName: `agent-dock-tool-${spec.activationId}`.slice(0, 63),
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      };
    },
    rebind,
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
        providerId: "cubesandbox",
        state: "running",
        handle,
        effectiveIsolation: {
          isolationBoundary: "microvm",
          runtime: "cubesandbox-kvm",
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: false,
          networkMode: "public_web_proxy_private_denied",
          mountCount: 0,
          hasDockerSocket: false,
          pidLimit: 128,
          processLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          droppedCapabilities: ["ALL"],
          securityOptions: ["no-new-privileges"],
          sandboxKernelRelease: "6.1.0-cube",
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
    rebind,
    get createSpec() {
      return createSpec;
    },
    get createCount() {
      return createCount;
    },
    get stopped() {
      return stopped;
    },
  };
}

function operation(
  operationId: string,
): Extract<ToolSandboxOperationRequest, { operation: "bash.exec" }> {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId: ACTIVATION_ID,
    operationId,
    executionContextSha256: STEP_CONTEXT_SHA256,
    stepContextSequence: 1,
    stepContextSha256: STEP_CONTEXT_SHA256,
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
    expect(created).toMatchObject({
      activationId: ACTIVATION_ID,
      capability: CAPABILITY,
      continuity: "cold_restore",
    });
    expect(fixture.createSpec).toBeUndefined();
    await expect(
      manager.capture(ACTIVATION_ID, assignment, "10000000-0000-4000-8000-000000000017"),
    ).resolves.toMatchObject({ type: "tool_sandbox.unused" });

    await expect(
      manager.execute(CAPABILITY, {
        ...operation("10000000-0000-4000-8000-000000000011"),
        executionContextSha256: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "execution_context_mismatch" });
    expect(fixture.createSpec).toBeUndefined();

    await expect(
      manager.execute(`adts_${"x".repeat(43)}`, operation("10000000-0000-4000-8000-000000000012")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
    const request = operation("10000000-0000-4000-8000-000000000013");
    await expect(manager.execute(CAPABILITY, request)).resolves.toMatchObject({ exitCode: 0 });
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
    await expect(manager.execute(CAPABILITY, request)).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      manager.execute(CAPABILITY, { ...request, command: "whoami" }),
    ).rejects.toMatchObject({ code: "tool_operation_identity_conflict" });
    expect(fixture.exec).toHaveBeenCalledTimes(1);

    const secondStep = {
      ...operation("10000000-0000-4000-8000-000000000018"),
      stepContextSequence: 2,
      stepContextSha256: "b".repeat(64),
    };
    await expect(manager.execute(CAPABILITY, secondStep)).resolves.toMatchObject({ exitCode: 0 });
    await expect(manager.execute(CAPABILITY, request)).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000019")),
    ).rejects.toMatchObject({ code: "step_context_mismatch" });
    await expect(
      manager.execute(CAPABILITY, {
        ...secondStep,
        operationId: "10000000-0000-4000-8000-000000000020",
        stepContextSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "step_context_mismatch" });
    expect(fixture.exec).toHaveBeenCalledTimes(2);

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

  it("queues materialization behind the global active Sandbox admission limit", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      commandId: "command-provider-test-second",
      sessionId: "session-provider-test-second",
      turnId: "turn-provider-test-second",
      attemptId: "20000000-0000-4000-8000-000000000003",
      leaseId: "20000000-0000-4000-8000-000000000003",
      fencingToken: 6,
    };
    const first = await manager.create(createRequest);
    const second = await manager.create({
      ...createRequest,
      requestId: "20000000-0000-4000-8000-000000000011",
      assignment: secondAssignment,
    });
    await manager.execute(first.capability, operation("20000000-0000-4000-8000-000000000012"));
    const waiting = manager.execute(second.capability, {
      ...operation("20000000-0000-4000-8000-000000000013"),
      activationId: second.activationId,
    });
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);

    await manager.stop(first.activationId, assignment);
    await expect(waiting).resolves.toMatchObject({ exitCode: 0 });
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(2);
    await manager.stop(second.activationId, secondAssignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("removes an aborted Tool Sandbox admission waiter without consuming capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      commandId: "command-provider-test-aborted",
      sessionId: "session-provider-test-aborted",
      turnId: "turn-provider-test-aborted",
      attemptId: "30000000-0000-4000-8000-000000000003",
      leaseId: "30000000-0000-4000-8000-000000000003",
      fencingToken: 7,
    };
    const first = await manager.create(createRequest);
    const second = await manager.create({
      ...createRequest,
      requestId: "30000000-0000-4000-8000-000000000011",
      assignment: secondAssignment,
    });
    await manager.execute(first.capability, operation("30000000-0000-4000-8000-000000000012"));
    const controller = new AbortController();
    const waiting = manager.execute(
      second.capability,
      {
        ...operation("30000000-0000-4000-8000-000000000013"),
        activationId: second.activationId,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "tool_sandbox_admission_cancelled" });
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);
    await manager.stop(second.activationId, secondAssignment);
    await manager.stop(first.activationId, assignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("reuses one exact-session runtime across fenced attempts without reprovisioning", async () => {
    const fixture = providerFixture();
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("10000000-0000-4000-8000-000000000018"));
    await manager.release({
      managerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000019",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "a".repeat(64),
    });

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      supervisorId: "supervisor-provider-test-next",
      bootId: "20000000-0000-4000-8000-000000000020",
      sandboxId: "20000000-0000-4000-8000-000000000021",
      commandId: "command-provider-test-next",
      turnId: "turn-provider-test-next",
      attemptId: "10000000-0000-4000-8000-000000000020",
      leaseId: "10000000-0000-4000-8000-000000000020",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "10000000-0000-4000-8000-000000000021",
      assignment: nextAssignment,
      workspaceRevision: "a".repeat(64),
    });
    expect(second.activationId).toBe(first.activationId);
    expect(second.continuity).toBe("warm_reuse");
    await manager.execute(second.capability, {
      ...operation("10000000-0000-4000-8000-000000000022"),
      activationId: second.activationId,
    });
    expect(fixture.rebind).toHaveBeenCalledTimes(1);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("evicts the least-recently-used warm runtime when new demand reaches admission capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
      maximumWarmActivations: 4,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("50000000-0000-4000-8000-000000000012"));
    await manager.release({
      managerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "50000000-0000-4000-8000-000000000013",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "c".repeat(64),
    });
    expect(manager.warmCount).toBe(1);
    expect(manager.admittedCount).toBe(1);

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      commandId: "command-provider-test-capacity-eviction",
      workspaceId: "workspace-provider-test-capacity-eviction",
      sessionId: "session-provider-test-capacity-eviction",
      turnId: "turn-provider-test-capacity-eviction",
      attemptId: "50000000-0000-4000-8000-000000000014",
      leaseId: "50000000-0000-4000-8000-000000000014",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "50000000-0000-4000-8000-000000000015",
      assignment: nextAssignment,
    });
    await expect(
      manager.execute(second.capability, {
        ...operation("50000000-0000-4000-8000-000000000016"),
        activationId: second.activationId,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(fixture.stopped).toBe(true);
    expect(fixture.createCount).toBe(2);
    expect(manager.warmCount).toBe(0);
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("releases admission when a validated physical runtime is terminated after its assignment advanced", async () => {
    const fixture = providerFixture();
    const manager = new ToolSandboxManager({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
      maximumActiveSandboxes: 1,
    });
    const created = await manager.create(createRequest);
    await manager.execute(created.capability, operation("40000000-0000-4000-8000-000000000012"));
    await manager.release({
      managerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "40000000-0000-4000-8000-000000000013",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "b".repeat(64),
    });
    expect(manager.admittedCount).toBe(1);
    expect(manager.warmCount).toBe(1);

    const advancedInventoryAssignment: SupervisorRuntimeAssignment = {
      containerId: "66666666-6666-4666-8666-666666666666",
      containerName: `agent-dock-tool-${ACTIVATION_ID}`.slice(0, 63),
      supervisorId: assignment.supervisorId,
      bootId: assignment.bootId,
      sandboxId: assignment.sandboxId,
      commandId: "command-provider-test-advanced",
      sessionId: assignment.sessionId,
      turnId: "turn-provider-test-advanced",
      leaseId: "40000000-0000-4000-8000-000000000014",
      fencingToken: assignment.fencingToken + 1,
    };
    await manager.terminateAndConfirmAbsent(advancedInventoryAssignment);

    expect(manager.admittedCount).toBe(0);
    expect(manager.warmCount).toBe(0);
    expect(manager.activeCount).toBe(0);
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
    await manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000016"));
    await expect(manager.stop(ACTIVATION_ID, assignment)).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(manager.activeCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await expect(
      manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000015")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
    fixture.provider.destroyActivation = async () => {};
    await manager.stop(ACTIVATION_ID, assignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("loads only the CubeSandbox deployment configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-dock-manager-config-"));
    const tokenPath = join(directory, "manager-token");
    try {
      await writeFile(tokenPath, `${"t".repeat(48)}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
      const cubeKeyPath = join(directory, "cube-api-key");
      await writeFile(cubeKeyPath, `${"k".repeat(48)}\n`, { mode: 0o600 });
      await chmod(cubeKeyPath, 0o600);
      const workspaceDataMoverTokenPath = join(directory, "workspace-data-mover-token");
      await writeFile(workspaceDataMoverTokenPath, `${"m".repeat(48)}\n`, { mode: 0o600 });
      await chmod(workspaceDataMoverTokenPath, 0o600);
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_CUBESANDBOX_API_URL: "https://cube-api.internal",
          AGENT_DOCK_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID: "agent-dock-tool-v1",
          AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME: "https",
          AGENT_DOCK_WORKSPACE_DATA_MOVER_URL: "http://workspace-data-mover:4500",
          AGENT_DOCK_WORKSPACE_DATA_MOVER_TOKEN_FILE: workspaceDataMoverTokenPath,
        }),
      ).resolves.toMatchObject({
        maximumActiveSandboxes: 2,
        maximumWarmActivations: 4,
        cubeSandbox: {
          apiUrl: "https://cube-api.internal",
          apiKey: "k".repeat(48),
          templateId: "agent-dock-tool-v1",
          proxyNodeIp: "10.20.30.40",
          proxyPort: 443,
          proxyScheme: "https",
          sandboxDomain: "cube.app",
          workspaceDataMoverUrl: "http://workspace-data-mover:4500",
          workspaceDataMoverToken: "m".repeat(48),
        },
      });
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_REPOSITORY_IMPORT_NETWORK: "repository-egress",
        }),
      ).rejects.toThrow("was removed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
