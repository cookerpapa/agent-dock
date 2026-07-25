import type {
  AgentDockEvent,
  EventPublishMessage,
  ExecuteTurnCommandMessage,
  ToolSandboxCreateRequest,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import {
  KubernetesGvisorSandboxProvider,
  OfficialKubernetesRuntimeClient,
  SandboxManagerClient,
  SandboxManagerServer,
  ToolSandboxManager,
} from "@agent-dock/sandbox-manager";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteToolSandboxTurnRunner, type ToolSandboxManagerBoundary } from "../src/index.ts";

const enabled = process.env.AGENT_DOCK_REMOTE_TOOL_SANDBOX_TEST === "1";
const kubeconfigPath =
  process.env.AGENT_DOCK_KUBECONFIG_PATH ??
  "/home/rayn/agent-dock/deploy/production/runtime/kubernetes/sandbox-manager.kubeconfig";
const toolImage = process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:production";
const serviceToken = `integration-${"s".repeat(48)}`;

function command(): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: "10000000-0000-4000-8000-000000000001",
    sentAt: "2026-07-20T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      commandId: "20000000-0000-4000-8000-000000000001",
      idempotencyKey: "remote-tool-integration",
      tenantId: "tenant-remote-tool-integration",
      projectId: "project-remote-tool-integration",
      workspaceId: "workspace-remote-tool-integration",
      sessionId: "session-remote-tool-integration",
      runId: "40000000-0000-4000-8000-000000000001",
      turnId: "turn-remote-tool-integration",
      attemptId: "50000000-0000-4000-8000-000000000001",
      agentId: "root",
      leaseId: "10000000-0000-4000-8000-000000000002",
      fencingToken: 1,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "Run the test, repair the Java bug, and verify it." },
      model: {
        profileId: "profile-remote-tool-integration",
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: "credential-remote-tool-integration",
        credentialBindingVersion: 1,
      },
      environment: {
        environmentVersionId: "60000000-0000-4000-8000-000000000001",
        versionNumber: 1,
        profileKey: "agent-dock-fullstack",
        profileVersion: "1",
        imageRevision: process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE_REVISION ?? "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
}

describe.skipIf(!enabled)("trusted Pi Runner with remote Kubernetes gVisor Tool Sandbox", () => {
  it("completes a text-only turn without creating a Kubernetes Tool Pod", async () => {
    const trustedWorkspace = await mkdtemp(join(tmpdir(), "agent-dock-trusted-chat-runner-"));
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      runtimeClient,
    });
    const backend = new ToolSandboxManager({ provider });
    const server = new SandboxManagerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      manager: backend,
    });
    const address = await server.listen();
    const client = new SandboxManagerClient({
      baseUrl: address,
      serviceToken,
      allowInsecureHttp: true,
    });
    try {
      const runner = new RemoteToolSandboxTurnRunner({
        manager: client,
        runtimeIdentity: {
          supervisorId: "remote-tool-integration-supervisor",
          bootId: "10000000-0000-4000-8000-000000000003",
          sandboxId: "10000000-0000-4000-8000-000000000004",
        },
        trustedWorkspaceDirectory: trustedWorkspace,
        scenario: "text",
        piExecutionMode: "embedded-sdk",
      });
      const events: EventPublishMessage[] = [];
      await runner.run(
        command(),
        (message) => {
          events.push(message);
        },
        new AbortController().signal,
      );

      expect(events.at(-1)?.payload.event.type).toBe("turn.completed");
      expect(events.some((message) => message.payload.event.type === "tool.started")).toBe(false);
      expect({
        reservedCount: backend.reservedCount,
        activeCount: backend.activeCount,
        cleanPrewarmCount: backend.cleanPrewarmCount,
        warmCount: backend.warmCount,
        assignments: await provider.listAssignments("10000000-0000-4000-8000-000000000004"),
      }).toEqual({
        reservedCount: 0,
        activeCount: 0,
        cleanPrewarmCount: 0,
        warmCount: 0,
        assignments: [],
      });
    } finally {
      await server.close().catch(() => undefined);
      await rm(trustedWorkspace, { recursive: true, force: true });
    }
  }, 120_000);

  it("repairs code through the embedded SDK while the Kubernetes Pod stays offline and credential-free", async () => {
    const trustedWorkspace = await mkdtemp(join(tmpdir(), "agent-dock-trusted-runner-"));
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      runtimeClient,
    });
    const backend = new ToolSandboxManager({ provider });
    const server = new SandboxManagerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      manager: backend,
    });
    const address = await server.listen();
    const client = new SandboxManagerClient({
      baseUrl: address,
      serviceToken,
      allowInsecureHttp: true,
    });
    let inspectedRuntimeName: string | undefined;
    const manager: ToolSandboxManagerBoundary = {
      operationUrl: client.operationUrl,
      async create(request: ToolSandboxCreateRequest) {
        const created = await client.create(request);
        inspectedRuntimeName = `agent-dock-tool-${created.activationId}`.slice(0, 63);
        await expect(
          backend.inspect(created.activationId, request.assignment),
        ).resolves.toMatchObject({
          state: "running",
          effectiveIsolation: {
            isolationBoundary: "gvisor",
            runtime: "runsc",
            sandboxKernelRelease: expect.stringMatching(/gvisor/i),
            user: "1000:1000",
            networkMode: "kubernetes-network-policy/deny-all",
            readOnlyRootFilesystem: true,
            mountCount: 0,
            hasDockerSocket: false,
          },
        });
        const environmentProbe = await client.operation(created.capability, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "10000000-0000-4000-8000-000000000009",
          operation: "bash.exec",
          command: "env",
          cwd: "/workspace",
          timeoutMs: 2_000,
        });
        expect(environmentProbe.type).toBe("tool_sandbox.operation_result");
        if (
          environmentProbe.type !== "tool_sandbox.operation_result" ||
          environmentProbe.operation !== "bash.exec"
        ) {
          throw new Error("Expected a Bash environment probe");
        }
        const environment = Buffer.from(environmentProbe.output, "base64").toString("utf8");
        expect(environment).not.toMatch(/AGENT_DOCK|DATABASE_URL|AWS_|admg_|adts_/);

        await expect(
          client.operation(`adts_${"x".repeat(43)}`, {
            managerProtocolVersion: 1,
            type: "tool_sandbox.operation",
            activationId: created.activationId,
            operationId: "10000000-0000-4000-8000-000000000010",
            operation: "file.read",
            path: "src/Calculator.java",
          }),
        ).rejects.toMatchObject({ code: "invalid_tool_capability", retryable: false });

        const escapingRead = {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "10000000-0000-4000-8000-000000000011",
          operation: "file.read",
          path: "../etc/passwd",
        } as const;
        await expect(client.operation(created.capability, escapingRead)).resolves.toMatchObject({
          type: "tool_sandbox.operation_failed",
          code: "tool_path_escape",
        });
        await expect(client.operation(created.capability, escapingRead)).rejects.toMatchObject({
          code: "tool_operation_replay",
          retryable: false,
        });

        await expect(
          client.operation(created.capability, {
            managerProtocolVersion: 1,
            type: "tool_sandbox.operation",
            activationId: created.activationId,
            operationId: "10000000-0000-4000-8000-000000000012",
            operation: "bash.exec",
            command: "trap '' TERM; while :; do :; done",
            cwd: "/workspace",
            timeoutMs: 100,
          }),
        ).resolves.toMatchObject({
          type: "tool_sandbox.operation_failed",
          code: "tool_timeout",
          retryable: true,
        });
        return created;
      },
      capture: (activationId, assignment) => client.capture(activationId, assignment),
      release: (activationId, assignment, disposition) =>
        client.release(activationId, assignment, disposition),
      stop: (activationId, assignment) => client.stop(activationId, assignment),
    };
    const events: EventPublishMessage[] = [];
    let serverClosed = false;
    try {
      const runner = new RemoteToolSandboxTurnRunner({
        manager,
        runtimeIdentity: {
          supervisorId: "remote-tool-integration-supervisor",
          bootId: "10000000-0000-4000-8000-000000000003",
          sandboxId: "10000000-0000-4000-8000-000000000004",
        },
        trustedWorkspaceDirectory: trustedWorkspace,
        scenario: "java_repair",
        turnTimeoutMs: 60_000,
        piExecutionMode: "embedded-sdk",
      });
      try {
        await runner.run(
          command(),
          (message) => {
            events.push(message);
          },
          new AbortController().signal,
        );
      } catch (error: unknown) {
        throw new Error(
          `Remote runner failed after events ${JSON.stringify(events.map((value) => value.payload.event))}`,
          { cause: error },
        );
      }
      const publicEvents: AgentDockEvent[] = events.map((message) => message.payload.event);
      expect(publicEvents.filter((event) => event.type === "tool.started")).toHaveLength(3);
      expect(publicEvents.filter((event) => event.type === "tool.completed")).toHaveLength(3);
      const terminal = publicEvents.at(-1);
      expect(terminal?.type).toBe("turn.completed");
      if (terminal?.type !== "turn.completed") throw new Error("Expected a completed turn");
      expect(terminal.payload.workspacePatch?.patch).toContain("return left + right");
      expect(backend.activeCount).toBe(1);
      expect(backend.warmCount).toBe(1);
      await expect(
        runtimeClient.readPod("agent-dock-sandboxes", inspectedRuntimeName!),
      ).resolves.toBeDefined();
      await server.close();
      serverClosed = true;
      await expect(
        runtimeClient.readPod("agent-dock-sandboxes", inspectedRuntimeName!),
      ).resolves.toBeUndefined();
    } finally {
      if (!serverClosed) await server.close().catch(() => undefined);
      await rm(trustedWorkspace, { recursive: true, force: true });
    }
  }, 180_000);
});
