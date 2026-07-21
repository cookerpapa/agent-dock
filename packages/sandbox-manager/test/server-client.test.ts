import type {
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
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
import {
  SANDBOX_MANAGER_SERVICE_PATH,
  SandboxManagerClient,
  SandboxManagerServer,
  type SandboxManagerBackend,
} from "../src/index.ts";

const SERVICE_TOKEN = `service-${"s".repeat(48)}`;
const CAPABILITY = `adts_${"c".repeat(43)}`;
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
        output: Buffer.from("isolated\n").toString("base64"),
      };
    },
    async importGitHub() {
      return Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n');
    },
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async close() {},
  };
}

describe("Sandbox Manager authenticated RPC", () => {
  it("separates the service credential from the per-activation tool capability", async () => {
    const metrics = new AgentDockMetrics("sandbox-manager-test");
    const server = new SandboxManagerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
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
  });
});
