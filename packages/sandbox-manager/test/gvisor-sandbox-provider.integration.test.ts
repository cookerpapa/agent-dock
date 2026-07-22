import type {
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import {
  canonicalEnvironmentRecipeJson,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import {
  createWorkspaceSnapshot,
  encodeWorkspaceSnapshotBlob,
  parseWorkspaceSnapshot,
} from "@agent-dock/workspace-runtime";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { release as hostKernelRelease } from "node:os";
import { describe, expect, it } from "vitest";
import {
  KubernetesGvisorSandboxProvider,
  OfficialKubernetesRuntimeClient,
  ToolSandboxManager,
} from "../src/index.ts";

const enabled = process.env.AGENT_DOCK_KUBERNETES_GVISOR_TEST === "1";
const kubeconfigPath =
  process.env.AGENT_DOCK_KUBECONFIG_PATH ??
  "/home/rayn/agent-dock/deploy/production/runtime/kubernetes/sandbox-manager.kubeconfig";
const toolImage = process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:production";
const imageRevision = process.env.AGENT_DOCK_IMAGE_REVISION ?? "development";
const dependencyEgressPrivateKeyFile =
  process.env.AGENT_DOCK_DEPENDENCY_EGRESS_PRIVATE_KEY_FILE ??
  "/home/rayn/agent-dock/deploy/production/runtime/secrets/dependency-egress-private-key.pem";
const ids = [
  "10000000-0000-4000-8000-000000000101",
  "10000000-0000-4000-8000-000000000102",
  "10000000-0000-4000-8000-000000000103",
  "10000000-0000-4000-8000-000000000104",
] as const;

function assignment(index: number): ToolSandboxAssignment {
  const suffix = String(index).padStart(3, "0");
  const attemptId = `20000000-0000-4000-8000-000000000${suffix}`;
  return {
    tenantId: `tenant-provider-${String(index)}`,
    projectId: `project-provider-${String(index)}`,
    workspaceId: `workspace-provider-${String(index)}`,
    supervisorId: "supervisor-provider-integration",
    bootId: "30000000-0000-4000-8000-000000000001",
    sandboxId: "30000000-0000-4000-8000-000000000002",
    commandId: `command-provider-${String(index)}`,
    sessionId: `session-provider-${String(index)}`,
    turnId: `turn-provider-${String(index)}`,
    attemptId,
    leaseId: attemptId,
    fencingToken: index,
  };
}

function createRequest(index: number): ToolSandboxCreateRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.create",
    requestId: `40000000-0000-4000-8000-000000000${String(index).padStart(3, "0")}`,
    assignment: assignment(index),
    environment: {
      environmentVersionId: `50000000-0000-4000-8000-000000000${String(index).padStart(3, "0")}`,
      versionNumber: 1,
      profileKey: "agent-dock-fullstack",
      profileVersion: "1",
      imageRevision,
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
    workspaceSeed: { kind: "sample_java" },
  };
}

function operation(
  activationId: string,
  operationId: string,
  command: string,
  timeoutMs = 5_000,
): ToolSandboxOperationRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId,
    operation: "bash.exec",
    command,
    cwd: "/workspace",
    timeoutMs,
  };
}

function bashOutput(response: ToolSandboxOperationResponse): string {
  if (response.type !== "tool_sandbox.operation_result" || response.operation !== "bash.exec") {
    throw new Error("Expected a successful Bash response");
  }
  return Buffer.from(response.output, "base64").toString("utf8");
}

describe.skipIf(!enabled)("Kubernetes gVisor Sandbox Provider security contract", () => {
  it("imports an exact public GitHub commit through the restricted importer plane", async () => {
    const privateKeyPem = await readFile(dependencyEgressPrivateKeyFile, "utf8");
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      runtimeClient,
      dependencyEgress: { privateKeyPem },
    });
    try {
      const snapshot = await provider.importGitHub(
        {
          kind: "github_public",
          repository: "mathewjonas/java-calculator-junit",
          commitSha: "0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb",
        },
        new AbortController().signal,
      );
      const files = parseWorkspaceSnapshot(snapshot);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.path === "pom.xml")).toBe(true);
      expect(files.some((file) => file.path === ".git" || file.path.startsWith(".git/"))).toBe(
        false,
      );
      await expect(
        runtimeClient.listPods("agent-dock-importers", "agent-dock.io/managed=true"),
      ).resolves.toEqual([]);
    } finally {
      await provider.close();
    }
  }, 120_000);

  it("installs a dependency through an exact-host capability while Agent bash stays offline", async () => {
    const privateKeyPem = await readFile(dependencyEgressPrivateKeyFile, "utf8");
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      runtimeClient,
      dependencyEgress: { privateKeyPem },
    });
    let nextId = 0;
    const manager = new ToolSandboxManager({
      provider,
      imageRevision,
      idGenerator: () => ids[nextId++]!,
      capabilityGenerator: () => `adts_${String(nextId).repeat(43).slice(0, 43)}`,
    });
    const recipe = {
      schemaVersion: 1 as const,
      dependencyHosts: ["registry.npmjs.org"],
      setupCommands: [
        {
          id: "install-is-number",
          command:
            "npm install --ignore-scripts --no-audit --no-fund --package-lock=false is-number@7.0.0",
          cwd: ".",
          timeoutMs: 120_000,
          network: "dependency" as const,
        },
      ],
      verificationCommands: [
        {
          id: "verify-is-number",
          command: "node -e \"if(!require('is-number')(7))process.exit(1)\"",
          cwd: ".",
          timeoutMs: 10_000,
          network: "none" as const,
        },
      ],
    };
    const request = createRequest(4);
    request.environment.recipe = recipe;
    request.environment.recipeSha256 = createHash("sha256")
      .update(canonicalEnvironmentRecipeJson(recipe))
      .digest("hex");
    const assignmentValue = assignment(4);
    let reserved: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    try {
      await provider.checkHealth();
      reserved = await manager.create(request);
      await expect(
        manager.execute(
          reserved.capability,
          operation(
            reserved.activationId,
            "60000000-0000-4000-8000-000000000001",
            "node -e \"if(!require('is-number')(42))process.exit(1)\"",
          ),
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(manager.inspect(reserved.activationId, assignmentValue)).resolves.toMatchObject({
        state: "running",
        handle: { environmentValidation: { networkMode: "deny_all" } },
        effectiveIsolation: {
          networkMode: "kubernetes-network-policy/deny-all",
          runtime: "runsc",
        },
      });
      const finalPod = await runtimeClient.readPod(
        "agent-dock-sandboxes",
        `agent-dock-tool-${reserved.activationId}`.slice(0, 63),
      );
      expect(finalPod?.metadata?.labels).toMatchObject({
        "agent-dock.io/workload": "tool-sandbox",
      });
      expect(finalPod?.metadata?.labels?.["agent-dock.io/dependency-egress"]).toBeUndefined();
      await expect(
        runtimeClient.listPods(
          "agent-dock-sandboxes",
          "agent-dock.io/managed=true,agent-dock.io/workload=dependency-bootstrap",
        ),
      ).resolves.toEqual([]);
      await expect(
        manager.execute(
          reserved.capability,
          operation(
            reserved.activationId,
            "60000000-0000-4000-8000-000000000002",
            "node -e \"fetch('https://example.com').then(()=>process.exit(1)).catch(()=>process.exit(0))\"",
            10_000,
          ),
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      if (reserved !== undefined) await manager.stop(reserved.activationId, assignmentValue);
      await manager.close();
    }
  }, 180_000);

  it("single-consumption claims a tenant-free clean prewarm Pod", async () => {
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      imageRevision,
      runtimeClient,
      cleanPrewarmTarget: 1,
      cleanPrewarmTtlMs: 120_000,
    });
    const manager = new ToolSandboxManager({ provider, imageRevision });
    const assignmentValue = assignment(20);
    const coldProvider = new KubernetesGvisorSandboxProvider({
      toolImage,
      imageRevision,
      runtimeClient,
    });
    const coldManager = new ToolSandboxManager({ provider: coldProvider, imageRevision });
    const coldAssignment = assignment(21);
    let reserved: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    let coldReserved: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    try {
      await provider.checkHealth();
      expect(provider.cleanPrewarmCount).toBe(1);
      const clean = await runtimeClient.listPods(
        "agent-dock-sandboxes",
        "agent-dock.io/managed=true,agent-dock.io/workload=clean-prewarm",
      );
      expect(clean).toHaveLength(1);
      const cleanName = clean[0]?.metadata?.name;
      const cleanUid = clean[0]?.metadata?.uid;
      expect(cleanName).toMatch(/^agent-dock-prewarm-/);
      expect(cleanUid).toBeDefined();
      expect(JSON.stringify(clean[0]?.metadata)).not.toMatch(
        /tenant-provider-20|project-provider-20|workspace-provider-20|session-provider-20/,
      );

      reserved = await manager.create({
        ...createRequest(20),
        assignment: assignmentValue,
      });
      expect(provider.cleanPrewarmCount).toBe(1);
      const prewarmStartedAt = performance.now();
      const prewarmResult = await manager.execute(
        reserved.capability,
        operation(
          reserved.activationId,
          "60000000-0000-4000-8000-000000000020",
          "node -e \"process.stdout.write('claimed-clean-prewarm')\"",
        ),
      );
      const prewarmFirstToolMs = Math.round(performance.now() - prewarmStartedAt);
      expect(prewarmResult).toMatchObject({ exitCode: 0 });
      const inspection = await manager.inspect(reserved.activationId, assignmentValue);
      expect(inspection).toMatchObject({
        state: "running",
        handle: {
          runtimeName: cleanName,
          runtimeId: cleanUid,
          assignment: { tenantId: assignmentValue.tenantId },
        },
        effectiveIsolation: {
          runtime: "runsc",
          networkMode: "kubernetes-network-policy/deny-all",
        },
      });
      const claimed = await runtimeClient.readPod("agent-dock-sandboxes", cleanName!);
      expect(claimed?.metadata?.labels).toMatchObject({
        "agent-dock.io/workload": "tool-sandbox",
      });
      expect(claimed?.metadata?.annotations?.["agent-dock.io/prewarm-id"]).toBeUndefined();
      expect(claimed?.metadata?.annotations).toMatchObject({
        "agent-dock.io/tenant-id": assignmentValue.tenantId,
        "agent-dock.io/attempt-id": assignmentValue.attemptId,
      });

      const refillDeadline = Date.now() + 30_000;
      while (provider.cleanPrewarmCount < 1 && Date.now() < refillDeadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      expect(provider.cleanPrewarmCount).toBe(1);
      coldReserved = await coldManager.create({
        ...createRequest(21),
        assignment: coldAssignment,
      });
      const coldStartedAt = performance.now();
      const coldResult = await coldManager.execute(
        coldReserved.capability,
        operation(
          coldReserved.activationId,
          "60000000-0000-4000-8000-000000000021",
          "node -e \"process.stdout.write('fresh-cold-start')\"",
        ),
      );
      const coldFirstToolMs = Math.round(performance.now() - coldStartedAt);
      expect(coldResult).toMatchObject({ exitCode: 0 });
      expect(prewarmFirstToolMs).toBeLessThan(coldFirstToolMs);
      process.stdout.write(
        `${JSON.stringify({ cleanPrewarmBenchmark: { prewarmFirstToolMs, coldFirstToolMs } })}\n`,
      );
    } finally {
      if (coldReserved !== undefined) {
        await coldManager.stop(coldReserved.activationId, coldAssignment).catch(() => undefined);
      }
      await coldManager.close().catch(() => undefined);
      if (reserved !== undefined) {
        await manager.stop(reserved.activationId, assignmentValue).catch(() => undefined);
      }
      await manager.close().catch(() => undefined);
    }
  }, 120_000);

  it("enforces identity, cgroups, namespace isolation, bounded output and exact cleanup", async () => {
    let nextId = 0;
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({
      toolImage,
      runtimeClient,
    });
    const manager = new ToolSandboxManager({
      provider,
      imageRevision,
      idGenerator: () => ids[nextId++]!,
      capabilityGenerator: () => `adts_${String(nextId).repeat(43).slice(0, 43)}`,
    });
    const firstAssignment = assignment(1);
    const secondAssignment = assignment(2);
    const emptyAssignment = assignment(3);
    let first: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    let second: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    let empty: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    let invalid: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
    try {
      first = await manager.create(createRequest(1));
      second = await manager.create(createRequest(2));

      await expect(manager.inspect(first.activationId, firstAssignment)).resolves.toMatchObject({
        state: "running",
        handle: {
          providerId: "kubernetes-gvisor",
          assignment: {
            tenantId: firstAssignment.tenantId,
            sessionId: firstAssignment.sessionId,
            turnId: firstAssignment.turnId,
            attemptId: firstAssignment.attemptId,
          },
        },
        effectiveIsolation: {
          isolationBoundary: "gvisor",
          runtime: "runsc",
          sandboxKernelRelease: expect.stringMatching(/gvisor/i),
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: true,
          networkMode: "kubernetes-network-policy/deny-all",
          mountCount: 0,
          hasDockerSocket: false,
          pidLimit: 128,
          processLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          droppedCapabilities: ["ALL"],
        },
      });

      const kernelIdentity = bashOutput(
        await manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000011",
            "uname -r; head -1 /proc/version; grep -m1 'model name' /proc/cpuinfo || true; ulimit -n",
          ),
        ),
      );
      expect(kernelIdentity).toMatch(/gvisor/i);
      expect(kernelIdentity).not.toContain(hostKernelRelease());
      expect(kernelIdentity).not.toMatch(/microsoft-standard-WSL2|AMD Ryzen|Intel\(R\)/i);
      expect(kernelIdentity.trimEnd().endsWith("1024")).toBe(true);

      const python = bashOutput(
        await manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000013",
            "python3 -c 'print(sum([1, 2, 3]))'",
          ),
        ),
      );
      expect(python).toBe("6\n");

      const environment = bashOutput(
        await manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000001",
            "env; tr '\\0' '\\n' < /proc/self/environ; tr '\\0' '\\n' < /proc/1/environ; printf 'pid1='; tr '\\0' ' ' < /proc/1/cmdline",
          ),
        ),
      );
      expect(environment).not.toMatch(
        /AGENT_DOCK|DATABASE_URL|AWS_|api[_-]?key|token|secret|credential|admg_|adts_/i,
      );
      expect(environment).not.toMatch(/pi\s+--mode\s+rpc|supervisor-host|control-plane/i);

      const cgroups = bashOutput(
        await manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000002",
            "printf 'memory='; (cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || cat /sys/fs/cgroup/memory.max); printf 'pids='; (cat /sys/fs/cgroup/pids/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids.max); printf 'cpu='; if test -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us; then cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us; cat /sys/fs/cgroup/cpu/cpu.cfs_period_us; else cat /sys/fs/cgroup/cpu.max; fi; printf 'workspace='; df -B1 --output=size /workspace | tail -1",
          ),
        ),
      );
      // runsc exposes an overhead-inclusive virtual sandbox cgroup rather than
      // the Pod container's literal OCI values. On KVM it currently adds 32 MiB
      // and a small CPU allowance for Sentry. The Kubernetes Pod contract is
      // checked above; keep this guest-side check bounded instead of relying on
      // those implementation-specific overhead constants.
      const guestMemoryBytes = Number(/memory=(\d+)/.exec(cgroups)?.[1]);
      expect(guestMemoryBytes).toBeGreaterThanOrEqual(768 * 1_024 * 1_024);
      expect(guestMemoryBytes).toBeLessThanOrEqual(832 * 1_024 * 1_024);
      // runsc's virtual cgroup currently reports pids.max=max. The matching
      // RLIMIT_NPROC behavior is exercised by the process probe below.
      expect(cgroups).toContain("pids=max");
      const guestCpu = /cpu=(\d+)\s+(\d+)/.exec(cgroups);
      expect(Number(guestCpu?.[1])).toBeGreaterThanOrEqual(100_000);
      expect(Number(guestCpu?.[1])).toBeLessThanOrEqual(110_000);
      expect(Number(guestCpu?.[2])).toBe(100_000);
      const workspaceBytes = Number(/workspace=\s*(\d+)/.exec(cgroups)?.[1]);
      expect(workspaceBytes).toBeGreaterThan(0);
      expect(workspaceBytes).toBeLessThanOrEqual(128 * 1_024 * 1_024);

      const processProbe = JSON.parse(
        bashOutput(
          await manager.execute(
            first.capability,
            operation(
              first.activationId,
              "50000000-0000-4000-8000-000000000012",
              `node -e 'const{spawn}=require("node:child_process");let started=0,failed=0;for(let i=0;i<256;i++){const child=spawn("sleep",["1"]);child.once("spawn",()=>started++);child.once("error",()=>failed++)}setTimeout(()=>console.log(JSON.stringify({started,failed})),1500)'`,
              10_000,
            ),
          ),
        ),
      ) as { started: number; failed: number };
      expect(processProbe.started).toBeLessThan(128);
      expect(processProbe.failed).toBeGreaterThan(0);

      const networkProbe = bashOutput(
        await manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000003",
            `node -e 'const net=require("node:net");const t=[["control-plane",4100],["postgres",5432],["minio",9000],["sandbox-manager",4300],["host.docker.internal",80],["1.1.1.1",443]];Promise.all(t.map(([host,port])=>new Promise(resolve=>{const s=net.connect({host,port});let done=false;const finish=value=>{if(done)return;done=true;s.destroy();resolve(value)};s.setTimeout(300,()=>finish("blocked"));s.once("error",()=>finish("blocked"));s.once("connect",()=>finish("reachable"))}))).then(values=>{console.log(JSON.stringify(values));process.exit(values.includes("reachable")?2:0)})'`,
            5_000,
          ),
        ),
      );
      expect(networkProbe).not.toContain("reachable");

      await expect(
        manager.execute(second.capability, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: second.activationId,
          operationId: "50000000-0000-4000-8000-000000000004",
          operation: "file.write",
          path: "tenant-private.txt",
          content: "second tenant only",
        }),
      ).resolves.toMatchObject({ operation: "file.write" });
      await expect(
        manager.execute(first.capability, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: first.activationId,
          operationId: "50000000-0000-4000-8000-000000000005",
          operation: "file.read",
          path: "tenant-private.txt",
        }),
      ).resolves.toMatchObject({
        type: "tool_sandbox.operation_failed",
        code: "tool_file_unavailable",
      });

      await manager.execute(
        first.capability,
        operation(
          first.activationId,
          "50000000-0000-4000-8000-000000000006",
          "ln -s /etc/passwd escaped-link",
        ),
      );
      await expect(
        manager.execute(first.capability, {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId: first.activationId,
          operationId: "50000000-0000-4000-8000-000000000007",
          operation: "file.read",
          path: "escaped-link",
        }),
      ).resolves.toMatchObject({
        type: "tool_sandbox.operation_failed",
        code: "tool_symlink_rejected",
      });

      await expect(
        manager.execute(
          first.capability,
          operation(
            first.activationId,
            "50000000-0000-4000-8000-000000000008",
            `node -e 'process.stdout.write("x".repeat(1100000))'`,
            10_000,
          ),
        ),
      ).resolves.toMatchObject({
        type: "tool_sandbox.operation_failed",
        code: "tool_output_limit",
      });

      const longOperation = manager.execute(
        second.capability,
        operation(
          second.activationId,
          "50000000-0000-4000-8000-000000000009",
          "sleep 300 & wait",
          300_000,
        ),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      await manager.stop(second.activationId, secondAssignment);
      const cancellation = await Promise.allSettled([longOperation]);
      expect(
        cancellation[0]?.status === "rejected" ||
          (cancellation[0]?.status === "fulfilled" &&
            cancellation[0].value.type === "tool_sandbox.operation_failed" &&
            cancellation[0].value.code === "tool_cancelled"),
      ).toBe(true);
      expect(
        await runtimeClient.readPod(
          "agent-dock-sandboxes",
          `agent-dock-tool-${second.activationId}`.slice(0, 63),
        ),
      ).toBeUndefined();
      second = undefined;

      await manager.stop(first.activationId, firstAssignment);
      expect(
        await runtimeClient.readPod(
          "agent-dock-sandboxes",
          `agent-dock-tool-${first.activationId}`.slice(0, 63),
        ),
      ).toBeUndefined();
      first = undefined;

      empty = await manager.create({
        ...createRequest(3),
        workspaceSeed: {
          kind: "snapshot",
          snapshot: encodeWorkspaceSnapshotBlob(createWorkspaceSnapshot([])),
        },
      });
      expect(
        bashOutput(
          await manager.execute(
            empty.capability,
            operation(
              empty.activationId,
              "50000000-0000-4000-8000-000000000010",
              "git status --short; git log -1 --format=%s",
            ),
          ),
        ),
      ).toBe("fixture baseline\n");
      await manager.stop(empty.activationId, emptyAssignment);
      expect(
        await runtimeClient.readPod(
          "agent-dock-sandboxes",
          `agent-dock-tool-${empty.activationId}`.slice(0, 63),
        ),
      ).toBeUndefined();
      empty = undefined;

      const invalidSnapshot = Buffer.from('{"format":"invalid","files":[]}\n', "utf8");
      invalid = await manager.create({
        ...createRequest(4),
        workspaceSeed: {
          kind: "snapshot",
          snapshot: {
            encoding: "base64",
            sha256: createHash("sha256").update(invalidSnapshot).digest("hex"),
            sizeBytes: invalidSnapshot.byteLength,
            data: invalidSnapshot.toString("base64"),
          },
        },
      });
      await expect(manager.inspect(invalid.activationId, assignment(4))).rejects.toMatchObject({
        code: "tool_worker_failed",
      });
      await expect(provider.listAssignments(firstAssignment.sandboxId)).resolves.toEqual([]);
    } finally {
      if (invalid !== undefined) {
        await manager.stop(invalid.activationId, assignment(4)).catch(() => undefined);
      }
      if (empty !== undefined) {
        await manager.stop(empty.activationId, emptyAssignment).catch(() => undefined);
      }
      if (second !== undefined) {
        await manager.stop(second.activationId, secondAssignment).catch(() => undefined);
      }
      if (first !== undefined) {
        await manager.stop(first.activationId, firstAssignment).catch(() => undefined);
      }
      await manager.close().catch(() => undefined);
    }
  }, 120_000);

  it("rebinds one exact-session warm Pod to a higher fenced attempt", async () => {
    const runtimeClient = new OfficialKubernetesRuntimeClient(kubeconfigPath);
    const provider = new KubernetesGvisorSandboxProvider({ toolImage, runtimeClient });
    const manager = new ToolSandboxManager({ provider, imageRevision });
    const firstAssignment = assignment(10);
    let currentAssignment = firstAssignment;
    let activationId: string | undefined;
    try {
      const first = await manager.create({
        ...createRequest(10),
        assignment: firstAssignment,
      });
      activationId = first.activationId;
      await manager.execute(
        first.capability,
        operation(
          first.activationId,
          "50000000-0000-4000-8000-000000000101",
          "printf warm-reuse > warm-reuse.txt",
        ),
      );
      const captured = await manager.capture(
        first.activationId,
        firstAssignment,
        "50000000-0000-4000-8000-000000000102",
      );
      if (captured.type !== "tool_sandbox.captured") {
        throw new Error("Expected a materialized Tool Sandbox capture");
      }
      const podName = `agent-dock-tool-${first.activationId}`.slice(0, 63);
      const originalPod = await runtimeClient.readPod("agent-dock-sandboxes", podName);
      const originalUid = originalPod?.metadata?.uid;
      expect(originalUid).toBeDefined();
      await manager.release({
        managerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "50000000-0000-4000-8000-000000000103",
        activationId: first.activationId,
        assignment: firstAssignment,
        disposition: "keep_warm",
        workspaceRevision: captured.workspace.sha256,
      });

      currentAssignment = {
        ...firstAssignment,
        commandId: "command-provider-rebound",
        turnId: "turn-provider-rebound",
        attemptId: "50000000-0000-4000-8000-000000000104",
        leaseId: "50000000-0000-4000-8000-000000000104",
        fencingToken: firstAssignment.fencingToken + 1,
      };
      const rebound = await manager.create({
        ...createRequest(11),
        assignment: currentAssignment,
        environment: createRequest(10).environment,
        workspaceRevision: captured.workspace.sha256,
      });
      expect(rebound.activationId).toBe(first.activationId);
      expect(
        bashOutput(
          await manager.execute(
            rebound.capability,
            operation(
              rebound.activationId,
              "50000000-0000-4000-8000-000000000105",
              "cat warm-reuse.txt",
            ),
          ),
        ),
      ).toBe("warm-reuse");
      const reboundPod = await runtimeClient.readPod("agent-dock-sandboxes", podName);
      expect(reboundPod?.metadata?.uid).toBe(originalUid);
      expect(reboundPod?.metadata?.annotations).toMatchObject({
        "agent-dock.io/turn-id": currentAssignment.turnId,
        "agent-dock.io/attempt-id": currentAssignment.attemptId,
        "agent-dock.io/fencing-token": String(currentAssignment.fencingToken),
      });
      const reboundCapture = await manager.capture(
        rebound.activationId,
        currentAssignment,
        "50000000-0000-4000-8000-000000000106",
      );
      if (reboundCapture.type !== "tool_sandbox.captured") {
        throw new Error("Expected a rebound Tool Sandbox capture");
      }
      await manager.release({
        managerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "50000000-0000-4000-8000-000000000107",
        activationId: rebound.activationId,
        assignment: currentAssignment,
        disposition: "keep_warm",
        workspaceRevision: reboundCapture.workspace.sha256,
      });
      const inventory = await provider.listAssignments(currentAssignment.sandboxId);
      expect(inventory).toEqual([
        {
          containerId: originalUid,
          containerName: podName,
          supervisorId: currentAssignment.supervisorId,
          bootId: currentAssignment.bootId,
          sandboxId: currentAssignment.sandboxId,
          commandId: currentAssignment.commandId,
          sessionId: currentAssignment.sessionId,
          turnId: currentAssignment.turnId,
          leaseId: currentAssignment.leaseId,
          fencingToken: currentAssignment.fencingToken,
        },
      ]);
      await manager.terminateAndConfirmAbsent(inventory[0]!);
      activationId = undefined;
      await expect(runtimeClient.readPod("agent-dock-sandboxes", podName)).resolves.toBeUndefined();
    } finally {
      if (activationId !== undefined) {
        await manager.stop(activationId, currentAssignment).catch(() => undefined);
      }
      await manager.close().catch(() => undefined);
    }
  }, 120_000);
});
