import type {
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
} from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ToolBrokerError,
  InMemorySandboxActivationStateRepository,
  ToolBroker,
  loadToolBrokerConfig,
  type SandboxCreateSpec,
  type SandboxProvider,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const CAPABILITY = `pcts_${"c".repeat(43)}`;
const SECOND_ACTIVATION_ID = "20000000-0000-4000-8000-000000000020";
const SECOND_CAPABILITY = `pcts_${"d".repeat(43)}`;
const STEP_CONTEXT_SHA256 = "a".repeat(64);
const TURN_CONTEXT_SHA256 = "b".repeat(64);
const ATTEMPT_CONTEXT_SHA256 = "c".repeat(64);
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
  profileKey: "pi-cloud-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};
const environmentValidation = {
  profileKey: "pi-cloud-fullstack" as const,
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
  toolBrokerProtocolVersion: 1,
  type: "tool_sandbox.create",
  requestId: "10000000-0000-4000-8000-000000000011",
  assignment,
  turnContextSha256: TURN_CONTEXT_SHA256,
  attemptContextSha256: ATTEMPT_CONTEXT_SHA256,
  allowedTools: ["read", "write", "edit", "bash"],
  environment,
  workspaceSeed: { kind: "sample_java" },
};

function providerFixture() {
  let createSpec: SandboxCreateSpec | undefined;
  let createCount = 0;
  let stopped = false;
  let destroyed = false;
  const terminalInput = vi.fn(async () => undefined);
  const terminalResize = vi.fn(async () => undefined);
  const exec = vi.fn<SandboxProvider["exec"]>(async (_handle, request) => ({
    toolBrokerProtocolVersion: 1,
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
  const snapshot = vi.fn<SandboxProvider["snapshot"]>(async (handle, requestId) => {
    const bytes = Buffer.from("workspace", "utf8");
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.captured",
      requestId,
      activationId: handle.activationId,
      workspace: {
        encoding: "base64",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        data: bytes.toString("base64"),
      },
      environment: environmentValidation,
    };
  });
  const forkWorkspace = vi.fn<NonNullable<SandboxProvider["forkWorkspace"]>>(async (handle) => ({
    sourceHandle: handle,
    sourceRevision: "a".repeat(64),
    targetRevision: "b".repeat(64),
  }));
  const materializeFile = vi.fn<NonNullable<SandboxProvider["materializeFile"]>>(
    async (request) => ({
      toolBrokerProtocolVersion: 1,
      type: "workspace.file_materialized",
      requestId: request.requestId,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      path: request.path,
      content: Buffer.from("source\n").toString("base64"),
      sha256: createHash("sha256").update("source\n").digest("hex"),
      executable: false,
      sizeBytes: 7,
    }),
  );
  const pause = vi.fn<NonNullable<SandboxProvider["pause"]>>(async () => undefined);
  const resume = vi.fn<NonNullable<SandboxProvider["resume"]>>(async (handle) => handle);
  const previewHttp = vi.fn<NonNullable<SandboxProvider["previewHttp"]>>(async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from("<html><body>preview-ok</body></html>"),
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
        runtimeName: `pi-cloud-tool-${spec.activationId}`.slice(0, 63),
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      };
    },
    rebind,
    async retainForWarm(handle, brokerAssignment) {
      return { ...handle, assignment: brokerAssignment };
    },
    exec,
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async openTerminal() {
      return {
        pid: 77,
        output: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from("shell\r\n");
          },
        },
        sendInput: terminalInput,
        resize: terminalResize,
        async kill() {},
        disconnect() {},
      };
    },
    previewHttp,
    pause,
    resume,
    snapshot,
    forkWorkspace,
    materializeFile,
    async stop() {
      stopped = true;
    },
    async destroy() {
      destroyed = true;
    },
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
    snapshot,
    forkWorkspace,
    materializeFile,
    terminalInput,
    terminalResize,
    pause,
    resume,
    previewHttp,
    get createSpec() {
      return createSpec;
    },
    get createCount() {
      return createCount;
    },
    get stopped() {
      return stopped;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

function operation(
  operationId: string,
): Extract<ToolSandboxOperationRequest, { operation: "bash.exec" }> {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId: ACTIVATION_ID,
    operationId,
    turnContextSha256: TURN_CONTEXT_SHA256,
    attemptContextSha256: ATTEMPT_CONTEXT_SHA256,
    stepContextSequence: 1,
    stepContextSha256: STEP_CONTEXT_SHA256,
    toolName: "bash",
    operation: "bash.exec",
    command: "pwd",
    cwd: "/workspace",
    timeoutMs: 1_000,
  };
}

describe("provider-backed Tool Tool Broker", () => {
  it("keeps a user-owned development KVM across PTY disconnect and supports pause/resume", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    await expect(
      manager.provisionDevelopmentEnvironment({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.provision",
        requestId: "11111111-1111-4111-8111-111111111111",
        environmentId: ACTIVATION_ID,
        tenantId: assignment.tenantId,
        userId: "77777777-7777-4777-8777-777777777777",
        projectId: assignment.projectId,
        workspaceId: assignment.workspaceId,
        generation: 1,
        profileKey: "standard",
        environment,
        workspaceSeed: { kind: "sample_java" },
      }),
    ).resolves.toMatchObject({ state: "running" });
    await expect(manager.create(createRequest)).rejects.toMatchObject({
      code: "tool_sandbox_workspace_busy",
    });
    const terminal = await manager.openDevelopmentEnvironmentTerminal({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment_terminal.open",
      requestId: "22222222-2222-4222-8222-222222222222",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      rows: 24,
      cols: 100,
    });
    await terminal.close();
    expect(fixture.destroyed).toBe(false);
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "33333333-3333-4333-8333-333333333333",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "pause",
    });
    expect(fixture.pause).toHaveBeenCalledOnce();
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "44444444-4444-4444-8444-444444444444",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "resume",
    });
    expect(fixture.resume).toHaveBeenCalledOnce();
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "55555555-5555-4555-8555-555555555555",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "release",
    });
    expect(fixture.destroyed).toBe(true);
    await manager.close();
  });

  it("opens a separate human terminal authority and excludes Agent writers", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const terminal = await manager.openTerminal({
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 100 },
    });
    expect(terminal).toMatchObject({ terminalId: ACTIVATION_ID, pid: 77 });
    await terminal.sendInput(Buffer.from("pwd\r"));
    await terminal.resize({ rows: 40, cols: 120 });
    expect(fixture.terminalInput).toHaveBeenCalledWith(Buffer.from("pwd\r"));
    expect(fixture.terminalResize).toHaveBeenCalledWith({ rows: 40, cols: 120 });
    await expect(manager.create(createRequest)).rejects.toMatchObject({
      code: "tool_sandbox_workspace_busy",
    });
    await terminal.close();
    expect(fixture.destroyed).toBe(true);
    await expect(manager.create(createRequest)).resolves.toMatchObject({
      activationId: ACTIVATION_ID,
    });
    await manager.stop(ACTIVATION_ID, assignment);
    await manager.close();
  });

  it("hands an idle persistent Cube to the human terminal without replacing its process world", async () => {
    class PersistentTerminalRepository extends InMemorySandboxActivationStateRepository {
      override async reserveTerminal() {
        return {
          status: "reserved" as const,
          fencingToken: assignment.fencingToken + 2,
          retiredActivation: {
            activationId: ACTIVATION_ID,
            workspaceRevision: "1".repeat(64),
            retention: "persistent" as const,
            assignment: { ...assignment, fencingToken: assignment.fencingToken + 1 },
          },
        };
      }

      override async advanceWarmFence(
        _activationId: string,
        currentAssignment: ToolSandboxAssignment,
      ) {
        return currentAssignment.fencingToken + 1;
      }
    }
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      stateRepository: new PersistentTerminalRepository(),
      idGenerator: (() => {
        const ids = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
        return () => ids.shift()!;
      })(),
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(created.capability, operation("31000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "31000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "1".repeat(64),
    });

    const terminal = await manager.openTerminal({
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 100 },
    });
    expect(fixture.createCount).toBe(1);
    expect(manager.warmCount).toBe(0);
    expect(fixture.rebind).toHaveBeenCalledOnce();

    await terminal.close();
    expect(fixture.destroyed).toBe(false);
    expect(fixture.stopped).toBe(false);
    expect(fixture.snapshot).toHaveBeenCalledOnce();
    expect(manager.warmCount).toBe(1);

    const next = await manager.create({
      ...createRequest,
      requestId: "31000000-0000-4000-8000-000000000003",
      assignment: { ...assignment, fencingToken: 9 },
      workspaceRevision: "1".repeat(64),
    });
    expect(next.continuity).toBe("warm_reuse");
    expect(fixture.createCount).toBe(1);
    await manager.execute(next.capability, {
      ...operation("31000000-0000-4000-8000-000000000004"),
      activationId: next.activationId,
    });
    expect(fixture.rebind).toHaveBeenCalledTimes(2);
    await manager.stop(next.activationId, { ...assignment, fencingToken: 9 });
    await manager.close();
  });

  it("fails closed instead of silently destroying a requested persistent process world", async () => {
    const fixture = providerFixture();
    fixture.provider.retainForWarm = async () => {
      throw new ToolBrokerError(
        "cubesandbox_handoff_state_invalid",
        "Persistent process world was not ready for handoff",
        false,
      );
    };
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(created.capability, operation("32000000-0000-4000-8000-000000000001"));
    await expect(
      manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "32000000-0000-4000-8000-000000000002",
        activationId: created.activationId,
        assignment,
        disposition: "keep_persistent",
        workspaceRevision: "1".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "cubesandbox_handoff_state_invalid" });
    expect(fixture.stopped).toBe(true);
    await manager.close();
  });

  it("proxies a tenant-authorized port through a retained private-ingress Cube", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(created.capability, operation("32000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "32000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "1".repeat(64),
    });

    const response = await manager.preview({
      sandboxPreviewProtocolVersion: 1,
      type: "sandbox_preview.request",
      requestId: "32000000-0000-4000-8000-000000000003",
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      target: { kind: "conversation", sessionId: assignment.sessionId },
      port: 8000,
      method: "GET",
      path: "/",
      headers: { accept: "text/html" },
    });
    expect(response).toMatchObject({
      type: "sandbox_preview.response",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(
      Buffer.from(
        response.type === "sandbox_preview.response" ? response.body : "",
        "base64",
      ).toString(),
    ).toContain("preview-ok");
    expect(fixture.previewHttp).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: ACTIVATION_ID }),
      expect.objectContaining({ port: 8000, method: "GET", path: "/" }),
    );
    await manager.close();
  });

  it("rejects a new activation when the tenant holds its persistent Sandbox quota", async () => {
    class TenantCapacityRepository extends InMemorySandboxActivationStateRepository {
      override async reserve() {
        return { status: "tenant_capacity" as const };
      }
    }
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
      stateRepository: new TenantCapacityRepository(),
    });

    await expect(manager.create(createRequest)).rejects.toMatchObject({
      code: "tenant_sandbox_capacity_exhausted",
      retryable: true,
    });
    expect(fixture.createCount).toBe(0);
  });

  it("keeps capabilities above the provider and binds an immutable identity handle", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
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
        turnContextSha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "turn_context_mismatch" });
    await expect(
      manager.execute(CAPABILITY, {
        ...operation("10000000-0000-4000-8000-000000000021"),
        attemptContextSha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "attempt_context_mismatch" });
    expect(fixture.createSpec).toBeUndefined();

    await expect(
      manager.execute(`pcts_${"x".repeat(43)}`, operation("10000000-0000-4000-8000-000000000012")),
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

  it("enforces the Run Tool snapshot independently of model visibility", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create({ ...createRequest, allowedTools: ["read"] });

    await expect(
      manager.execute(created.capability, operation("10000000-0000-4000-8000-000000000041")),
    ).rejects.toMatchObject({ code: "tool_not_granted" });
    await expect(
      manager.execute(created.capability, {
        ...operation("10000000-0000-4000-8000-000000000042"),
        toolName: "read",
      }),
    ).rejects.toMatchObject({ code: "tool_operation_not_granted" });
    expect(fixture.createCount).toBe(0);
    expect(fixture.exec).not.toHaveBeenCalled();
  });

  it("queues materialization behind the global active Sandbox admission limit", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      commandId: "command-provider-test-second",
      workspaceId: "workspace-provider-test-second",
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

  it("reads persistent Workspace files without consuming Cube admission capacity", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
      maximumActiveSandboxes: 1,
    });
    const active = await manager.create(createRequest);
    await manager.execute(active.capability, operation("20000000-0000-4000-8000-000000000050"));
    expect(manager.admittedCount).toBe(1);
    const snapshot = Buffer.from("persistent-volume-reference", "utf8");

    await expect(
      manager.materializeFile({
        toolBrokerProtocolVersion: 1,
        type: "workspace.materialize_file",
        requestId: "20000000-0000-4000-8000-000000000051",
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        snapshot: {
          encoding: "base64",
          sha256: createHash("sha256").update(snapshot).digest("hex"),
          sizeBytes: snapshot.byteLength,
          data: snapshot.toString("base64"),
        },
        path: "surface_check.py",
      }),
    ).resolves.toMatchObject({
      type: "workspace.file_materialized",
      path: "surface_check.py",
    });
    expect(fixture.materializeFile).toHaveBeenCalledTimes(1);
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await manager.stop(active.activationId, assignment);
  });

  it("removes an aborted Tool Sandbox admission waiter without consuming capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      commandId: "command-provider-test-aborted",
      workspaceId: "workspace-provider-test-aborted",
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
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("10000000-0000-4000-8000-000000000018"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
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

  it("suspends and restores a parent capability around one shared-Workspace Subagent", async () => {
    class DelegatedHandoffRepository extends InMemorySandboxActivationStateRepository {
      override async allowsDelegatedSandboxHandoff(): Promise<boolean> {
        return true;
      }
    }
    const fixture = providerFixture();
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      stateRepository: new DelegatedHandoffRepository(),
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => capabilities.shift()!,
    });
    const parent = await manager.create(createRequest);
    await manager.execute(parent.capability, operation("73300000-0000-4000-8000-000000000001"));
    const childAssignment = {
      ...assignment,
      sessionId: "session-provider-test-subagent",
      commandId: "command-provider-test-subagent",
      turnId: "turn-provider-test-subagent",
      attemptId: "73300000-0000-4000-8000-000000000002",
      leaseId: "73300000-0000-4000-8000-000000000002",
      fencingToken: 8,
    };
    const child = await manager.create({
      ...createRequest,
      requestId: "73300000-0000-4000-8000-000000000003",
      assignment: childAssignment,
      workspaceRevision: "1".repeat(64),
    });
    expect(child).toMatchObject({ activationId: parent.activationId, continuity: "warm_reuse" });
    await expect(
      manager.execute(parent.capability, operation("73300000-0000-4000-8000-000000000004")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
    await manager.execute(child.capability, operation("73300000-0000-4000-8000-000000000005"));
    await manager.capture(
      child.activationId,
      childAssignment,
      "73300000-0000-4000-8000-000000000008",
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73300000-0000-4000-8000-000000000006",
      activationId: child.activationId,
      assignment: childAssignment,
      disposition: "keep_warm",
      workspaceRevision: "2".repeat(64),
    });
    await expect(
      manager.execute(parent.capability, operation("73300000-0000-4000-8000-000000000007")),
    ).resolves.toMatchObject({ operation: "bash.exec" });
    expect(fixture.createCount).toBe(1);
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);
    expect(fixture.rebind).toHaveBeenCalledTimes(2);
    await manager.stop(parent.activationId, assignment);
  });

  it("creates an isolated Workspace fork without revoking the parent capability", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const parent = await manager.create(createRequest);
    await manager.execute(parent.capability, operation("73400000-0000-4000-8000-000000000001"));
    const forked = await manager.forkWorkspace({
      toolBrokerProtocolVersion: 1,
      type: "workspace.fork",
      requestId: "73400000-0000-4000-8000-000000000002",
      sourceActivationId: parent.activationId,
      sourceAssignment: assignment,
      target: {
        tenantId: assignment.tenantId,
        projectId: assignment.projectId,
        workspaceId: "73400000-0000-4000-8000-000000000003",
        sessionId: "73400000-0000-4000-8000-000000000004",
      },
    });
    expect(forked).toMatchObject({
      type: "workspace.forked",
      sourceRevision: "a".repeat(64),
      targetRevision: "b".repeat(64),
    });
    await expect(
      manager.execute(parent.capability, operation("73400000-0000-4000-8000-000000000005")),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(fixture.forkWorkspace).toHaveBeenCalledTimes(1);
    await manager.stop(parent.activationId, assignment);
  });

  it("keeps a persistent runtime across the idle TTL and reuses it for the same Session", async () => {
    const fixture = providerFixture();
    let now = 1_000;
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
      warmTtlMs: 1_000,
      clock: () => now,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("71000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "71000000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "e".repeat(64),
    });

    now += 60_000;
    await manager.reapWarm();
    expect(manager.warmCount).toBe(1);
    expect(fixture.stopped).toBe(false);

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      commandId: "command-provider-test-persistent-next",
      turnId: "turn-provider-test-persistent-next",
      attemptId: "71000000-0000-4000-8000-000000000003",
      leaseId: "71000000-0000-4000-8000-000000000003",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "71000000-0000-4000-8000-000000000004",
      assignment: nextAssignment,
      workspaceRevision: "e".repeat(64),
    });
    expect(second.continuity).toBe("warm_reuse");
    expect(second.activationId).toBe(first.activationId);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("reaps a retained runtime after its conversation is archived", async () => {
    class RetiredStateRepository extends InMemorySandboxActivationStateRepository {
      retired = false;

      override async listRetiredWarmActivationIds(): Promise<readonly string[]> {
        return this.retired ? [ACTIVATION_ID] : [];
      }
    }
    const fixture = providerFixture();
    const stateRepository = new RetiredStateRepository();
    const manager = new ToolBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create(createRequest);
    await manager.execute(created.capability, operation("72000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "72000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "f".repeat(64),
    });

    stateRepository.retired = true;
    await manager.reapRetiredWarm();
    expect(manager.warmCount).toBe(0);
    expect(manager.admittedCount).toBe(0);
    expect(fixture.stopped).toBe(true);
  });

  it("does not let another Session displace a persistent process world", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("73000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73000000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "1".repeat(64),
    });

    await expect(
      manager.create({
        ...createRequest,
        requestId: "73000000-0000-4000-8000-000000000003",
        assignment: {
          ...assignment,
          sessionId: "session-provider-test-sibling",
          commandId: "command-provider-test-sibling",
          turnId: "turn-provider-test-sibling",
          attemptId: "73000000-0000-4000-8000-000000000004",
          leaseId: "73000000-0000-4000-8000-000000000004",
          fencingToken: 6,
        },
        workspaceRevision: "1".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "tool_sandbox_workspace_pinned", retryable: false });
    expect(fixture.stopped).toBe(false);
  });

  it("releases the durable reservation before moving an ordinary warm Workspace", async () => {
    class TrackingStateRepository extends InMemorySandboxActivationStateRepository {
      readonly released: string[] = [];

      override async setActivationState(
        activationId: string,
        state: Parameters<InMemorySandboxActivationStateRepository["setActivationState"]>[1],
      ): Promise<void> {
        if (state === "released") this.released.push(activationId);
      }
    }
    const fixture = providerFixture();
    const stateRepository = new TrackingStateRepository();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("73500000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73500000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "1".repeat(64),
    });

    const nextAssignment = {
      ...assignment,
      sessionId: "session-provider-test-conversation-child",
      commandId: "command-provider-test-conversation-child",
      turnId: "turn-provider-test-conversation-child",
      attemptId: "73500000-0000-4000-8000-000000000003",
      leaseId: "73500000-0000-4000-8000-000000000003",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "73500000-0000-4000-8000-000000000004",
      assignment: nextAssignment,
      workspaceRevision: "1".repeat(64),
    });

    expect(fixture.stopped).toBe(true);
    expect(stateRepository.released).toContain(first.activationId);
    expect(second.activationId).toBe(SECOND_ACTIVATION_ID);
    expect(second.continuity).toBe("cold_restore");
    await manager.stop(second.activationId, nextAssignment);
  });

  it("moves a persistent Workspace only between related conversation branches", async () => {
    class ConversationTreeStateRepository extends InMemorySandboxActivationStateRepository {
      readonly released: string[] = [];

      override async allowsPersistentConversationHandoff(): Promise<boolean> {
        return true;
      }

      override async setActivationState(
        activationId: string,
        state: Parameters<InMemorySandboxActivationStateRepository["setActivationState"]>[1],
      ): Promise<void> {
        if (state === "released") this.released.push(activationId);
      }
    }
    const fixture = providerFixture();
    const stateRepository = new ConversationTreeStateRepository();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("73600000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73600000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "1".repeat(64),
    });

    const nextAssignment = {
      ...assignment,
      sessionId: "session-provider-test-conversation-child",
      commandId: "command-provider-test-conversation-child",
      turnId: "turn-provider-test-conversation-child",
      attemptId: "73600000-0000-4000-8000-000000000003",
      leaseId: "73600000-0000-4000-8000-000000000003",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "73600000-0000-4000-8000-000000000004",
      assignment: nextAssignment,
      workspaceRevision: "1".repeat(64),
    });

    expect(fixture.stopped).toBe(true);
    expect(stateRepository.released).toContain(first.activationId);
    expect(second.activationId).toBe(SECOND_ACTIVATION_ID);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("evicts ordinary warm capacity before a persistent process world", async () => {
    const fixture = providerFixture();
    const activationIds = [
      ACTIVATION_ID,
      SECOND_ACTIVATION_ID,
      "30000000-0000-4000-8000-000000000030",
    ];
    const capabilities = [
      CAPABILITY,
      SECOND_CAPABILITY,
      `pcts_${"e".repeat(43)}`,
      `pcts_${"f".repeat(43)}`,
    ];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 2,
      maximumWarmActivations: 1,
    });
    const persistent = await manager.create(createRequest);
    await manager.execute(persistent.capability, operation("74000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000002",
      activationId: persistent.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "2".repeat(64),
    });

    const ordinaryAssignment: ToolSandboxAssignment = {
      ...assignment,
      workspaceId: "workspace-provider-test-ordinary",
      sessionId: "session-provider-test-ordinary",
      commandId: "command-provider-test-ordinary",
      turnId: "turn-provider-test-ordinary",
      attemptId: "74000000-0000-4000-8000-000000000003",
      leaseId: "74000000-0000-4000-8000-000000000003",
      fencingToken: 6,
    };
    const ordinary = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000004",
      assignment: ordinaryAssignment,
    });
    await manager.execute(ordinary.capability, {
      ...operation("74000000-0000-4000-8000-000000000005"),
      activationId: ordinary.activationId,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000006",
      activationId: ordinary.activationId,
      assignment: ordinaryAssignment,
      disposition: "keep_warm",
      workspaceRevision: "3".repeat(64),
    });
    expect(manager.warmCount).toBe(2);

    const demandAssignment: ToolSandboxAssignment = {
      ...ordinaryAssignment,
      workspaceId: "workspace-provider-test-new-demand",
      sessionId: "session-provider-test-new-demand",
      commandId: "command-provider-test-new-demand",
      turnId: "turn-provider-test-new-demand",
      attemptId: "74000000-0000-4000-8000-000000000007",
      leaseId: "74000000-0000-4000-8000-000000000007",
      fencingToken: 7,
    };
    const demand = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000008",
      assignment: demandAssignment,
    });
    await manager.execute(demand.capability, {
      ...operation("74000000-0000-4000-8000-000000000009"),
      activationId: demand.activationId,
    });
    expect(manager.warmCount).toBe(1);

    const persistentNextAssignment: ToolSandboxAssignment = {
      ...assignment,
      commandId: "command-provider-test-persistent-after-pressure",
      turnId: "turn-provider-test-persistent-after-pressure",
      attemptId: "74000000-0000-4000-8000-000000000010",
      leaseId: "74000000-0000-4000-8000-000000000010",
      fencingToken: 8,
    };
    const persistentAgain = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000011",
      assignment: persistentNextAssignment,
      workspaceRevision: "2".repeat(64),
    });
    expect(persistentAgain.continuity).toBe("warm_reuse");
    await manager.stop(persistentAgain.activationId, persistentNextAssignment);
    await manager.stop(demand.activationId, demandAssignment);
  });

  it("destroys a warm process world before another Session uses the same Workspace", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("60000000-0000-4000-8000-000000000012"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "60000000-0000-4000-8000-000000000013",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "d".repeat(64),
    });

    const siblingSession = {
      ...assignment,
      commandId: "command-provider-test-sibling-session",
      sessionId: "session-provider-test-sibling",
      turnId: "turn-provider-test-sibling",
      attemptId: "60000000-0000-4000-8000-000000000014",
      leaseId: "60000000-0000-4000-8000-000000000014",
      fencingToken: 6,
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "60000000-0000-4000-8000-000000000015",
      assignment: siblingSession,
      workspaceRevision: "d".repeat(64),
    });
    expect(second.continuity).toBe("cold_restore");
    expect(second.activationId).toBe(SECOND_ACTIVATION_ID);
    expect(fixture.stopped).toBe(true);
    await manager.execute(second.capability, {
      ...operation("60000000-0000-4000-8000-000000000016"),
      activationId: second.activationId,
    });
    expect(fixture.createCount).toBe(2);
    expect(fixture.rebind).not.toHaveBeenCalled();
    await manager.stop(second.activationId, siblingSession);
  });

  it("evicts the least-recently-used warm runtime when new demand reaches admission capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const capabilities = [CAPABILITY, SECOND_CAPABILITY];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      capabilityGenerator: () => capabilities.shift()!,
      maximumActiveSandboxes: 1,
      maximumWarmActivations: 4,
    });
    const first = await manager.create(createRequest);
    await manager.execute(first.capability, operation("50000000-0000-4000-8000-000000000012"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
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

  it("keeps a fenced warm runtime until termination names its current Broker authority", async () => {
    const fixture = providerFixture();
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
      maximumActiveSandboxes: 1,
    });
    const created = await manager.create(createRequest);
    await manager.execute(created.capability, operation("40000000-0000-4000-8000-000000000012"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
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
      containerName: `pi-cloud-tool-${ACTIVATION_ID}`.slice(0, 63),
      supervisorId: assignment.supervisorId,
      bootId: assignment.bootId,
      sandboxId: assignment.sandboxId,
      commandId: "command-provider-test-advanced",
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      turnId: "turn-provider-test-advanced",
      leaseId: "40000000-0000-4000-8000-000000000014",
      fencingToken: assignment.fencingToken + 1,
    };
    await manager.terminateAndConfirmAbsent(advancedInventoryAssignment);

    expect(manager.admittedCount).toBe(1);
    expect(manager.warmCount).toBe(1);
    expect(manager.activeCount).toBe(1);
    await manager.terminateAndConfirmAbsent({
      ...advancedInventoryAssignment,
      commandId: assignment.commandId,
      turnId: assignment.turnId,
      leaseId: assignment.leaseId,
      fencingToken: assignment.fencingToken + 1,
    });

    expect(manager.admittedCount).toBe(0);
    expect(manager.warmCount).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("keeps a Broker-owned warm process world out of expired Supervisor inventory", async () => {
    const fixture = providerFixture();
    const runtimeAssignment: SupervisorRuntimeAssignment = {
      containerId: "66666666-6666-4666-8666-666666666666",
      containerName: `pi-cloud-tool-${ACTIVATION_ID}`.slice(0, 63),
      supervisorId: assignment.supervisorId,
      bootId: assignment.bootId,
      sandboxId: assignment.sandboxId,
      commandId: assignment.commandId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      turnId: assignment.turnId,
      leaseId: assignment.leaseId,
      fencingToken: assignment.fencingToken,
    };
    fixture.provider.listAssignments = async () => [runtimeAssignment];
    const manager = new ToolBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const created = await manager.create(createRequest);
    await manager.execute(created.capability, operation("41000000-0000-4000-8000-000000000001"));
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "41000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_persistent",
      workspaceRevision: "b".repeat(64),
    });

    await expect(manager.listAssignments(assignment.sandboxId)).resolves.toEqual([]);
    expect(manager.warmCount).toBe(1);
    await manager.close();
  });

  it("revokes the capability before a provider stop failure escapes", async () => {
    const fixture = providerFixture();
    fixture.provider.stop = async () => {
      throw new ToolBrokerError("cleanup_failed", "cleanup failed", true);
    };
    const manager = new ToolBroker({
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
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-manager-config-"));
    const tokenPath = join(directory, "manager-token");
    try {
      await writeFile(tokenPath, `${"t".repeat(48)}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
      const terminalTokenPath = join(directory, "terminal-token");
      await writeFile(terminalTokenPath, `${"w".repeat(48)}\n`, { mode: 0o600 });
      await chmod(terminalTokenPath, 0o600);
      const cubeKeyPath = join(directory, "cube-api-key");
      await writeFile(cubeKeyPath, `${"k".repeat(48)}\n`, { mode: 0o600 });
      await chmod(cubeKeyPath, 0o600);
      const workspaceVolumeGatewayTokenPath = join(directory, "workspace-volume-gateway-token");
      await writeFile(workspaceVolumeGatewayTokenPath, `${"m".repeat(48)}\n`, { mode: 0o600 });
      await chmod(workspaceVolumeGatewayTokenPath, 0o600);
      const databaseUrlPath = join(directory, "database-url");
      await writeFile(databaseUrlPath, "postgresql://pi-cloud:secret@postgres:5432/pi-cloud\n", {
        mode: 0o600,
      });
      await chmod(databaseUrlPath, 0o600);
      await expect(
        loadToolBrokerConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_TOOL_BROKER_ADVERTISED_URL: "http://tool-broker-0:4300",
          PI_CLOUD_TOOL_BROKER_TOKEN_FILE: tokenPath,
          PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE: terminalTokenPath,
          PI_CLOUD_IMAGE_REVISION: "development",
          PI_CLOUD_CUBESANDBOX_API_URL: "https://cube-api.internal",
          PI_CLOUD_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: "pi-cloud-tool-v1",
          PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          PI_CLOUD_CUBESANDBOX_PROXY_SCHEME: "https",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: "http://workspace-volume-gateway:4500",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: workspaceVolumeGatewayTokenPath,
        }),
      ).resolves.toMatchObject({
        databaseUrl: "postgresql://pi-cloud:secret@postgres:5432/pi-cloud",
        sandboxDomainId: "sandbox-domain-0001",
        advertisedBaseUrl: "http://tool-broker-0:4300/",
        maximumActiveSandboxes: 2,
        maximumWarmActivations: 4,
        cubeSandbox: {
          apiUrl: "https://cube-api.internal",
          apiKey: "k".repeat(48),
          templateId: "pi-cloud-tool-v1",
          proxyNodeIp: "10.20.30.40",
          proxyPort: 443,
          proxyScheme: "https",
          sandboxDomain: "cube.app",
          workspaceVolumeGatewayUrl: "http://workspace-volume-gateway:4500",
          workspaceVolumeGatewayToken: "m".repeat(48),
        },
      });
      await expect(
        loadToolBrokerConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_TOOL_BROKER_ADVERTISED_URL: "http://tool-broker-0:4300",
          PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS: "10000",
          PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS: "5000",
          PI_CLOUD_TOOL_BROKER_TOKEN_FILE: tokenPath,
          PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE: terminalTokenPath,
          PI_CLOUD_IMAGE_REVISION: "development",
          PI_CLOUD_CUBESANDBOX_API_URL: "https://cube-api.internal",
          PI_CLOUD_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: "pi-cloud-tool-v1",
          PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: "http://workspace-volume-gateway:4500",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: workspaceVolumeGatewayTokenPath,
        }),
      ).rejects.toThrow("heartbeat must leave lease failure margin");
      await expect(
        loadToolBrokerConfig({
          PI_CLOUD_TOOL_BROKER_TOKEN_FILE: tokenPath,
          PI_CLOUD_IMAGE_REVISION: "development",
          PI_CLOUD_REPOSITORY_IMPORT_NETWORK: "repository-egress",
        }),
      ).rejects.toThrow("was removed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
