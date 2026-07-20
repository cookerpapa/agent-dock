import type {
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DockerMicrovmSandboxProvider,
  ToolSandboxManager,
  type DockerMicrovmSandboxProviderOptions,
} from "../src/index.ts";

const enabled = process.env.AGENT_DOCK_MICROVM_SANDBOX_PROVIDER_TEST === "1";
const dockerCommand = process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker";
const toolImage =
  process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:provider-check";
const activationId = "10000000-0000-4000-8000-000000000201";
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-microvm-provider",
  supervisorId: "supervisor-microvm-provider",
  bootId: "20000000-0000-4000-8000-000000000001",
  sandboxId: "20000000-0000-4000-8000-000000000002",
  commandId: "command-microvm-provider",
  sessionId: "session-microvm-provider",
  turnId: "turn-microvm-provider",
  attemptId: "20000000-0000-4000-8000-000000000003",
  leaseId: "20000000-0000-4000-8000-000000000003",
  fencingToken: 9,
};

function providerOptions(stateDirectory: string): DockerMicrovmSandboxProviderOptions {
  return {
    toolImage,
    dockerCommand,
    repositoryImportNetwork: "bridge",
    stateDirectory,
    templatePullPolicy: "missing",
    createTimeoutMs: 600_000,
    operationTimeoutMs: 60_000,
  };
}

function bashOutput(response: ToolSandboxOperationResponse): string {
  if (response.type !== "tool_sandbox.operation_result" || response.operation !== "bash.exec") {
    throw new Error("Expected successful Bash output");
  }
  return Buffer.from(response.output, "base64").toString("utf8");
}

function hostExec(argumentsValue: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      dockerCommand,
      [...argumentsValue],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1_024 * 1_024 },
      (error, stdout) => {
        if (error !== null && typeof error.code !== "number") rejectPromise(error);
        else
          resolvePromise({
            code: error !== null && typeof error.code === "number" ? error.code : 0,
            stdout,
          });
      },
    );
  });
}

describe.skipIf(!enabled)("Docker microVM Sandbox Provider security contract", () => {
  it("runs the hardened worker behind a distinct kernel and survives Manager reconciliation", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "agent-dock-microvm-provider-"));
    const provider = new DockerMicrovmSandboxProvider(providerOptions(stateDirectory));
    const manager = new ToolSandboxManager({
      provider,
      idGenerator: () => activationId,
      capabilityGenerator: () => `adts_${"m".repeat(43)}`,
    });
    let freshProvider: DockerMicrovmSandboxProvider | undefined;
    let vmName: string | undefined;
    try {
      await provider.checkHealth();
      const created = await manager.create({
        managerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: "30000000-0000-4000-8000-000000000001",
        assignment,
        workspaceSeed: { kind: "sample_java" },
      });
      vmName = created.runtimeName;
      await expect(manager.inspect(created.activationId, assignment)).resolves.toMatchObject({
        providerId: "docker_microvm",
        state: "running",
        effectiveIsolation: {
          isolationBoundary: "microvm",
          outerNetworkPolicy: "deny_all",
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: true,
          networkMode: "none",
          hasDockerSocket: false,
          pidLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          guestKernelRelease: expect.stringMatching(/linuxkit/),
        },
      });

      const environment = bashOutput(
        await manager.execute(`adts_${"m".repeat(43)}`, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000002",
          operation: "bash.exec",
          command: "env; tr '\\0' '\\n' < /proc/1/environ",
          cwd: "/workspace",
          timeoutMs: 5_000,
        }),
      );
      expect(environment).not.toMatch(
        /AGENT_DOCK|DATABASE_URL|AWS_|api[_-]?key|token|secret|credential|admg_|adts_/i,
      );

      const network = bashOutput(
        await manager.execute(`adts_${"m".repeat(43)}`, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000003",
          operation: "bash.exec",
          command:
            'node -e \'const n=require("node:net");const s=n.connect(443,"1.1.1.1");s.setTimeout(300,()=>{s.destroy();console.log("blocked")});s.on("error",()=>console.log("blocked"));s.on("connect",()=>{console.log("reachable");process.exit(2)})\'',
          cwd: "/workspace",
          timeoutMs: 5_000,
        }),
      );
      expect(network).toContain("blocked");
      expect(network).not.toContain("reachable");

      const bridgeNetwork = await hostExec([
        "sandbox",
        "exec",
        vmName,
        "sh",
        "-lc",
        "curl -fsS --max-time 3 https://example.com >/dev/null 2>&1",
      ]);
      expect(bridgeNetwork.code).not.toBe(0);

      await expect(
        manager.execute(`adts_${"m".repeat(43)}`, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000004",
          operation: "file.write",
          path: "microvm.txt",
          content: "isolated kernel",
        }),
      ).resolves.toMatchObject({ operation: "file.write" });
      await expect(
        manager.execute(`adts_${"m".repeat(43)}`, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000005",
          operation: "file.read",
          path: "microvm.txt",
        }),
      ).resolves.toMatchObject({
        operation: "file.read",
        content: Buffer.from("isolated kernel").toString("base64"),
      });
      await expect(
        manager.execute(`adts_${"m".repeat(43)}`, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000006",
          operation: "file.read",
          path: "../etc/passwd",
        }),
      ).resolves.toMatchObject({ code: "tool_path_escape" });

      const controller = new AbortController();
      const sleeping = manager.execute(
        `adts_${"m".repeat(43)}`,
        {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: created.activationId,
          operationId: "30000000-0000-4000-8000-000000000007",
          operation: "bash.exec",
          command: "sleep 300 & wait",
          cwd: "/workspace",
          timeoutMs: 300_000,
        },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 250).unref();
      await expect(sleeping).resolves.toMatchObject({ code: "tool_cancelled" });

      await expect(
        manager.capture(created.activationId, assignment, "30000000-0000-4000-8000-000000000008"),
      ).resolves.toMatchObject({
        type: "tool_sandbox.captured",
        activationId: created.activationId,
      });

      freshProvider = new DockerMicrovmSandboxProvider(providerOptions(stateDirectory));
      await freshProvider.checkHealth();
      const recovered = await freshProvider.listAssignments(assignment.sandboxId);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        containerId: created.runtimeId,
        containerName: created.runtimeName,
        sessionId: assignment.sessionId,
        turnId: assignment.turnId,
      });
      const runtimeAssignment: SupervisorRuntimeAssignment = recovered[0]!;
      await freshProvider.terminateAndConfirmAbsent(runtimeAssignment);
      await expect(freshProvider.confirmAbsent(runtimeAssignment)).resolves.toBeUndefined();
      expect((await hostExec(["sandbox", "ls", "--quiet"])).stdout).not.toContain(vmName);
      vmName = undefined;
    } finally {
      await freshProvider?.close().catch(() => undefined);
      await provider.close().catch(() => undefined);
      if (vmName !== undefined) {
        await hostExec(["sandbox", "rm", vmName]).catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 600_000);
});
