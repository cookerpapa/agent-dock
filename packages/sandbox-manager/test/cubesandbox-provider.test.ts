import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ToolSandboxAssignment,
  type ToolSandboxOperationRequest,
} from "@agent-dock/protocol";
import {
  createWorkspaceSnapshot,
  encodeWorkspaceSnapshotBlob,
} from "@agent-dock/workspace-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxProvider,
  ToolSandboxManager,
  type CubeSandboxCreateInput,
  type CubeSandboxDataRequest,
  type CubeSandboxInstance,
  type CubeSandboxRuntimeClient,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const CAPABILITY = `adts_${"c".repeat(43)}`;
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-cube-test",
  projectId: "project-cube-test",
  workspaceId: "workspace-cube-test",
  supervisorId: "supervisor-cube-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-cube-test",
  sessionId: "session-cube-test",
  turnId: "turn-cube-test",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000004",
  fencingToken: 7,
};

const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000005",
  versionNumber: 1,
  profileKey: "agent-dock-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

const toolchain = {
  profileKey: environment.profileKey,
  profileVersion: environment.profileVersion,
  imageRevision: environment.imageRevision,
  specSha256: environment.specSha256,
  recipeSha256: environment.recipeSha256,
  tools: [
    { name: "node" as const, version: "v24.18.0" },
    { name: "java" as const, version: 'openjdk version "17.0.19"' },
    { name: "python" as const, version: "Python 3.11.2" },
    { name: "git" as const, version: "git version 2.39.5" },
  ],
  recipeCommands: [],
};

const snapshot = encodeWorkspaceSnapshotBlob(
  createWorkspaceSnapshot([
    { path: "result.txt", executable: false, content: Buffer.from("cube\n") },
  ]),
);

class FakeCubeRuntimeClient implements CubeSandboxRuntimeClient {
  readonly creates: CubeSandboxCreateInput[] = [];
  readonly requests: { sandboxId: string; input: CubeSandboxDataRequest }[] = [];
  readonly destroyed: string[] = [];
  readonly instances = new Map<string, CubeSandboxInstance>();
  healthChecks = 0;
  closed = false;

  async checkHealth(): Promise<void> {
    this.healthChecks += 1;
  }

  async create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance> {
    this.creates.push(input);
    const sandboxId = `cube-sandbox-${String(this.creates.length)}`;
    const instance: CubeSandboxInstance = {
      sandboxId,
      templateId: input.templateId,
      state: "running",
      domain: "cube.internal",
      metadata: input.metadata,
      trafficAccessToken: `traffic-${String(this.creates.length)}`,
      cpuCount: 1,
      memoryMB: 768,
    };
    this.instances.set(sandboxId, instance);
    return instance;
  }

  async read(sandboxId: string): Promise<CubeSandboxInstance | undefined> {
    return this.instances.get(sandboxId);
  }

  async list(): Promise<readonly CubeSandboxInstance[]> {
    return [...this.instances.values()];
  }

  async destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
    this.instances.delete(sandboxId);
  }

  async request(instance: CubeSandboxInstance, input: CubeSandboxDataRequest): Promise<unknown> {
    this.requests.push({ sandboxId: instance.sandboxId, input });
    if (input.path === "/v1/evidence") {
      return {
        imageRevision: "development",
        kernelRelease: "6.12.0-cube.guest",
        cpuCount: 1,
        memoryBytes: 740 * 1_024 * 1_024,
        uid: 1_000,
        gid: 1_000,
        hypervisorFlag: true,
        noNewPrivileges: true,
        effectiveCapabilities: "0000000000000000",
        readOnlyRootFilesystem: false,
      };
    }
    if (input.path === "/v1/initialize") return toolchain;
    if (input.path === "/v1/capture") {
      const body = input.body as { activationId: string; requestId: string };
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.captured",
        activationId: body.activationId,
        requestId: body.requestId,
        workspace: snapshot,
      };
    }
    if (input.path === "/v1/cancel") return { cancelled: true };
    if (input.path === "/v1/operation") {
      const operation = input.body as ToolSandboxOperationRequest;
      if (operation.operation !== "bash.exec") throw new Error("unexpected operation");
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: operation.activationId,
        operationId: operation.operationId,
        operation: "bash.exec",
        exitCode: 0,
        output: Buffer.from("inside cube\n").toString("base64"),
      };
    }
    throw new Error(`unexpected path ${input.path}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function operation(activationId: string): ToolSandboxOperationRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId: "10000000-0000-4000-8000-000000000020",
    operation: "bash.exec",
    command: "printf 'inside cube\\n'",
    cwd: "/workspace",
    timeoutMs: 1_000,
  };
}

describe("CubeSandbox Provider contract", () => {
  it("attests a real-template probe and always requests private deny-all networking", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
      templateId: "agent-dock-tool-v1",
      imageRevision: "development",
      runtimeClient: runtime,
      importGitHub: vi.fn(async () => Buffer.alloc(0)),
    });
    await provider.checkHealth();
    expect(runtime.healthChecks).toBe(1);
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]).toMatchObject({
      templateId: "agent-dock-tool-v1",
      allowInternetAccess: false,
      allowPublicTraffic: false,
      metadata: {
        "agentdock.managed": "true",
        "agentdock.provider": "cubesandbox",
        "agentdock.workload": "runtime-probe",
      },
    });
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    await provider.close();
  });

  it("preserves Manager capabilities, assignment inventory and content checkpoints", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
      templateId: "agent-dock-tool-v1",
      imageRevision: "development",
      runtimeClient: runtime,
      importGitHub: vi.fn(async () => Buffer.alloc(0)),
    });
    const manager = new ToolSandboxManager({
      provider,
      imageRevision: "development",
      idGenerator: () => ACTIVATION_ID,
      capabilityGenerator: () => CAPABILITY,
    });
    const reserved = await manager.create({
      managerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000011",
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    expect(runtime.creates).toHaveLength(0);
    const response = await manager.execute(reserved.capability, operation(reserved.activationId));
    expect(response).toMatchObject({ operation: "bash.exec", exitCode: 0 });
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]?.metadata).not.toHaveProperty("host-mount");
    expect(await manager.listAssignments(assignment.sandboxId)).toEqual([
      expect.objectContaining({
        containerName: "cube-sandbox-1",
        supervisorId: assignment.supervisorId,
        fencingToken: assignment.fencingToken,
      }),
    ]);
    const captured = await manager.capture(
      reserved.activationId,
      assignment,
      "10000000-0000-4000-8000-000000000021",
    );
    expect(captured).toMatchObject({
      type: "tool_sandbox.captured",
      workspace: snapshot,
      environment: {
        isolationBoundary: "microvm",
        runtime: "cubesandbox-kvm",
        readOnlyRootFilesystem: false,
      },
    });
    const released = await manager.release({
      managerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000022",
      activationId: reserved.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "a".repeat(64),
    });
    expect(released.retained).toBe(false);
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    expect(manager.warmCount).toBe(0);
    await manager.close();
  });

  it("destroys an uncertain VM instead of replaying an arbitrary command", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const originalRequest = runtime.request.bind(runtime);
    runtime.request = async (instance, input) => {
      if (input.path === "/v1/operation") throw new Error("connection lost");
      return originalRequest(instance, input);
    };
    const provider = new CubeSandboxProvider({
      templateId: "agent-dock-tool-v1",
      imageRevision: "development",
      runtimeClient: runtime,
      importGitHub: vi.fn(async () => Buffer.alloc(0)),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    await expect(provider.exec(handle, operation(ACTIVATION_ID))).rejects.toMatchObject({
      code: "cubesandbox_tool_result_unknown",
    });
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    await expect(provider.inspect(handle)).resolves.toMatchObject({ state: "absent" });
    await provider.close();
  });
});
