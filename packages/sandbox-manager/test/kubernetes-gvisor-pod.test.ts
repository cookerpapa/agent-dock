import type { ToolSandboxAssignment } from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_SANDBOX_POLICY,
  KUBERNETES_SANDBOX_ANNOTATIONS,
  KUBERNETES_SANDBOX_LABELS,
  buildKubernetesCleanPrewarmPod,
  buildKubernetesRepositoryImportPod,
  buildKubernetesToolSandboxPod,
  type SandboxPolicy,
} from "../src/index.ts";

const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-security-test",
  projectId: "project-security-test",
  workspaceId: "workspace-security-test",
  supervisorId: "supervisor-security-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-security-test",
  sessionId: "session-security-test",
  turnId: "turn-security-test",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000003",
  fencingToken: 7,
};
const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000006",
  versionNumber: 1,
  profileKey: "agent-dock-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

describe("Kubernetes gVisor Pod boundary", () => {
  it("builds a tenant-free, never-networked clean prewarm Pod", () => {
    const pod = buildKubernetesCleanPrewarmPod({
      image: "agent-dock/tool-sandbox:test",
      imageRevision: "revision-test",
      name: "agent-dock-prewarm-security-test",
      namespace: "agent-dock-sandboxes",
      prewarmId: "10000000-0000-4000-8000-000000000009",
      ttlMs: 300_000,
    });
    expect(pod.metadata?.labels).toEqual({
      [KUBERNETES_SANDBOX_LABELS.managed]: "true",
      [KUBERNETES_SANDBOX_LABELS.workload]: "clean-prewarm",
    });
    expect(pod.metadata?.annotations).toMatchObject({
      [KUBERNETES_SANDBOX_ANNOTATIONS.prewarmId]: "10000000-0000-4000-8000-000000000009",
      [KUBERNETES_SANDBOX_ANNOTATIONS.environmentImageRevision]: "revision-test",
    });
    expect(JSON.stringify(pod.metadata)).not.toMatch(
      /tenant|project|workspace|session|attempt|lease|sandbox-hash/i,
    );
    expect(pod.spec).toMatchObject({
      runtimeClassName: "agent-dock-gvisor",
      automountServiceAccountToken: false,
      dnsPolicy: "None",
      hostNetwork: false,
      hostPID: false,
      activeDeadlineSeconds: 1_200,
    });
    expect(pod.spec?.containers[0]?.env).toEqual([]);
  });

  it("builds an offline, fixed-image, unprivileged and host-mount-free Tool Pod", () => {
    const pod = buildKubernetesToolSandboxPod({
      image: "agent-dock/tool-sandbox:test",
      name: "agent-dock-tool-security-test",
      namespace: "agent-dock-sandboxes",
      activationId: "10000000-0000-4000-8000-000000000004",
      assignment,
      environment,
    });
    const spec = pod.spec!;
    const container = spec.containers[0]!;
    expect(spec.runtimeClassName).toBe("agent-dock-gvisor");
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.serviceAccountName).toBe("untrusted-tool");
    expect(spec.hostNetwork).toBe(false);
    expect(spec.hostPID).toBe(false);
    expect(spec.hostIPC).toBe(false);
    expect(spec.dnsPolicy).toBe("None");
    expect(spec.restartPolicy).toBe("Never");
    expect(container.imagePullPolicy).toBe("Never");
    expect(container.env).toEqual([]);
    expect(container.stdin).toBe(true);
    expect(container.securityContext).toMatchObject({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.args?.[0]).toContain("ulimit -u 128");
    expect(container.args?.[0]).toContain("ulimit -n 1024");
    expect(container.args?.[0]).not.toContain("AGENT_DOCK_TOOL_IMAGE_REVISION");
    expect(container.resources?.limits).toMatchObject({
      cpu: "1000000000n",
      memory: String(768 * 1024 * 1024),
    });
    expect(spec.volumes).toHaveLength(2);
    expect(spec.volumes?.every((volume) => volume.emptyDir?.medium === "Memory")).toBe(true);
    expect(spec.volumes?.some((volume) => volume.hostPath !== undefined)).toBe(false);
    expect(container.volumeMounts?.some((mount) => mount.mountPath.includes("docker.sock"))).toBe(
      false,
    );
    expect(pod.metadata?.labels).toMatchObject({
      [KUBERNETES_SANDBOX_LABELS.managed]: "true",
      [KUBERNETES_SANDBOX_LABELS.workload]: "tool-sandbox",
    });
    expect(pod.metadata?.annotations).toMatchObject({
      [KUBERNETES_SANDBOX_ANNOTATIONS.tenantId]: assignment.tenantId,
      [KUBERNETES_SANDBOX_ANNOTATIONS.attemptId]: assignment.attemptId,
      [KUBERNETES_SANDBOX_ANNOTATIONS.processLimit]: "128",
    });
    expect(JSON.stringify(pod)).not.toMatch(/admg_|adts_|DATABASE_URL|AWS_|docker\.sock/i);
  });

  it("fails closed instead of attaching a Tool Pod to an egress policy", () => {
    const unsupported = {
      ...DEFAULT_TOOL_SANDBOX_POLICY,
      network: { mode: "github" },
    } as SandboxPolicy;
    expect(() =>
      buildKubernetesToolSandboxPod({
        image: "agent-dock/tool-sandbox:test",
        name: "agent-dock-tool-security-test",
        namespace: "agent-dock-sandboxes",
        activationId: "10000000-0000-4000-8000-000000000004",
        assignment,
        environment,
        policy: unsupported,
      }),
    ).toThrow("does not support");
  });

  it("labels only a dependency bootstrap Pod for the narrow proxy policy", () => {
    const dependencyEnvironment = {
      ...environment,
      recipe: {
        schemaVersion: 1 as const,
        dependencyHosts: ["registry.npmjs.org"],
        setupCommands: [
          {
            id: "install",
            command: "npm install",
            cwd: ".",
            timeoutMs: 120_000,
            network: "dependency" as const,
          },
        ],
        verificationCommands: environment.recipe.verificationCommands,
      },
    };
    const pod = buildKubernetesToolSandboxPod({
      image: "agent-dock/tool-sandbox:test",
      name: "agent-dock-tool-dependency-test",
      namespace: "agent-dock-sandboxes",
      activationId: "10000000-0000-4000-8000-000000000007",
      assignment,
      dependencyEgress: true,
      workload: "dependency-bootstrap",
      environment: dependencyEnvironment,
    });
    expect(pod.metadata?.labels).toMatchObject({
      [KUBERNETES_SANDBOX_LABELS.dependencyEgress]: "true",
      [KUBERNETES_SANDBOX_LABELS.workload]: "dependency-bootstrap",
    });
    expect(pod.spec?.dnsPolicy).toBe("None");
    expect(pod.spec?.containers[0]?.env).toEqual([]);
    expect(JSON.stringify(pod)).not.toMatch(/adpc1_|Proxy-Authorization|PRIVATE KEY/);
    const offline = buildKubernetesToolSandboxPod({
      image: "agent-dock/tool-sandbox:test",
      name: "agent-dock-tool-offline-restore",
      namespace: "agent-dock-sandboxes",
      activationId: "10000000-0000-4000-8000-000000000008",
      assignment,
      environment: dependencyEnvironment,
    });
    expect(offline.metadata?.labels?.[KUBERNETES_SANDBOX_LABELS.dependencyEgress]).toBeUndefined();
    expect(offline.metadata?.labels?.[KUBERNETES_SANDBOX_LABELS.workload]).toBe("tool-sandbox");
  });

  it("builds a bounded public-repository importer with no platform authority", () => {
    const pod = buildKubernetesRepositoryImportPod({
      image: "agent-dock/tool-sandbox:test",
      name: "agent-dock-import-security-test",
      namespace: "agent-dock-importers",
      importId: "10000000-0000-4000-8000-000000000005",
    });
    const spec = pod.spec!;
    const container = spec.containers[0]!;
    expect(spec.runtimeClassName).toBe("agent-dock-gvisor");
    expect(spec.serviceAccountName).toBe("repository-importer");
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.hostNetwork).toBe(false);
    expect(container.env).toEqual([]);
    expect(container.securityContext).toMatchObject({
      runAsUser: 1000,
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.args?.[0]).toContain("ulimit -u 96");
    expect(spec.volumes?.some((volume) => volume.hostPath !== undefined)).toBe(false);
    expect(container.env).toEqual([]);
    expect(JSON.stringify(container)).not.toMatch(/secret|credential|docker\.sock/i);
  });
});
