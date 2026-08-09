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
import {
  AgentDockMetrics,
  activeTraceCarrier,
  initializeTelemetry,
  virtualRunTraceCarrier,
  withSpan,
  type TelemetryRuntime,
  type TraceCarrier,
} from "@agent-dock/observability";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  SANDBOX_MANAGER_SERVICE_PATH,
  SandboxManagerClient,
  SandboxManagerServer,
  ShardedSandboxManagerClient,
  type SandboxManagerBackend,
} from "../src/index.ts";

const SERVICE_TOKEN = `service-${"s".repeat(48)}`;
const MATERIALIZER_TOKEN = `materializer-${"m".repeat(48)}`;
const CAPABILITY = `adts_${"c".repeat(43)}`;
const STEP_CONTEXT_SHA256 = "a".repeat(64);
const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-manager-test",
  projectId: "project-manager-test",
  workspaceId: "workspace-manager-test",
  supervisorId: "supervisor-manager-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-manager-test",
  sessionId: "session-manager-test",
  turnId: "turn-manager-test",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000003",
  fencingToken: 4,
};
const runtimeAssignment: SupervisorRuntimeAssignment = {
  containerId: "10000000-0000-4000-8000-000000000020",
  containerName: "agent-dock-tool-manager-test",
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

const servers: SandboxManagerServer[] = [];
let telemetry: TelemetryRuntime;
let observedServerTrace: TraceCarrier | undefined;

beforeAll(async () => {
  telemetry = await initializeTelemetry({ serviceName: "sandbox-manager-rpc-test" });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function backend(): SandboxManagerBackend {
  return {
    providerId: "test-provider",
    async checkHealth() {},
    async create(request) {
      observedServerTrace = activeTraceCarrier();
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.reserved",
        requestId: request.requestId,
        activationId: ACTIVATION_ID,
        capability: CAPABILITY,
        workspaceRoot: "/workspace",
        continuity: "cold_restore",
      };
    },
    async capture() {
      throw new Error("unused");
    },
    async release(request) {
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: false,
      };
    },
    activeCount: 0,
    admittedCount: 0,
    admissionWaitingCount: 0,
    maximumActiveSandboxes: 2,
    cleanPrewarmCount: 0,
    async stop() {},
    async execute(capability, request) {
      if (capability !== CAPABILITY) throw new Error("wrong capability");
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: request.activationId,
        operationId: request.operationId,
        operation: "bash.exec",
        exitCode: 0,
        outputChunks: [
          { seq: 1, stream: "stdout", data: Buffer.from("isolated\n").toString("base64") },
        ],
        outputSha256: createHash("sha256").update("isolated\n").digest("hex"),
      };
    },
    async importGitHub() {
      return Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n');
    },
    async materializeFile(request) {
      const content = Buffer.from("immutable\n");
      return {
        managerProtocolVersion: 1,
        type: "workspace.file_materialized",
        requestId: request.requestId,
        tenantId: request.tenantId,
        workspaceId: request.workspaceId,
        path: request.path,
        content: content.toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
        executable: false,
        sizeBytes: content.byteLength,
      };
    },
    async listAssignments(sandboxId) {
      return sandboxId === runtimeAssignment.sandboxId ? [runtimeAssignment] : [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async close() {},
  };
}

describe("Sandbox Manager authenticated RPC", () => {
  it("stays ready while at least one Manager shard is healthy", async () => {
    const server = new SandboxManagerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      manager: backend(),
    });
    servers.push(server);
    const address = await server.listen();
    const client = new ShardedSandboxManagerClient({
      baseUrls: ["http://127.0.0.1:1", address],
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
      requestTimeoutMs: 1_000,
    });

    await expect(client.checkHealth()).resolves.toBeUndefined();
  });

  it("keeps one Session on one stable Manager shard", async () => {
    const calls = [0, 0];
    const activationIds = [
      "10000000-0000-4000-8000-000000000021",
      "10000000-0000-4000-8000-000000000022",
    ];
    const addresses: string[] = [];
    for (const shard of [0, 1]) {
      const delegate = backend();
      const manager: SandboxManagerBackend = {
        ...delegate,
        async create(request) {
          calls[shard]! += 1;
          return {
            managerProtocolVersion: 1,
            type: "tool_sandbox.reserved",
            requestId: request.requestId,
            activationId: activationIds[shard]!,
            capability: CAPABILITY,
            workspaceRoot: "/workspace",
            continuity: "cold_restore",
          };
        },
      };
      const server = new SandboxManagerServer({
        host: "127.0.0.1",
        port: 0,
        serviceToken: SERVICE_TOKEN,
        manager,
      });
      servers.push(server);
      addresses.push(await server.listen());
    }
    const client = new ShardedSandboxManagerClient({
      baseUrls: addresses,
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(client.checkHealth()).resolves.toBeUndefined();

    const workspaceFor = (target: number): string => {
      for (let candidate = 0; candidate < 1_000; candidate += 1) {
        const value = `workspace-shard-${String(candidate)}`;
        if (createHash("sha256").update(value).digest().readUInt32BE(0) % 2 === target) {
          return value;
        }
      }
      throw new Error("failed to find deterministic shard fixture");
    };
    for (const shard of [0, 1]) {
      const request: ToolSandboxCreateRequest = {
        managerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: `10000000-0000-4000-8000-00000000003${String(shard)}`,
        assignment: { ...assignment, workspaceId: workspaceFor(shard) },
        turnContextSha256: STEP_CONTEXT_SHA256,
        attemptContextSha256: STEP_CONTEXT_SHA256,
        environment: {
          environmentVersionId: "10000000-0000-4000-8000-000000000013",
          versionNumber: 1,
          profileKey: "agent-dock-fullstack",
          profileVersion: "1",
          imageRevision: "development",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
        workspaceSeed: { kind: "sample_java" },
      };
      const reserved = await client.create(request);
      expect(reserved.activationId).toBe(activationIds[shard]);
      expect(client.operationUrlFor(reserved.activationId)).toBe(
        new URL("/internal/v1/tool-operation", addresses[shard]).toString(),
      );
      await expect(client.stop(reserved.activationId, request.assignment)).resolves.toBeUndefined();
      const siblingSessionRequest: ToolSandboxCreateRequest = {
        ...request,
        requestId: `10000000-0000-4000-8000-00000000004${String(shard)}`,
        assignment: {
          ...request.assignment,
          sessionId: `sibling-session-${String(shard)}`,
        },
      };
      const sibling = await client.create(siblingSessionRequest);
      expect(sibling.activationId).toBe(activationIds[shard]);
      await expect(
        client.stop(sibling.activationId, siblingSessionRequest.assignment),
      ).resolves.toBeUndefined();
    }
    expect(calls).toEqual([2, 2]);
  });

  it("separates the service credential from the per-activation tool capability", async () => {
    const metrics = new AgentDockMetrics("sandbox-manager-test");
    const server = new SandboxManagerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      materializerToken: MATERIALIZER_TOKEN,
      manager: backend(),
      metrics,
    });
    servers.push(server);
    const address = await server.listen();
    const client = new SandboxManagerClient({
      baseUrl: address,
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(client.checkHealth()).resolves.toBeUndefined();

    const request: ToolSandboxCreateRequest = {
      managerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000011",
      assignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      attemptContextSha256: STEP_CONTEXT_SHA256,
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000013",
        versionNumber: 1,
        profileKey: "agent-dock-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
      workspaceSeed: { kind: "sample_java" },
    };
    await withSpan({
      serviceName: "trusted-runner-test",
      name: "run.execute",
      parent: virtualRunTraceCarrier("1".repeat(32), "2".repeat(16)),
      run: async () => {
        await expect(client.create(request)).resolves.toMatchObject({
          activationId: ACTIVATION_ID,
          capability: CAPABILITY,
        });
      },
    });
    expect(observedServerTrace?.traceparent).toContain("1".repeat(32));

    const operation: ToolSandboxOperationRequest = {
      managerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: ACTIVATION_ID,
      operationId: "10000000-0000-4000-8000-000000000012",
      turnContextSha256: STEP_CONTEXT_SHA256,
      attemptContextSha256: STEP_CONTEXT_SHA256,
      stepContextSequence: 1,
      stepContextSha256: STEP_CONTEXT_SHA256,
      operation: "bash.exec",
      command: "pwd",
      cwd: "/workspace",
      timeoutMs: 1_000,
    };
    await expect(client.operation(CAPABILITY, operation)).resolves.toMatchObject({
      operation: "bash.exec",
      exitCode: 0,
    });
    await expect(
      client.importGitHub(
        {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n'));
    await expect(client.listAssignments(runtimeAssignment.sandboxId)).resolves.toEqual([
      runtimeAssignment,
    ]);
    await expect(client.terminateAndConfirmAbsent(runtimeAssignment)).resolves.toBeUndefined();

    const manifest = Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n');
    const materializer = new SandboxManagerClient({
      baseUrl: address,
      serviceToken: MATERIALIZER_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(
      materializer.materializeFile({
        managerProtocolVersion: 1,
        type: "workspace.materialize_file",
        requestId: "10000000-0000-4000-8000-000000000099",
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        snapshot: {
          encoding: "base64",
          sha256: createHash("sha256").update(manifest).digest("hex"),
          sizeBytes: manifest.byteLength,
          data: manifest.toString("base64"),
        },
        path: "README.md",
      }),
    ).resolves.toMatchObject({
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      path: "README.md",
      content: Buffer.from("immutable\n").toString("base64"),
    });

    const overPrivileged = await fetch(new URL(SANDBOX_MANAGER_SERVICE_PATH, address), {
      method: "POST",
      headers: {
        authorization: `Bearer ${MATERIALIZER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    expect(overPrivileged.status).toBe(401);

    const unauthorized = await fetch(new URL(SANDBOX_MANAGER_SERVICE_PATH, address), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(unauthorized.status).toBe(401);
    const exportedMetrics = await metrics.registry.metrics();
    expect(exportedMetrics).toContain(
      'agent_dock_sandbox_operation_seconds_count{service="sandbox-manager-test",operation="reserve",outcome="completed"} 1',
    );
    expect(exportedMetrics).toContain(
      'agent_dock_tool_duration_seconds_count{service="sandbox-manager-test",tool="bash.exec",outcome="completed"} 1',
    );
    expect(exportedMetrics).toContain(
      'agent_dock_sandbox_admission_active{provider="test-provider",service="sandbox-manager-test"} 0',
    );
    expect(exportedMetrics).toContain(
      'agent_dock_sandbox_admission_limit{provider="test-provider",service="sandbox-manager-test"} 2',
    );
    expect(exportedMetrics).toContain(
      'agent_dock_sandbox_admission_waiting{provider="test-provider",service="sandbox-manager-test"} 0',
    );
  });
});
