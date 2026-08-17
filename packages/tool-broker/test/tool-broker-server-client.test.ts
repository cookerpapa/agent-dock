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
import {
  PiCloudMetrics,
  activeTraceCarrier,
  initializeTelemetry,
  virtualRunTraceCarrier,
  withSpan,
  type TelemetryRuntime,
  type TraceCarrier,
} from "@pi-cloud/observability";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import {
  TOOL_BROKER_TERMINAL_PATH,
  TOOL_BROKER_SERVICE_PATH,
  ReplicatedToolBrokerClient,
  ToolBrokerClient,
  ToolBrokerOwnerRedirectError,
  ToolBrokerServer,
  type ToolBrokerBackend,
} from "../src/index.ts";

const SERVICE_TOKEN = `service-${"s".repeat(48)}`;
const MATERIALIZER_TOKEN = `materializer-${"m".repeat(48)}`;
const TERMINAL_TOKEN = `terminal-${"t".repeat(48)}`;
const CAPABILITY = `pcts_${"c".repeat(43)}`;
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
  containerName: "pi-cloud-tool-manager-test",
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

const servers: ToolBrokerServer[] = [];
let telemetry: TelemetryRuntime;
let observedServerTrace: TraceCarrier | undefined;

beforeAll(async () => {
  telemetry = await initializeTelemetry({ serviceName: "tool-broker-rpc-test" });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function backend(ownerBaseUrl = "http://tool-broker.invalid"): ToolBrokerBackend {
  return {
    providerId: "test-provider",
    async checkHealth() {},
    async create(request) {
      observedServerTrace = activeTraceCarrier();
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.reserved",
        requestId: request.requestId,
        activationId: ACTIVATION_ID,
        ownerBaseUrl,
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
        toolBrokerProtocolVersion: 1,
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
        toolBrokerProtocolVersion: 1,
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
      return Buffer.from('{"format":"pi-cloud.workspace-manifest.v1","files":[]}\n');
    },
    async materializeFile(request) {
      const content = Buffer.from("immutable\n");
      return {
        toolBrokerProtocolVersion: 1,
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

describe("Tool Broker authenticated RPC", () => {
  it("bridges an authenticated WebSocket to one bounded human PTY session", async () => {
    const terminalId = "10000000-0000-4000-8000-000000000080";
    const sendInput = vi.fn(async () => undefined);
    const resize = vi.fn(async () => undefined);
    const closeTerminal = vi.fn(async () => undefined);
    let finishOutput!: () => void;
    const outputFinished = new Promise<void>((resolve) => {
      finishOutput = resolve;
    });
    const terminalBackend: ToolBrokerBackend = {
      ...backend(),
      async openTerminal(input) {
        expect(input).toMatchObject({
          tenantId: "10000000-0000-4000-8000-000000000081",
          workspaceId: "10000000-0000-4000-8000-000000000084",
          size: { rows: 24, cols: 100 },
        });
        return {
          terminalId,
          pid: 73,
          output: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from("shell ready\r\n");
              await outputFinished;
            },
          },
          sendInput,
          resize,
          close: closeTerminal,
        };
      },
    };
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      terminalToken: TERMINAL_TOKEN,
      broker: terminalBackend,
    });
    servers.push(server);
    const address = await server.listen();
    const url = new URL(TOOL_BROKER_TERMINAL_PATH, address);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${TERMINAL_TOKEN}` },
    });
    const frames: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(data.toString("utf8")) as unknown;
      const waiter = waiters.shift();
      if (waiter === undefined) frames.push(frame);
      else waiter(frame);
    });
    const nextFrame = (): Promise<unknown> => {
      const frame = frames.shift();
      return frame === undefined
        ? new Promise<unknown>((resolve) => waiters.push(resolve))
        : Promise.resolve(frame);
    };
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.open",
        requestId: "10000000-0000-4000-8000-000000000088",
        tenantId: "10000000-0000-4000-8000-000000000081",
        userId: "10000000-0000-4000-8000-000000000082",
        projectId: "10000000-0000-4000-8000-000000000083",
        workspaceId: "10000000-0000-4000-8000-000000000084",
        sessionId: "10000000-0000-4000-8000-000000000085",
        environment: {
          environmentVersionId: "10000000-0000-4000-8000-000000000086",
          versionNumber: 1,
          profileKey: "pi-cloud-fullstack",
          profileVersion: "1",
          imageRevision: "development",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
        workspaceSeed: { kind: "sample_java" },
        rows: 24,
        cols: 100,
      }),
    );
    await expect(nextFrame()).resolves.toMatchObject({
      type: "workspace_terminal.ready",
      terminalId,
      pid: 73,
    });
    await expect(nextFrame()).resolves.toEqual({
      workspaceTerminalProtocolVersion: 1,
      type: "workspace_terminal.output",
      data: Buffer.from("shell ready\r\n").toString("base64"),
    });
    socket.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: Buffer.from("pwd\r").toString("base64"),
      }),
    );
    socket.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.resize",
        rows: 40,
        cols: 120,
      }),
    );
    socket.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.ping",
      }),
    );
    await expect(nextFrame()).resolves.toMatchObject({ type: "workspace_terminal.pong" });
    expect(sendInput).toHaveBeenCalledWith(Buffer.from("pwd\r"));
    expect(resize).toHaveBeenCalledWith({ rows: 40, cols: 120 });
    socket.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.close",
      }),
    );
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    finishOutput();
    expect(closeTerminal).toHaveBeenCalledOnce();
  });

  it("stays ready while at least one Tool Broker replica is healthy", async () => {
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      broker: backend(),
    });
    servers.push(server);
    const address = await server.listen();
    const client = new ReplicatedToolBrokerClient({
      baseUrls: ["http://127.0.0.1:1", address],
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
      requestTimeoutMs: 1_000,
    });

    await expect(client.checkHealth()).resolves.toBeUndefined();
  });

  it("balances creates and pins every activation to its returned owner", async () => {
    const calls = [0, 0];
    const activationIds = [
      "10000000-0000-4000-8000-000000000021",
      "10000000-0000-4000-8000-000000000022",
    ];
    const addresses: string[] = [];
    for (const replica of [0, 1]) {
      let ownerBaseUrl = "http://tool-broker.invalid";
      const delegate = backend();
      const broker: ToolBrokerBackend = {
        ...delegate,
        async create(request) {
          calls[replica]! += 1;
          return {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.reserved",
            requestId: request.requestId,
            activationId: activationIds[replica]!,
            ownerBaseUrl,
            capability: CAPABILITY,
            workspaceRoot: "/workspace",
            continuity: "cold_restore",
          };
        },
      };
      const server = new ToolBrokerServer({
        host: "127.0.0.1",
        port: 0,
        serviceToken: SERVICE_TOKEN,
        broker,
      });
      servers.push(server);
      ownerBaseUrl = await server.listen();
      addresses.push(ownerBaseUrl);
    }
    const client = new ReplicatedToolBrokerClient({
      baseUrls: addresses,
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(client.checkHealth()).resolves.toBeUndefined();

    for (const replica of [0, 1]) {
      const request: ToolSandboxCreateRequest = {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: `10000000-0000-4000-8000-00000000003${String(replica)}`,
        assignment: { ...assignment, workspaceId: `workspace-replica-${String(replica)}` },
        turnContextSha256: STEP_CONTEXT_SHA256,
        attemptContextSha256: STEP_CONTEXT_SHA256,
        environment: {
          environmentVersionId: "10000000-0000-4000-8000-000000000013",
          versionNumber: 1,
          profileKey: "pi-cloud-fullstack",
          profileVersion: "1",
          imageRevision: "development",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
        workspaceSeed: { kind: "sample_java" },
      };
      const reserved = await client.create(request);
      expect(reserved.activationId).toBe(activationIds[0]);
      expect(client.operationUrlFor(reserved.activationId)).toBe(
        new URL("/internal/v1/tool-operation", addresses[0]).toString(),
      );
      await expect(client.stop(reserved.activationId, request.assignment)).resolves.toBeUndefined();
      const siblingSessionRequest: ToolSandboxCreateRequest = {
        ...request,
        requestId: `10000000-0000-4000-8000-00000000004${String(replica)}`,
        assignment: {
          ...request.assignment,
          sessionId: `sibling-session-${String(replica)}`,
        },
      };
      const sibling = await client.create(siblingSessionRequest);
      expect(sibling.activationId).toBe(activationIds[1]);
      expect(client.operationUrlFor(sibling.activationId)).toBe(
        new URL("/internal/v1/tool-operation", addresses[1]).toString(),
      );
      await expect(
        client.stop(sibling.activationId, siblingSessionRequest.assignment),
      ).resolves.toBeUndefined();
    }
    expect(calls).toEqual([2, 2]);
  });

  it("follows the durable activation owner instead of replaying create elsewhere", async () => {
    const owner = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      broker: backend(),
    });
    servers.push(owner);
    const ownerAddress = await owner.listen();
    const redirect = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      broker: {
        ...backend(),
        async create() {
          throw new ToolBrokerOwnerRedirectError(ownerAddress);
        },
      },
    });
    servers.push(redirect);
    const redirectAddress = await redirect.listen();
    const client = new ToolBrokerClient({
      baseUrl: redirectAddress,
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
    });

    const reserved = await client.create({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000071",
      assignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      attemptContextSha256: STEP_CONTEXT_SHA256,
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000013",
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
      workspaceSeed: { kind: "sample_java" },
    });
    expect(reserved.activationId).toBe(ACTIVATION_ID);
  });

  it("separates the service credential from the per-activation tool capability", async () => {
    const metrics = new PiCloudMetrics("tool-broker-test");
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: SERVICE_TOKEN,
      materializerToken: MATERIALIZER_TOKEN,
      broker: backend(),
      metrics,
    });
    servers.push(server);
    const address = await server.listen();
    const client = new ToolBrokerClient({
      baseUrl: address,
      serviceToken: SERVICE_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(client.checkHealth()).resolves.toBeUndefined();

    const request: ToolSandboxCreateRequest = {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000011",
      assignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      attemptContextSha256: STEP_CONTEXT_SHA256,
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000013",
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
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
      toolBrokerProtocolVersion: 1,
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
    ).resolves.toEqual(Buffer.from('{"format":"pi-cloud.workspace-manifest.v1","files":[]}\n'));
    await expect(client.listAssignments(runtimeAssignment.sandboxId)).resolves.toEqual([
      runtimeAssignment,
    ]);
    await expect(client.terminateAndConfirmAbsent(runtimeAssignment)).resolves.toBeUndefined();

    const manifest = Buffer.from('{"format":"pi-cloud.workspace-manifest.v1","files":[]}\n');
    const materializer = new ToolBrokerClient({
      baseUrl: address,
      serviceToken: MATERIALIZER_TOKEN,
      allowInsecureHttp: true,
    });
    await expect(
      materializer.materializeFile({
        toolBrokerProtocolVersion: 1,
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

    const overPrivileged = await fetch(new URL(TOOL_BROKER_SERVICE_PATH, address), {
      method: "POST",
      headers: {
        authorization: `Bearer ${MATERIALIZER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    expect(overPrivileged.status).toBe(401);

    const unauthorized = await fetch(new URL(TOOL_BROKER_SERVICE_PATH, address), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(unauthorized.status).toBe(401);
    const exportedMetrics = await metrics.registry.metrics();
    expect(exportedMetrics).toContain(
      'pi_cloud_sandbox_operation_seconds_count{service="tool-broker-test",operation="reserve",outcome="completed"} 1',
    );
    expect(exportedMetrics).toContain(
      'pi_cloud_tool_duration_seconds_count{service="tool-broker-test",tool="bash.exec",outcome="completed"} 1',
    );
    expect(exportedMetrics).toContain(
      'pi_cloud_sandbox_admission_active{provider="test-provider",service="tool-broker-test"} 0',
    );
    expect(exportedMetrics).toContain(
      'pi_cloud_sandbox_admission_limit{provider="test-provider",service="tool-broker-test"} 2',
    );
    expect(exportedMetrics).toContain(
      'pi_cloud_sandbox_admission_waiting{provider="test-provider",service="tool-broker-test"} 0',
    );
  });
});
