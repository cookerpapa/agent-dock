import type {
  AgentDockEvent,
  EventPublishMessage,
  ExecuteTurnCommandMessage,
  ToolSandboxCreateRequest,
} from "@agent-dock/protocol";
import {
  DockerSandboxProvider,
  SandboxManagerClient,
  SandboxManagerServer,
  ToolSandboxManager,
} from "@agent-dock/sandbox-manager";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteToolSandboxTurnRunner, type ToolSandboxManagerBoundary } from "../src/index.ts";

const enabled = process.env.AGENT_DOCK_REMOTE_TOOL_SANDBOX_TEST === "1";
const dockerCommand = process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker";
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
      turnId: "turn-remote-tool-integration",
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
    },
  };
}

function inspect(reference: string): Promise<Record<string, any>> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      dockerCommand,
      ["inspect", reference],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise((JSON.parse(stdout) as Record<string, any>[])[0]!);
      },
    );
  });
}

describe.skipIf(!enabled)("trusted Pi Runner with remote Tool Sandbox", () => {
  it("repairs code through RPC while the Docker worker stays offline and credential-free", async () => {
    const trustedWorkspace = await mkdtemp(join(tmpdir(), "agent-dock-trusted-runner-"));
    const provider = new DockerSandboxProvider({
      toolImage,
      dockerCommand,
      repositoryImportNetwork: "bridge",
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
    let inspectedRuntimeId: string | undefined;
    const manager: ToolSandboxManagerBoundary = {
      operationUrl: client.operationUrl,
      async create(request: ToolSandboxCreateRequest) {
        const created = await client.create(request);
        inspectedRuntimeId = created.runtimeId;
        const container = await inspect(created.runtimeId);
        expect(container.Config.User).toBe("1000:1000");
        expect(container.HostConfig.NetworkMode).toBe("none");
        expect(container.HostConfig.ReadonlyRootfs).toBe(true);
        expect(container.HostConfig.Binds ?? []).toHaveLength(0);
        expect(container.Mounts ?? []).toHaveLength(0);
        expect(container.Config.Env ?? []).not.toEqual(
          expect.arrayContaining([
            expect.stringMatching(/api[_-]?key|token|secret|password|credential|database_url/i),
          ]),
        );
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
      stop: (activationId, assignment) => client.stop(activationId, assignment),
    };
    const events: EventPublishMessage[] = [];
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
      expect(backend.activeCount).toBe(0);
      await expect(inspect(inspectedRuntimeId!)).rejects.toBeDefined();
    } finally {
      await server.close().catch(() => undefined);
      await rm(trustedWorkspace, { recursive: true, force: true });
    }
  }, 120_000);
});
