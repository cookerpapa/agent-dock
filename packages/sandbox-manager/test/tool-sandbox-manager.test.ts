import type {
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  isolationBoundary: "gvisor" as const,
  runtime: "runsc" as const,
  networkMode: "deny_all" as const,
  runAsUser: "1000:1000" as const,
  readOnlyRootFilesystem: true as const,
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
  environment,
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
  const rebind = vi.fn<SandboxProvider["rebind"]>(async (handle, nextAssignment) => ({
    ...handle,
    assignment: nextAssignment,
  }));
  const provider: SandboxProvider = {
    providerId: "gvisor",
    async checkHealth() {},
    async create(spec) {
      createSpec = spec;
      return {
        providerApiVersion: 1,
        providerId: "gvisor",
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
        providerId: "gvisor",
        state: "running",
        handle,
        effectiveIsolation: {
          isolationBoundary: "gvisor",
          runtime: "runsc",
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: true,
          networkMode: "none",
          mountCount: 0,
          hasDockerSocket: false,
          pidLimit: 128,
          processLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          droppedCapabilities: ["ALL"],
          securityOptions: ["no-new-privileges"],
          sandboxKernelRelease: "4.19.0-gvisor",
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
    expect(fixture.createSpec).toBeUndefined();
    await expect(
      manager.capture(ACTIVATION_ID, assignment, "10000000-0000-4000-8000-000000000017"),
    ).resolves.toMatchObject({ type: "tool_sandbox.unused" });

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
    await manager.execute(second.capability, {
      ...operation("10000000-0000-4000-8000-000000000022"),
      activationId: second.activationId,
    });
    expect(fixture.rebind).toHaveBeenCalledTimes(1);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    await manager.stop(second.activationId, nextAssignment);
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
    await expect(
      manager.execute(CAPABILITY, operation("10000000-0000-4000-8000-000000000015")),
    ).rejects.toMatchObject({ code: "invalid_tool_capability" });
  });

  it("rejects unknown runtime selectors instead of accepting a fallback", async () => {
    await expect(
      loadSandboxManagerConfig({ AGENT_DOCK_SANDBOX_PROVIDER: "vercel" }),
    ).rejects.toThrow("is invalid");
  });

  it("loads only the fixed Kubernetes gVisor deployment configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-dock-manager-config-"));
    const tokenPath = join(directory, "manager-token");
    const issuerPath = join(directory, "dependency-egress-private-key.pem");
    try {
      await writeFile(tokenPath, `${"t".repeat(48)}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
      const { privateKey } = generateKeyPairSync("ed25519");
      await writeFile(issuerPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      });
      await chmod(issuerPath, 0o600);
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_TOOL_SANDBOX_IMAGE: "agent-dock/tool-sandbox:test",
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_KUBECONFIG_PATH: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
          AGENT_DOCK_DEPENDENCY_EGRESS_PRIVATE_KEY_FILE: issuerPath,
        }),
      ).resolves.toMatchObject({
        toolImage: "agent-dock/tool-sandbox:test",
        kubeconfigPath: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
        runtimeClassName: "agent-dock-gvisor",
        imagePullPolicy: "Never",
        cleanPrewarmTarget: 2,
        cleanPrewarmTtlMs: 300_000,
        dependencyEgress: {
          namespace: "agent-dock-egress",
          configMapName: "dependency-egress-trust",
          serviceName: "dependency-egress-proxy",
          servicePort: 3128,
          capabilityTtlMs: 900_000,
        },
      });
      await chmod(issuerPath, 0o644);
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_TOOL_SANDBOX_IMAGE: "agent-dock/tool-sandbox:test",
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_KUBECONFIG_PATH: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
          AGENT_DOCK_DEPENDENCY_EGRESS_PRIVATE_KEY_FILE: issuerPath,
        }),
      ).rejects.toThrow(/not private/);
      await chmod(issuerPath, 0o600);
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_TOOL_SANDBOX_IMAGE: "agent-dock/tool-sandbox:test",
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_KUBECONFIG_PATH: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
          AGENT_DOCK_MICROVM_TEMPLATE_PULL_POLICY: "sometimes",
        }),
      ).rejects.toThrow("was removed");

      const cubeKeyPath = join(directory, "cube-api-key");
      await writeFile(cubeKeyPath, `${"k".repeat(48)}\n`, { mode: 0o600 });
      await chmod(cubeKeyPath, 0o600);
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_PROVIDER: "cubesandbox",
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_TOOL_SANDBOX_IMAGE: "agent-dock/tool-sandbox:test",
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_KUBECONFIG_PATH: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
          AGENT_DOCK_CUBESANDBOX_API_URL: "https://cube-api.internal",
          AGENT_DOCK_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID: "agent-dock-tool-v1",
          AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME: "https",
        }),
      ).resolves.toMatchObject({
        provider: "cubesandbox",
        cubeSandbox: {
          apiUrl: "https://cube-api.internal",
          apiKey: "k".repeat(48),
          templateId: "agent-dock-tool-v1",
          proxyNodeIp: "10.20.30.40",
          proxyPort: 443,
          proxyScheme: "https",
          sandboxDomain: "cube.app",
        },
      });
      await expect(
        loadSandboxManagerConfig({
          AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: tokenPath,
          AGENT_DOCK_TOOL_SANDBOX_IMAGE: "agent-dock/tool-sandbox:test",
          AGENT_DOCK_IMAGE_REVISION: "development",
          AGENT_DOCK_KUBECONFIG_PATH: "/run/agent-dock-kubernetes/sandbox-manager.kubeconfig",
          AGENT_DOCK_REPOSITORY_IMPORT_NETWORK: "repository-egress",
        }),
      ).rejects.toThrow("was removed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
