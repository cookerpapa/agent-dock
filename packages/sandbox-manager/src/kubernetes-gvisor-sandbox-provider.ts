import {
  dependencyEgressPublicKeyFingerprint,
  dependencyEgressPublicKeyPem,
  mintDependencyEgressCapability,
} from "@agent-dock/dependency-egress-proxy";
import {
  isExpectedDefaultToolchain,
  parseGitHubWorkspaceImportOutput,
  parseToolWorkerOutput,
  type GitHubRepositorySource,
  type GitHubWorkspaceImportRequest,
  type EnvironmentRuntimeSnapshot,
  type EnvironmentToolchainReport,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWorkerOutput,
  type DependencyProxyBootstrap,
  type ToolWorkerEnvironmentStage,
} from "@agent-dock/protocol";
import { decodeWorkspaceSnapshotBlob } from "@agent-dock/workspace-runtime";
import type { V1Container, V1NetworkPolicy, V1Pod, V1Status } from "@kubernetes/client-node";
import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "isomorphic-ws";
import {
  OfficialKubernetesRuntimeClient,
  type KubernetesImagePullPolicy,
  type KubernetesRuntimeClient,
} from "./kubernetes-runtime-client.ts";
import {
  DEFAULT_TOOL_SANDBOX_POLICY,
  SandboxManagerError,
  type SandboxCreateSpec,
  type SandboxEffectiveIsolation,
  type SandboxHandle,
  type SandboxInspection,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxReadFileInput,
  type SandboxWriteFileInput,
} from "./sandbox-provider.ts";

const MAX_WORKER_STDOUT_BYTES = 8 * 1_024 * 1_024;
const MAX_WORKER_STDERR_BYTES = 4_096;
const MAX_IMPORT_STDOUT_BYTES = 3 * 1_024 * 1_024;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_GRACE_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const DEPENDENCY_TRUST_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
const TOOL_CONTAINER_NAME = "workspace";
const IMPORT_CONTAINER_NAME = "repository-importer";
const PROBE_CONTAINER_NAME = "runtime-probe";
const GVISOR_KERNEL_PATTERN = /(?:^|[-_.])gvisor(?:$|[-_.])/i;

export const KUBERNETES_GVISOR_RUNTIME_NAME = "runsc" as const;

export const KUBERNETES_SANDBOX_LABELS = {
  managed: "agent-dock.io/managed",
  workload: "agent-dock.io/workload",
  sandboxHash: "agent-dock.io/sandbox-hash",
  dependencyEgress: "agent-dock.io/dependency-egress",
} as const;

export const KUBERNETES_SANDBOX_ANNOTATIONS = {
  activationId: "agent-dock.io/activation-id",
  tenantId: "agent-dock.io/tenant-id",
  projectId: "agent-dock.io/project-id",
  workspaceId: "agent-dock.io/workspace-id",
  supervisorId: "agent-dock.io/supervisor-id",
  bootId: "agent-dock.io/boot-id",
  sandboxId: "agent-dock.io/sandbox-id",
  commandId: "agent-dock.io/command-id",
  sessionId: "agent-dock.io/session-id",
  turnId: "agent-dock.io/turn-id",
  attemptId: "agent-dock.io/attempt-id",
  leaseId: "agent-dock.io/lease-id",
  fencingToken: "agent-dock.io/fencing-token",
  processLimit: "agent-dock.io/process-limit",
  openFilesLimit: "agent-dock.io/open-files-limit",
  memoryBytes: "agent-dock.io/memory-bytes",
  cpuNano: "agent-dock.io/cpu-nano",
  policyVersion: "agent-dock.io/policy-version",
  environmentVersionId: "agent-dock.io/environment-version-id",
  environmentVersionNumber: "agent-dock.io/environment-version-number",
  environmentProfile: "agent-dock.io/environment-profile",
  environmentImageRevision: "agent-dock.io/environment-image-revision",
  environmentSpecSha256: "agent-dock.io/environment-spec-sha256",
  environmentRecipeSha256: "agent-dock.io/environment-recipe-sha256",
  importId: "agent-dock.io/import-id",
} as const;

export type KubernetesGvisorSandboxProviderOptions = {
  toolImage: string;
  kubeconfigPath?: string;
  sandboxNamespace?: string;
  importerNamespace?: string;
  runtimeClassName?: string;
  toolServiceAccountName?: string;
  importerServiceAccountName?: string;
  imagePullPolicy?: KubernetesImagePullPolicy;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  repositoryImportTimeoutMs?: number;
  dependencyEgress?: {
    privateKeyPem: string;
    namespace?: string;
    configMapName?: string;
    serviceName?: string;
    servicePort?: number;
    capabilityTtlMs?: number;
  };
  idGenerator?: () => string;
  runtimeClient?: KubernetesRuntimeClient;
};

type DependencyEgressRuntime = Readonly<{
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  namespace: string;
  configMapName: string;
  serviceName: string;
  servicePort: number;
  capabilityTtlMs: number;
}>;

type PhysicalSandboxCreateOptions = Readonly<{
  activationId: string;
  dependencyEgress: boolean;
  dependencyProxy?: DependencyProxyBootstrap;
  environmentStage?: ToolWorkerEnvironmentStage;
}>;

type ToolSandboxWorkload = "tool-sandbox" | "dependency-bootstrap";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

type ManagedPodRuntime = SupervisorRuntimeAssignment & {
  activationId: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  attemptId: string;
};

type Activation = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  workload: ToolSandboxWorkload;
  runtimeName: string;
  runtimeId: string;
  handle?: SandboxHandle;
  stdin: PassThrough;
  stdout: PassThrough;
  stderrStream: PassThrough;
  connection?: WebSocket;
  closed: Deferred<void>;
  ready: Deferred<EnvironmentToolchainReport>;
  operations: Map<string, Deferred<ToolSandboxOperationResponse>>;
  captures: Map<string, Deferred<ToolSandboxCaptureResponse>>;
  seenOperationIds: Set<string>;
  stdoutBuffer: Buffer;
  stderr: string;
  failed?: Error;
  stopping: boolean;
};

export type KubernetesToolPodOptions = {
  image: string;
  name: string;
  namespace: string;
  activationId: string;
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  dependencyEgress?: boolean;
  workload?: ToolSandboxWorkload;
  policy?: SandboxPolicy;
  runtimeClassName?: string;
  serviceAccountName?: string;
  imagePullPolicy?: KubernetesImagePullPolicy;
};

export type KubernetesRepositoryImportPodOptions = {
  image: string;
  name: string;
  namespace: string;
  importId: string;
  runtimeClassName?: string;
  serviceAccountName?: string;
  imagePullPolicy?: KubernetesImagePullPolicy;
  timeoutMs?: number;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 1_024): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function kubernetesName(value: string, name: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new TypeError(`${name} is not a valid Kubernetes DNS label`);
  }
  return value;
}

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} is not a valid UUID`);
  }
  return value.toLowerCase();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new SandboxManagerError("sandbox_timeout", `${label} timed out`, true));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function sameAssignment(left: ToolSandboxAssignment, right: ToolSandboxAssignment): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.commandId === right.commandId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.fencingToken === right.fencingToken
  );
}

function assignmentMatchesRuntime(
  assignment: ToolSandboxAssignment,
  runtime: SupervisorRuntimeAssignment,
): boolean {
  return (
    assignment.supervisorId === runtime.supervisorId &&
    assignment.bootId === runtime.bootId &&
    assignment.sandboxId === runtime.sandboxId &&
    assignment.commandId === runtime.commandId &&
    assignment.sessionId === runtime.sessionId &&
    assignment.turnId === runtime.turnId &&
    assignment.leaseId === runtime.leaseId &&
    assignment.fencingToken === runtime.fencingToken
  );
}

function sameRuntimeAssignment(
  left: SupervisorRuntimeAssignment,
  right: SupervisorRuntimeAssignment,
): boolean {
  return (
    left.containerId === right.containerId &&
    left.containerName === right.containerName &&
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.commandId === right.commandId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.leaseId === right.leaseId &&
    left.fencingToken === right.fencingToken
  );
}

function runtimeName(activationId: string): string {
  return `agent-dock-tool-${activationId}`.slice(0, 63);
}

function sandboxHash(sandboxId: string): string {
  return createHash("sha256").update(sandboxId).digest("hex").slice(0, 32);
}

function assignmentAnnotations(
  activationId: string,
  assignment: ToolSandboxAssignment,
  policy: SandboxPolicy,
  environment?: EnvironmentRuntimeSnapshot,
): Record<string, string> {
  for (const [field, value] of Object.entries(assignment)) {
    if (field !== "fencingToken") bounded(String(value), `Tool Sandbox assignment ${field}`, 512);
  }
  return {
    [KUBERNETES_SANDBOX_ANNOTATIONS.activationId]: activationId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.tenantId]: assignment.tenantId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.projectId]: assignment.projectId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.workspaceId]: assignment.workspaceId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.supervisorId]: assignment.supervisorId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.bootId]: assignment.bootId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.sandboxId]: assignment.sandboxId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.commandId]: assignment.commandId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.sessionId]: assignment.sessionId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.turnId]: assignment.turnId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.attemptId]: assignment.attemptId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.leaseId]: assignment.leaseId,
    [KUBERNETES_SANDBOX_ANNOTATIONS.fencingToken]: String(assignment.fencingToken),
    [KUBERNETES_SANDBOX_ANNOTATIONS.processLimit]: String(policy.resources.pids),
    [KUBERNETES_SANDBOX_ANNOTATIONS.openFilesLimit]: String(policy.resources.openFiles),
    [KUBERNETES_SANDBOX_ANNOTATIONS.memoryBytes]: String(policy.resources.memoryBytes),
    [KUBERNETES_SANDBOX_ANNOTATIONS.cpuNano]: String(policy.resources.cpuNano),
    [KUBERNETES_SANDBOX_ANNOTATIONS.policyVersion]: String(policy.policyVersion),
    ...(environment === undefined
      ? {}
      : {
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentVersionId]: environment.environmentVersionId,
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentVersionNumber]: String(
            environment.versionNumber,
          ),
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentProfile]: `${environment.profileKey}:${environment.profileVersion}`,
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentImageRevision]: environment.imageRevision,
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentSpecSha256]: environment.specSha256,
          [KUBERNETES_SANDBOX_ANNOTATIONS.environmentRecipeSha256]: environment.recipeSha256,
        }),
  };
}

function assertSupportedPolicy(policy: SandboxPolicy): void {
  if (
    policy.policyVersion !== 1 ||
    policy.network.mode !== "deny_all" ||
    policy.user !== "1000:1000" ||
    !policy.readOnlyRootFilesystem ||
    policy.privileged ||
    !policy.dropAllCapabilities ||
    !policy.noNewPrivileges ||
    policy.allowHostMounts ||
    policy.allowDockerSocket
  ) {
    throw new SandboxManagerError(
      "unsupported_sandbox_policy",
      "Kubernetes gVisor Sandbox Provider does not support the requested policy",
      false,
    );
  }
  for (const [name, value] of Object.entries(policy.resources)) {
    positiveInteger(value, `Sandbox resource limit ${name}`);
  }
}

function restrictedSecurityContext(): NonNullable<V1Container["securityContext"]> {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsGroup: 1_000,
    runAsNonRoot: true,
    runAsUser: 1_000,
    seccompProfile: { type: "RuntimeDefault" },
  };
}

function fixedWorkerCommand(policy: SandboxPolicy): { command: string[]; args: string[] } {
  return {
    command: ["/bin/bash", "--noprofile", "--norc", "-lc"],
    args: [
      `umask 077; ulimit -u ${String(policy.resources.pids)}; ulimit -n ${String(policy.resources.openFiles)}; exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp/agent-dock-tool-home LANG=C.UTF-8 LC_ALL=C.UTF-8 node /app/packages/tool-sandbox/src/tool-worker.ts`,
    ],
  };
}

export function buildKubernetesToolSandboxPod(options: KubernetesToolPodOptions): V1Pod {
  const policy = options.policy ?? DEFAULT_TOOL_SANDBOX_POLICY;
  assertSupportedPolicy(policy);
  const image = bounded(options.image, "Tool Sandbox image", 512);
  const name = kubernetesName(options.name, "Tool Sandbox Pod name");
  const namespace = kubernetesName(options.namespace, "Tool Sandbox namespace");
  const activationId = uuid(options.activationId, "Tool Sandbox activation ID");
  const runtimeClassName = kubernetesName(
    options.runtimeClassName ?? "agent-dock-gvisor",
    "Tool Sandbox RuntimeClass",
  );
  const serviceAccountName = kubernetesName(
    options.serviceAccountName ?? "untrusted-tool",
    "Tool Sandbox ServiceAccount",
  );
  const workload = options.workload ?? "tool-sandbox";
  const worker = fixedWorkerCommand(policy);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: {
        [KUBERNETES_SANDBOX_LABELS.managed]: "true",
        [KUBERNETES_SANDBOX_LABELS.workload]: workload,
        [KUBERNETES_SANDBOX_LABELS.sandboxHash]: sandboxHash(options.assignment.sandboxId),
        ...(options.dependencyEgress !== true
          ? {}
          : { [KUBERNETES_SANDBOX_LABELS.dependencyEgress]: "true" }),
      },
      annotations: assignmentAnnotations(
        activationId,
        options.assignment,
        policy,
        options.environment,
      ),
    },
    spec: {
      activeDeadlineSeconds: Math.ceil(policy.resources.turnWallClockTimeoutMs / 1_000),
      automountServiceAccountToken: false,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      restartPolicy: "Never",
      runtimeClassName,
      serviceAccountName,
      shareProcessNamespace: false,
      terminationGracePeriodSeconds: 5,
      securityContext: {
        fsGroup: 1_000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1_000,
        runAsNonRoot: true,
        runAsUser: 1_000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: TOOL_CONTAINER_NAME,
          image,
          imagePullPolicy: options.imagePullPolicy ?? "Never",
          command: worker.command,
          args: worker.args,
          env: [],
          stdin: true,
          stdinOnce: false,
          tty: false,
          workingDir: "/workspace",
          securityContext: restrictedSecurityContext(),
          resources: {
            requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "16Mi" },
            limits: {
              cpu: `${String(policy.resources.cpuNano)}n`,
              memory: String(policy.resources.memoryBytes),
              "ephemeral-storage": String(
                policy.resources.workspaceBytes + policy.resources.temporaryBytes,
              ),
            },
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            { name: "temporary", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        {
          name: "workspace",
          emptyDir: { medium: "Memory", sizeLimit: String(policy.resources.workspaceBytes) },
        },
        {
          name: "temporary",
          emptyDir: { medium: "Memory", sizeLimit: String(policy.resources.temporaryBytes) },
        },
      ],
    },
  };
}

export function buildKubernetesRepositoryImportPod(
  options: KubernetesRepositoryImportPodOptions,
): V1Pod {
  const name = kubernetesName(options.name, "Repository importer Pod name");
  const namespace = kubernetesName(options.namespace, "Repository importer namespace");
  const importId = uuid(options.importId, "Repository import ID");
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: {
        [KUBERNETES_SANDBOX_LABELS.managed]: "true",
        [KUBERNETES_SANDBOX_LABELS.workload]: "repository-importer",
      },
      annotations: { [KUBERNETES_SANDBOX_ANNOTATIONS.importId]: importId },
    },
    spec: {
      activeDeadlineSeconds: Math.ceil((options.timeoutMs ?? 180_000) / 1_000),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      restartPolicy: "Never",
      runtimeClassName: options.runtimeClassName ?? "agent-dock-gvisor",
      serviceAccountName: options.serviceAccountName ?? "repository-importer",
      shareProcessNamespace: false,
      terminationGracePeriodSeconds: 5,
      securityContext: {
        fsGroup: 1_000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1_000,
        runAsNonRoot: true,
        runAsUser: 1_000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: IMPORT_CONTAINER_NAME,
          image: bounded(options.image, "Repository importer image", 512),
          imagePullPolicy: options.imagePullPolicy ?? "Never",
          command: ["/bin/bash", "--noprofile", "--norc", "-lc"],
          args: [
            "umask 077; ulimit -u 96; ulimit -n 512; exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp/agent-dock-import-home LANG=C.UTF-8 LC_ALL=C.UTF-8 node /app/packages/tool-sandbox/src/github-import-worker.ts",
          ],
          env: [],
          stdin: true,
          stdinOnce: false,
          tty: false,
          workingDir: "/workspace",
          securityContext: restrictedSecurityContext(),
          resources: {
            requests: { cpu: "100m", memory: "96Mi", "ephemeral-storage": "16Mi" },
            limits: { cpu: "750m", memory: "384Mi", "ephemeral-storage": "80Mi" },
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            { name: "temporary", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "workspace", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
        { name: "temporary", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
      ],
    },
  };
}

function buildRuntimeProbePod(
  image: string,
  name: string,
  namespace: string,
  probeId: string,
  runtimeClassName: string,
  serviceAccountName: string,
  imagePullPolicy: KubernetesImagePullPolicy,
): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: {
        [KUBERNETES_SANDBOX_LABELS.managed]: "true",
        [KUBERNETES_SANDBOX_LABELS.workload]: "runtime-probe",
      },
      annotations: { [KUBERNETES_SANDBOX_ANNOTATIONS.activationId]: probeId },
    },
    spec: {
      activeDeadlineSeconds: 30,
      automountServiceAccountToken: false,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      restartPolicy: "Never",
      runtimeClassName,
      serviceAccountName,
      terminationGracePeriodSeconds: 0,
      securityContext: {
        runAsGroup: 1_000,
        runAsNonRoot: true,
        runAsUser: 1_000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: PROBE_CONTAINER_NAME,
          image,
          imagePullPolicy,
          command: ["/bin/sh", "-c", "uname -r"],
          env: [],
          securityContext: restrictedSecurityContext(),
          resources: {
            requests: { cpu: "10m", memory: "16Mi" },
            limits: { cpu: "250m", memory: "128Mi", "ephemeral-storage": "16Mi" },
          },
        },
      ],
    },
  };
}

function sendLine(activation: Activation, message: unknown): Promise<void> {
  if (activation.stdin.destroyed || !activation.stdin.writable) {
    return Promise.reject(
      new SandboxManagerError(
        "tool_sandbox_unavailable",
        "Tool Sandbox input is unavailable",
        true,
      ),
    );
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    activation.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        rejectPromise(
          new SandboxManagerError(
            "tool_sandbox_connection_failed",
            "Tool Sandbox input connection failed",
            true,
          ),
        );
      } else {
        resolvePromise();
      }
    });
  });
}

function requiredAnnotation(annotations: Record<string, string> | undefined, key: string): string {
  const value = annotations?.[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SandboxManagerError(
      "kubernetes_assignment_identity_invalid",
      "Managed Tool Sandbox annotations were invalid",
      false,
    );
  }
  return value;
}

function podToAssignment(pod: V1Pod): ManagedPodRuntime {
  const name = pod.metadata?.name;
  const uidValue = pod.metadata?.uid;
  if (
    typeof name !== "string" ||
    typeof uidValue !== "string" ||
    pod.metadata?.labels?.[KUBERNETES_SANDBOX_LABELS.managed] !== "true"
  ) {
    throw new SandboxManagerError(
      "kubernetes_assignment_identity_invalid",
      "Managed Tool Sandbox identity was invalid",
      false,
    );
  }
  const annotations = pod.metadata.annotations;
  const fencingToken = Number(
    requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.fencingToken),
  );
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new SandboxManagerError(
      "kubernetes_assignment_identity_invalid",
      "Managed Tool Sandbox fence was invalid",
      false,
    );
  }
  return {
    containerId: uidValue,
    containerName: name,
    activationId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.activationId),
    tenantId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.tenantId),
    projectId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.projectId),
    workspaceId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.workspaceId),
    supervisorId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.supervisorId),
    bootId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.bootId),
    sandboxId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.sandboxId),
    commandId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.commandId),
    sessionId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.sessionId),
    turnId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.turnId),
    attemptId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.attemptId),
    leaseId: requiredAnnotation(annotations, KUBERNETES_SANDBOX_ANNOTATIONS.leaseId),
    fencingToken,
  };
}

function supervisorRuntimeAssignment(current: ManagedPodRuntime): SupervisorRuntimeAssignment {
  return {
    containerId: current.containerId,
    containerName: current.containerName,
    supervisorId: current.supervisorId,
    bootId: current.bootId,
    sandboxId: current.sandboxId,
    commandId: current.commandId,
    sessionId: current.sessionId,
    turnId: current.turnId,
    leaseId: current.leaseId,
    fencingToken: current.fencingToken,
  };
}

function networkPolicyIsDefaultDeny(policy: V1NetworkPolicy | undefined): boolean {
  const spec = policy?.spec;
  if (spec === undefined) return false;
  const selector = spec.podSelector?.matchLabels;
  const expressions = spec.podSelector?.matchExpressions;
  const types = spec.policyTypes ?? [];
  return (
    (selector === undefined || Object.keys(selector).length === 0) &&
    (expressions === undefined || expressions.length === 0) &&
    types.includes("Ingress") &&
    types.includes("Egress") &&
    (spec.ingress === undefined || spec.ingress.length === 0) &&
    (spec.egress === undefined || spec.egress.length === 0)
  );
}

function networkPolicyHasVersion(
  policy: V1NetworkPolicy | undefined,
  version: "dependency-egress-v1",
): boolean {
  return policy?.metadata?.annotations?.["agent-dock.io/policy-version"] === version;
}

function toolDependencyEgressPolicyIsBounded(
  policy: V1NetworkPolicy | undefined,
  egressNamespace: string,
  port: number,
): boolean {
  const spec = policy?.spec;
  const rule = spec?.egress?.[0];
  const peer = rule?.to?.[0];
  const selected = spec?.podSelector?.matchLabels;
  return (
    networkPolicyHasVersion(policy, "dependency-egress-v1") &&
    spec?.egress?.length === 1 &&
    spec.policyTypes?.length === 1 &&
    spec.policyTypes[0] === "Egress" &&
    selected?.[KUBERNETES_SANDBOX_LABELS.dependencyEgress] === "true" &&
    rule?.to?.length === 1 &&
    peer?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === egressNamespace &&
    peer.podSelector?.matchLabels?.[KUBERNETES_SANDBOX_LABELS.workload] ===
      "dependency-egress-proxy" &&
    rule.ports?.length === 1 &&
    rule.ports[0]?.protocol === "TCP" &&
    rule.ports[0]?.port === port
  );
}

function proxyIngressPolicyIsBounded(
  policy: V1NetworkPolicy | undefined,
  sandboxNamespace: string,
  port: number,
): boolean {
  const spec = policy?.spec;
  const rule = spec?.ingress?.[0];
  const peer = rule?._from?.[0];
  return (
    networkPolicyHasVersion(policy, "dependency-egress-v1") &&
    spec?.ingress?.length === 1 &&
    spec.policyTypes?.length === 1 &&
    spec.policyTypes[0] === "Ingress" &&
    spec.podSelector?.matchLabels?.[KUBERNETES_SANDBOX_LABELS.workload] ===
      "dependency-egress-proxy" &&
    rule?._from?.length === 1 &&
    peer?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === sandboxNamespace &&
    peer.podSelector?.matchLabels?.[KUBERNETES_SANDBOX_LABELS.dependencyEgress] === "true" &&
    rule.ports?.length === 1 &&
    rule.ports[0]?.protocol === "TCP" &&
    rule.ports[0]?.port === port
  );
}

function proxyPublicEgressPolicyIsBounded(policy: V1NetworkPolicy | undefined): boolean {
  const spec = policy?.spec;
  const rules = spec?.egress;
  const publicRule = rules?.find((rule) =>
    rule.to?.some((peer) => peer.ipBlock?.cidr === "0.0.0.0/0"),
  );
  const publicBlock = publicRule?.to?.find((peer) => peer.ipBlock?.cidr === "0.0.0.0/0")?.ipBlock;
  return (
    networkPolicyHasVersion(policy, "dependency-egress-v1") &&
    spec?.podSelector?.matchLabels?.[KUBERNETES_SANDBOX_LABELS.workload] ===
      "dependency-egress-proxy" &&
    spec.policyTypes?.includes("Egress") === true &&
    (rules?.length ?? 0) === 2 &&
    (publicBlock?.except?.length ?? 0) >= 14 &&
    publicRule?.ports?.length === 1 &&
    publicRule.ports[0]?.protocol === "TCP" &&
    publicRule.ports[0]?.port === 443
  );
}

function statusSucceeded(status: V1Status): boolean {
  return status.status === "Success";
}

function quantityToNumber(value: unknown, kind: "cpu" | "bytes"): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const suffix = match[2] ?? "";
  const multipliers =
    kind === "cpu"
      ? ({ "": 1_000_000_000, m: 1_000_000, u: 1_000, n: 1 } as Record<string, number>)
      : ({
          "": 1,
          k: 1_000,
          K: 1_000,
          M: 1_000_000,
          G: 1_000_000_000,
          T: 1_000_000_000_000,
          Ki: 1_024,
          Mi: 1_024 ** 2,
          Gi: 1_024 ** 3,
          Ti: 1_024 ** 4,
        } as Record<string, number>);
  const multiplier = multipliers[suffix];
  if (multiplier === undefined) return null;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export class KubernetesGvisorSandboxProvider implements SandboxProvider {
  readonly providerId = "kubernetes-gvisor";
  readonly #toolImage: string;
  readonly #sandboxNamespace: string;
  readonly #importerNamespace: string;
  readonly #runtimeClassName: string;
  readonly #toolServiceAccountName: string;
  readonly #importerServiceAccountName: string;
  readonly #imagePullPolicy: KubernetesImagePullPolicy;
  readonly #readyTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #repositoryImportTimeoutMs: number;
  readonly #dependencyEgress: DependencyEgressRuntime | undefined;
  readonly #idGenerator: () => string;
  readonly #client: KubernetesRuntimeClient;
  readonly #activations = new Map<string, Activation>();

  #runtimeProbe: Promise<void> | undefined;
  #dependencyProxyEndpoint: { host: string; port: number } | undefined;

  constructor(options: KubernetesGvisorSandboxProviderOptions) {
    this.#toolImage = bounded(options.toolImage, "Tool Sandbox image", 512);
    this.#sandboxNamespace = kubernetesName(
      options.sandboxNamespace ?? "agent-dock-sandboxes",
      "Tool Sandbox namespace",
    );
    this.#importerNamespace = kubernetesName(
      options.importerNamespace ?? "agent-dock-importers",
      "Repository importer namespace",
    );
    this.#runtimeClassName = kubernetesName(
      options.runtimeClassName ?? "agent-dock-gvisor",
      "Sandbox RuntimeClass",
    );
    this.#toolServiceAccountName = kubernetesName(
      options.toolServiceAccountName ?? "untrusted-tool",
      "Tool Sandbox ServiceAccount",
    );
    this.#importerServiceAccountName = kubernetesName(
      options.importerServiceAccountName ?? "repository-importer",
      "Repository importer ServiceAccount",
    );
    this.#imagePullPolicy = options.imagePullPolicy ?? "Never";
    this.#readyTimeoutMs = positiveInteger(
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs",
      120_000,
    );
    this.#cleanupTimeoutMs = positiveInteger(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
      120_000,
    );
    this.#repositoryImportTimeoutMs = positiveInteger(
      options.repositoryImportTimeoutMs ?? 180_000,
      "repositoryImportTimeoutMs",
      300_000,
    );
    if (options.dependencyEgress !== undefined) {
      const privateKeyPem = options.dependencyEgress.privateKeyPem;
      if (
        privateKeyPem.length < 100 ||
        privateKeyPem.length > 4_096 ||
        !privateKeyPem.includes("BEGIN PRIVATE KEY")
      ) {
        throw new TypeError("Dependency egress issuer private key is invalid");
      }
      const publicKeyPem = dependencyEgressPublicKeyPem(privateKeyPem);
      this.#dependencyEgress = {
        privateKeyPem,
        publicKeyPem,
        publicKeyFingerprint: dependencyEgressPublicKeyFingerprint(publicKeyPem),
        namespace: kubernetesName(
          options.dependencyEgress.namespace ?? "agent-dock-egress",
          "Dependency egress namespace",
        ),
        configMapName: kubernetesName(
          options.dependencyEgress.configMapName ?? "dependency-egress-trust",
          "Dependency egress trust ConfigMap",
        ),
        serviceName: kubernetesName(
          options.dependencyEgress.serviceName ?? "dependency-egress-proxy",
          "Dependency egress Service",
        ),
        servicePort: positiveInteger(
          options.dependencyEgress.servicePort ?? 3_128,
          "Dependency egress Service port",
          65_535,
        ),
        capabilityTtlMs: positiveInteger(
          options.dependencyEgress.capabilityTtlMs ?? 15 * 60_000,
          "Dependency egress capability TTL",
          20 * 60_000,
        ),
      };
      if (this.#dependencyEgress.capabilityTtlMs < 10_000) {
        throw new TypeError("Dependency egress capability TTL is too short");
      }
    }
    this.#idGenerator = options.idGenerator ?? randomUUID;
    if (options.runtimeClient !== undefined) {
      this.#client = options.runtimeClient;
    } else {
      this.#client = new OfficialKubernetesRuntimeClient(
        bounded(options.kubeconfigPath ?? "", "Sandbox Manager kubeconfig path", 4_096),
      );
    }
  }

  async checkHealth(): Promise<void> {
    const [toolPolicy, importerPolicy, runtimeClass] = await Promise.all([
      this.#client.readNetworkPolicy(this.#sandboxNamespace, "agent-dock-default-deny-all"),
      this.#client.readNetworkPolicy(this.#importerNamespace, "agent-dock-default-deny-all"),
      this.#client.readRuntimeClass(this.#runtimeClassName),
    ]);
    if (!networkPolicyIsDefaultDeny(toolPolicy) || !networkPolicyIsDefaultDeny(importerPolicy)) {
      throw new SandboxManagerError(
        "kubernetes_network_policy_unavailable",
        "Kubernetes execution namespaces do not enforce the required default-deny policy",
        false,
      );
    }
    if (
      runtimeClass?.handler !== KUBERNETES_GVISOR_RUNTIME_NAME ||
      runtimeClass.metadata?.annotations?.["agent-dock.io/runtime"] !==
        KUBERNETES_GVISOR_RUNTIME_NAME ||
      runtimeClass.metadata.annotations["agent-dock.io/platform"] !== "kvm"
    ) {
      throw new SandboxManagerError(
        "kubernetes_runtime_class_unavailable",
        "Kubernetes does not expose the required runsc/KVM RuntimeClass",
        false,
      );
    }
    await this.#cleanupOrphanedDependencyBootstraps();
    if (this.#dependencyEgress !== undefined) {
      await this.#ensureDependencyProxyReady();
    }
    if (this.#runtimeProbe === undefined) this.#runtimeProbe = this.#probeGvisorRuntime();
    try {
      await this.#runtimeProbe;
    } catch (error: unknown) {
      this.#runtimeProbe = undefined;
      throw error;
    }
  }

  async #ensureDependencyProxyReady(): Promise<{ host: string; port: number }> {
    const configuration = this.#dependencyEgress;
    if (configuration === undefined) {
      throw new SandboxManagerError(
        "dependency_egress_unavailable",
        "Dependency egress is not configured",
        false,
      );
    }
    const trust = await this.#client.readConfigMap(
      configuration.namespace,
      configuration.configMapName,
    );
    const resourceVersion = trust?.metadata?.resourceVersion;
    if (trust === undefined || resourceVersion === undefined) {
      throw new SandboxManagerError(
        "dependency_egress_trust_unavailable",
        "Dependency egress trust anchor is unavailable",
        false,
      );
    }
    const trustUpdated = trust.data?.["public-key.pem"] !== configuration.publicKeyPem;
    if (trustUpdated) {
      await this.#client.patchConfigMapData(
        configuration.namespace,
        configuration.configMapName,
        resourceVersion,
        { "public-key.pem": configuration.publicKeyPem },
      );
    }
    const [service, endpoints, toolPolicy, proxyDefaultDeny, proxyIngress, proxyEgress] =
      await Promise.all([
        this.#client.readService(configuration.namespace, configuration.serviceName),
        this.#client.readEndpoints(configuration.namespace, configuration.serviceName),
        this.#client.readNetworkPolicy(this.#sandboxNamespace, "agent-dock-dependency-egress"),
        this.#client.readNetworkPolicy(configuration.namespace, "agent-dock-default-deny-all"),
        this.#client.readNetworkPolicy(configuration.namespace, "dependency-egress-ingress"),
        this.#client.readNetworkPolicy(configuration.namespace, "dependency-egress-public-https"),
      ]);
    const host = service?.spec?.clusterIP;
    const servicePorts = service?.spec?.ports ?? [];
    if (
      service?.spec?.type !== "ClusterIP" ||
      host === undefined ||
      !isIPv4(host) ||
      servicePorts.length !== 1 ||
      servicePorts[0]?.protocol !== "TCP" ||
      servicePorts[0]?.port !== configuration.servicePort ||
      service?.spec?.selector?.[KUBERNETES_SANDBOX_LABELS.workload] !== "dependency-egress-proxy"
    ) {
      throw new SandboxManagerError(
        "dependency_egress_service_invalid",
        "Dependency egress Service is invalid",
        false,
      );
    }
    if (
      !networkPolicyIsDefaultDeny(proxyDefaultDeny) ||
      !toolDependencyEgressPolicyIsBounded(
        toolPolicy,
        configuration.namespace,
        configuration.servicePort,
      ) ||
      !proxyIngressPolicyIsBounded(
        proxyIngress,
        this.#sandboxNamespace,
        configuration.servicePort,
      ) ||
      !proxyPublicEgressPolicyIsBounded(proxyEgress)
    ) {
      throw new SandboxManagerError(
        "dependency_egress_policy_invalid",
        "Dependency egress NetworkPolicy is invalid",
        false,
      );
    }
    let readyAddresses =
      endpoints?.subsets?.flatMap((subset) => subset.addresses?.map((entry) => entry.ip) ?? []) ??
      [];
    if (readyAddresses.length < 1 && trustUpdated) {
      const deadline = Date.now() + 90_000;
      while (readyAddresses.length < 1 && Date.now() < deadline) {
        await delay(500);
        const current = await this.#client.readEndpoints(
          configuration.namespace,
          configuration.serviceName,
        );
        readyAddresses =
          current?.subsets?.flatMap((subset) => subset.addresses?.map((entry) => entry.ip) ?? []) ??
          [];
      }
    }
    if (readyAddresses.length < 1) {
      throw new SandboxManagerError(
        "dependency_egress_proxy_unavailable",
        "Dependency egress proxy is not ready",
        true,
      );
    }
    this.#dependencyProxyEndpoint = { host, port: configuration.servicePort };
    return this.#dependencyProxyEndpoint;
  }

  async #probeGvisorRuntime(): Promise<void> {
    const probeId = uuid(this.#idGenerator(), "gVisor probe ID");
    const name = `agent-dock-probe-${probeId}`.slice(0, 63);
    let uidValue: string | undefined;
    try {
      const created = await this.#client.createPod(
        this.#sandboxNamespace,
        buildRuntimeProbePod(
          this.#toolImage,
          name,
          this.#sandboxNamespace,
          probeId,
          this.#runtimeClassName,
          this.#toolServiceAccountName,
          this.#imagePullPolicy,
        ),
      );
      uidValue = this.#podUid(created);
      const terminal = await this.#waitForPodTerminal(
        this.#sandboxNamespace,
        name,
        this.#readyTimeoutMs,
        "gVisor runtime probe",
      );
      if (this.#podUid(terminal) !== uidValue) {
        throw new SandboxManagerError(
          "kubernetes_pod_identity_mismatch",
          "The gVisor runtime probe Pod identity changed",
          false,
        );
      }
      const kernel = (
        await this.#client.readPodLog(this.#sandboxNamespace, name, PROBE_CONTAINER_NAME)
      ).trim();
      if (terminal.status?.phase !== "Succeeded" || !GVISOR_KERNEL_PATTERN.test(kernel)) {
        throw new SandboxManagerError(
          "gvisor_runtime_probe_failed",
          "The Kubernetes RuntimeClass did not execute the trusted gVisor probe",
          false,
        );
      }
    } finally {
      const cleanupUid =
        uidValue ??
        (await this.#managedPodUidForCleanup(
          this.#sandboxNamespace,
          name,
          "runtime-probe",
          KUBERNETES_SANDBOX_ANNOTATIONS.activationId,
          probeId,
        ));
      if (cleanupUid !== undefined) {
        await this.#deleteExactPod(this.#sandboxNamespace, name, cleanupUid);
      }
    }
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    const dependencyHosts = spec.environment.recipe.dependencyHosts;
    if (dependencyHosts === undefined) {
      return await this.#createPhysical(spec, {
        activationId: spec.activationId,
        dependencyEgress: false,
      });
    }
    const configuration = this.#dependencyEgress;
    if (configuration === undefined) {
      throw new SandboxManagerError(
        "dependency_egress_unavailable",
        "Environment dependency egress is not configured",
        false,
      );
    }
    const endpoint = this.#dependencyProxyEndpoint ?? (await this.#ensureDependencyProxyReady());
    const bootstrapId = uuid(this.#idGenerator(), "Dependency bootstrap activation ID");
    const minted = mintDependencyEgressCapability({
      privateKey: configuration.privateKeyPem,
      activationId: bootstrapId,
      hosts: dependencyHosts,
      ttlMs: configuration.capabilityTtlMs,
    });
    let bootstrap: SandboxHandle | undefined;
    try {
      bootstrap = await this.#createPhysical(spec, {
        activationId: bootstrapId,
        dependencyEgress: true,
        dependencyProxy: {
          host: endpoint.host,
          port: endpoint.port,
          capability: minted.token,
          publicKeyFingerprint: configuration.publicKeyFingerprint,
        },
        environmentStage: { type: "dependency_setup" },
      });
      const capture = await this.snapshot(
        bootstrap,
        uuid(this.#idGenerator(), "Dependency bootstrap capture ID"),
      );
      if (capture.type !== "tool_sandbox.captured") {
        throw new SandboxManagerError(
          "dependency_bootstrap_capture_failed",
          "Dependency bootstrap Workspace was not captured",
          false,
        );
      }
      const setupCommands = bootstrap.environmentValidation.recipeCommands;
      await this.stop(bootstrap);
      bootstrap = undefined;
      return await this.#createPhysical(
        {
          ...spec,
          workspaceRestore: capture.workspace,
        },
        {
          activationId: spec.activationId,
          dependencyEgress: false,
          environmentStage: { type: "offline_restore", setupCommands },
        },
      );
    } finally {
      if (bootstrap !== undefined) await this.stop(bootstrap).catch(() => undefined);
    }
  }

  async #createPhysical(
    spec: SandboxCreateSpec,
    options: PhysicalSandboxCreateOptions,
  ): Promise<SandboxHandle> {
    const activationId = uuid(options.activationId, "Tool Sandbox activation ID");
    const workload: ToolSandboxWorkload = options.dependencyEgress
      ? "dependency-bootstrap"
      : "tool-sandbox";
    if (this.#activations.has(activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    const name = runtimeName(activationId);
    let createdUid: string | undefined;
    let activation: Activation | undefined;
    try {
      const created = await this.#client.createPod(
        this.#sandboxNamespace,
        buildKubernetesToolSandboxPod({
          image: this.#toolImage,
          name,
          namespace: this.#sandboxNamespace,
          activationId,
          assignment: spec.assignment,
          environment: spec.environment,
          dependencyEgress: options.dependencyEgress,
          workload,
          policy: spec.policy,
          runtimeClassName: this.#runtimeClassName,
          serviceAccountName: this.#toolServiceAccountName,
          imagePullPolicy: this.#imagePullPolicy,
        }),
      );
      createdUid = this.#podUid(created);
      const runningPod = await this.#waitForPodRunning(
        this.#sandboxNamespace,
        name,
        this.#readyTimeoutMs,
        "Tool Sandbox startup",
      );
      if (this.#podUid(runningPod) !== createdUid) {
        throw new SandboxManagerError(
          "kubernetes_pod_identity_mismatch",
          "The created Tool Sandbox Pod identity changed",
          false,
        );
      }
      const currentAssignment = podToAssignment(runningPod);
      if (
        currentAssignment.activationId !== activationId ||
        currentAssignment.tenantId !== spec.assignment.tenantId ||
        currentAssignment.projectId !== spec.assignment.projectId ||
        currentAssignment.workspaceId !== spec.assignment.workspaceId ||
        currentAssignment.attemptId !== spec.assignment.attemptId ||
        !assignmentMatchesRuntime(spec.assignment, currentAssignment)
      ) {
        throw new SandboxManagerError(
          "tool_sandbox_identity_mismatch",
          "Created Kubernetes Tool Sandbox identity did not match",
          false,
        );
      }
      activation = this.#newActivation(
        activationId,
        spec.assignment,
        spec.environment,
        workload,
        name,
        createdUid,
      );
      this.#activations.set(activationId, activation);
      this.#attachWorkerStreams(activation);
      activation.connection = await this.#client.attach(
        this.#sandboxNamespace,
        name,
        TOOL_CONTAINER_NAME,
        activation.stdout,
        activation.stderrStream,
        activation.stdin,
      );
      this.#attachConnection(activation);
      await withTimeout(
        sendLine(activation, {
          toolWorkerProtocolVersion: 1,
          type: "worker.initialize",
          activationId,
          environment: spec.environment,
          workspaceSeed: spec.workspaceSeed,
          ...(spec.workspaceRestore === undefined
            ? {}
            : { workspaceRestore: spec.workspaceRestore }),
          ...(options.dependencyProxy === undefined
            ? {}
            : { dependencyProxy: options.dependencyProxy }),
          ...(options.environmentStage === undefined
            ? {}
            : { environmentStage: options.environmentStage }),
        }),
        this.#readyTimeoutMs,
        "Tool Sandbox initialization input",
      );
      const toolchain = await withTimeout(
        activation.ready.promise,
        Math.min(
          spec.policy.resources.turnWallClockTimeoutMs,
          Math.max(
            this.#readyTimeoutMs,
            (options.environmentStage?.type === "dependency_setup"
              ? spec.environment.recipe.setupCommands
              : options.environmentStage?.type === "offline_restore"
                ? spec.environment.recipe.verificationCommands
                : spec.environment.recipe.setupCommands.concat(
                    spec.environment.recipe.verificationCommands,
                  )
            ).reduce((total, command) => total + command.timeoutMs, 10_000) +
              (options.dependencyProxy === undefined ? 0 : DEPENDENCY_TRUST_READY_TIMEOUT_MS),
          ),
        ),
        "Tool Sandbox readiness",
      );
      if (
        !isExpectedDefaultToolchain(toolchain) ||
        toolchain.profileKey !== spec.environment.profileKey ||
        toolchain.profileVersion !== spec.environment.profileVersion ||
        toolchain.imageRevision !== spec.environment.imageRevision ||
        toolchain.specSha256 !== spec.environment.specSha256 ||
        toolchain.recipeSha256 !== spec.environment.recipeSha256
      ) {
        throw new SandboxManagerError(
          "environment_preflight_mismatch",
          "Tool Sandbox environment did not match the accepted Run",
          false,
        );
      }
      const inspected = await this.#inspectEffectiveIsolation(runningPod);
      this.#assertEffectiveIsolation(inspected, spec.policy, options.dependencyEgress);
      const handle: SandboxHandle = {
        providerApiVersion: 1,
        providerId: this.providerId,
        activationId,
        runtimeId: createdUid,
        runtimeName: name,
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation: {
          ...toolchain,
          isolationBoundary: "gvisor",
          runtime: "runsc",
          networkMode: "deny_all",
          runAsUser: "1000:1000",
          readOnlyRootFilesystem: true,
        },
      };
      activation.handle = handle;
      return handle;
    } catch (error: unknown) {
      if (activation !== undefined) {
        await this.#stopActivation(activation);
      } else {
        const cleanupUid =
          createdUid ??
          (await this.#managedPodUidForCleanup(
            this.#sandboxNamespace,
            name,
            workload,
            KUBERNETES_SANDBOX_ANNOTATIONS.activationId,
            activationId,
          ));
        if (cleanupUid !== undefined) {
          await this.#deleteExactPod(this.#sandboxNamespace, name, cleanupUid);
        }
      }
      throw error;
    }
  }

  async rebind(handle: SandboxHandle, assignment: ToolSandboxAssignment): Promise<SandboxHandle> {
    const activation = this.#ownedHandle(handle);
    if (
      activation.stopping ||
      activation.failed !== undefined ||
      activation.operations.size > 0 ||
      activation.captures.size > 0
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_busy",
        "Tool Sandbox cannot transfer ownership while work is active",
        true,
      );
    }
    if (
      assignment.tenantId !== handle.assignment.tenantId ||
      assignment.projectId !== handle.assignment.projectId ||
      assignment.workspaceId !== handle.assignment.workspaceId ||
      assignment.sessionId !== handle.assignment.sessionId ||
      assignment.supervisorId !== handle.assignment.supervisorId ||
      assignment.bootId !== handle.assignment.bootId ||
      assignment.sandboxId !== handle.assignment.sandboxId ||
      assignment.fencingToken <= handle.assignment.fencingToken
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox ownership transfer was outside its session or fence",
        false,
      );
    }
    const pod = await this.#client.readPod(this.#sandboxNamespace, handle.runtimeName);
    const resourceVersion = pod?.metadata?.resourceVersion;
    if (
      pod === undefined ||
      pod.metadata?.uid !== handle.runtimeId ||
      typeof resourceVersion !== "string" ||
      resourceVersion.length < 1 ||
      !this.#managedRuntimeMatchesHandle(podToAssignment(pod), handle)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox ownership transfer identity did not match",
        false,
      );
    }
    const updated = await this.#client.patchPodAnnotations(
      this.#sandboxNamespace,
      handle.runtimeName,
      handle.runtimeId,
      resourceVersion,
      {
        ...(pod.metadata?.annotations ?? {}),
        ...assignmentAnnotations(handle.activationId, assignment, DEFAULT_TOOL_SANDBOX_POLICY),
      },
    );
    const current = podToAssignment(updated);
    if (
      current.containerId !== handle.runtimeId ||
      current.activationId !== handle.activationId ||
      current.tenantId !== assignment.tenantId ||
      current.projectId !== assignment.projectId ||
      current.workspaceId !== assignment.workspaceId ||
      current.attemptId !== assignment.attemptId ||
      !assignmentMatchesRuntime(assignment, current)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Rebound Kubernetes Tool Sandbox identity did not match",
        false,
      );
    }
    const rebound: SandboxHandle = { ...handle, assignment };
    activation.assignment = assignment;
    activation.handle = rebound;
    activation.seenOperationIds.clear();
    return rebound;
  }

  async exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#ownedHandle(handle);
    if (request.activationId !== handle.activationId) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool operation activation identity did not match",
        false,
      );
    }
    if (activation.stopping || activation.failed !== undefined) {
      throw new SandboxManagerError(
        "tool_sandbox_unavailable",
        "Tool Sandbox is unavailable",
        true,
      );
    }
    if (
      activation.operations.has(request.operationId) ||
      activation.seenOperationIds.has(request.operationId)
    ) {
      throw new SandboxManagerError(
        "tool_operation_replay",
        "Tool operation ID was already used",
        false,
      );
    }
    activation.seenOperationIds.add(request.operationId);
    const pending = deferred<ToolSandboxOperationResponse>();
    void pending.promise.catch(() => undefined);
    activation.operations.set(request.operationId, pending);
    const abort = (): void => {
      void sendLine(activation, {
        toolWorkerProtocolVersion: 1,
        type: "worker.cancel",
        activationId: activation.activationId,
        operationId: request.operationId,
      }).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await withTimeout(
        sendLine(activation, {
          toolWorkerProtocolVersion: 1,
          type: "worker.operation",
          request,
        }),
        DEFAULT_READY_TIMEOUT_MS,
        "Tool Sandbox operation input",
      );
      if (signal?.aborted) abort();
      const operationTimeout =
        request.operation === "bash.exec"
          ? request.timeoutMs + DEFAULT_OPERATION_GRACE_MS
          : DEFAULT_READY_TIMEOUT_MS;
      return await withTimeout(pending.promise, operationTimeout, "Tool Sandbox operation");
    } finally {
      signal?.removeEventListener("abort", abort);
      activation.operations.delete(request.operationId);
    }
  }

  async readFile(
    handle: SandboxHandle,
    input: SandboxReadFileInput,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.exec(
      handle,
      {
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId: handle.activationId,
        operationId: input.operationId,
        operation: "file.read",
        path: input.path,
      },
      signal,
    );
    if (response.type === "tool_sandbox.operation_failed") {
      throw new SandboxManagerError(response.code, response.message, response.retryable);
    }
    if (response.operation !== "file.read") {
      throw new SandboxManagerError(
        "sandbox_provider_protocol_error",
        "Kubernetes gVisor Sandbox Provider returned the wrong file operation",
        false,
      );
    }
    return Buffer.from(response.content, "base64");
  }

  async writeFile(
    handle: SandboxHandle,
    input: SandboxWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.exec(
      handle,
      {
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId: handle.activationId,
        operationId: input.operationId,
        operation: "file.write",
        path: input.path,
        content: input.content,
      },
      signal,
    );
    if (response.type === "tool_sandbox.operation_failed") {
      throw new SandboxManagerError(response.code, response.message, response.retryable);
    }
    if (response.operation !== "file.write") {
      throw new SandboxManagerError(
        "sandbox_provider_protocol_error",
        "Kubernetes gVisor Sandbox Provider returned the wrong file operation",
        false,
      );
    }
  }

  async snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse> {
    const activation = this.#ownedHandle(handle);
    if (activation.captures.has(requestId)) {
      throw new SandboxManagerError(
        "tool_capture_replay",
        "Tool Sandbox capture ID was already used",
        false,
      );
    }
    const pending = deferred<ToolSandboxCaptureResponse>();
    void pending.promise.catch(() => undefined);
    activation.captures.set(requestId, pending);
    try {
      await withTimeout(
        sendLine(activation, {
          toolWorkerProtocolVersion: 1,
          type: "worker.capture",
          activationId: handle.activationId,
          requestId,
        }),
        this.#readyTimeoutMs,
        "Tool Sandbox capture input",
      );
      return await withTimeout(pending.promise, this.#readyTimeoutMs, "Tool Sandbox capture");
    } finally {
      activation.captures.delete(requestId);
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const activation = this.#activations.get(handle.activationId);
    if (activation === undefined) {
      await this.destroy(handle);
      return;
    }
    this.#ownedHandle(handle);
    await this.#stopActivation(activation);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.#assertHandleShape(handle);
    const pod = await this.#client.readPod(this.#sandboxNamespace, handle.runtimeName);
    if (pod === undefined || pod.metadata?.uid !== handle.runtimeId) {
      this.#activations.delete(handle.activationId);
      return;
    }
    const current = podToAssignment(pod);
    if (!this.#managedRuntimeMatchesHandle(current, handle)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
    await this.#deleteExactPod(this.#sandboxNamespace, handle.runtimeName, handle.runtimeId);
    this.#activations.delete(handle.activationId);
  }

  async destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    uuid(activationId, "Tool Sandbox activation ID");
    const activation = this.#activations.get(activationId);
    if (activation !== undefined) {
      if (!sameAssignment(activation.assignment, assignment)) {
        throw new SandboxManagerError(
          "tool_sandbox_identity_mismatch",
          "Tool Sandbox assignment identity did not match",
          false,
        );
      }
      await this.#stopActivation(activation);
      return;
    }
    const name = runtimeName(activationId);
    const pod = await this.#client.readPod(this.#sandboxNamespace, name);
    if (pod === undefined) return;
    const current = podToAssignment(pod);
    if (
      current.activationId !== activationId ||
      current.tenantId !== assignment.tenantId ||
      current.projectId !== assignment.projectId ||
      current.workspaceId !== assignment.workspaceId ||
      current.attemptId !== assignment.attemptId ||
      !assignmentMatchesRuntime(assignment, current)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    await this.#deleteExactPod(this.#sandboxNamespace, name, current.containerId);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspection> {
    this.#assertHandleShape(handle);
    const pod = await this.#client.readPod(this.#sandboxNamespace, handle.runtimeName);
    if (pod === undefined || pod.metadata?.uid !== handle.runtimeId) {
      return {
        providerApiVersion: 1,
        providerId: this.providerId,
        state: "absent",
        handle,
      };
    }
    const current = podToAssignment(pod);
    if (!this.#managedRuntimeMatchesHandle(current, handle)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox inspection identity did not match",
        false,
      );
    }
    const inspected = await this.#inspectEffectiveIsolation(pod);
    return {
      providerApiVersion: 1,
      providerId: this.providerId,
      state: inspected.running ? "running" : "stopped",
      handle,
      effectiveIsolation: inspected.effectiveIsolation,
    };
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    bounded(sandboxId, "Sandbox inventory ID", 512);
    const pods = await this.#client.listPods(
      this.#sandboxNamespace,
      `${KUBERNETES_SANDBOX_LABELS.managed}=true,${KUBERNETES_SANDBOX_LABELS.workload}=tool-sandbox,${KUBERNETES_SANDBOX_LABELS.sandboxHash}=${sandboxHash(sandboxId)}`,
    );
    if (pods.length > 1_000) {
      throw new SandboxManagerError(
        "kubernetes_inventory_ambiguous",
        "Tool Sandbox inventory exceeded its safe scope",
        false,
      );
    }
    const assignments: SupervisorRuntimeAssignment[] = [];
    for (const pod of pods) {
      const current = podToAssignment(pod);
      if (current.sandboxId === sandboxId) {
        assignments.push(supervisorRuntimeAssignment(current));
      }
    }
    return assignments;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const pod = await this.#client.readPod(this.#sandboxNamespace, assignment.containerName);
    if (pod === undefined) return;
    const current = podToAssignment(pod);
    if (!sameRuntimeAssignment(current, assignment)) {
      throw new SandboxManagerError(
        "kubernetes_assignment_identity_mismatch",
        "Tool Sandbox termination identity did not match",
        false,
      );
    }
    const tracked = [...this.#activations.values()].find(
      (activation) => activation.runtimeId === assignment.containerId,
    );
    if (tracked !== undefined) {
      if (
        tracked.runtimeName !== assignment.containerName ||
        !assignmentMatchesRuntime(tracked.assignment, assignment)
      ) {
        throw new SandboxManagerError(
          "kubernetes_assignment_identity_mismatch",
          "Tracked Tool Sandbox identity did not match",
          false,
        );
      }
      await this.#stopActivation(tracked);
      return;
    }
    await this.#deleteExactPod(
      this.#sandboxNamespace,
      assignment.containerName,
      assignment.containerId,
    );
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const pod = await this.#client.readPod(this.#sandboxNamespace, assignment.containerName);
    if (pod?.metadata?.uid === assignment.containerId) {
      throw new SandboxManagerError(
        "kubernetes_assignment_still_alive",
        "Tool Sandbox absence could not be confirmed",
        false,
      );
    }
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) {
      throw new SandboxManagerError(
        "repository_import_cancelled",
        "Repository import was cancelled",
        true,
      );
    }
    const importId = uuid(this.#idGenerator(), "Repository import ID");
    const name = `agent-dock-import-${importId}`.slice(0, 63);
    let uidValue: string | undefined;
    let connection: WebSocket | undefined;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderrStream = new PassThrough();
    let stdoutBytes = Buffer.alloc(0);
    let stderr = "";
    let overflow = false;
    stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes = Buffer.concat([stdoutBytes, chunk]);
      if (stdoutBytes.byteLength > MAX_IMPORT_STDOUT_BYTES) {
        overflow = true;
        connection?.close();
      }
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_WORKER_STDERR_BYTES);
    });
    const abort = (): void => {
      connection?.close();
      const currentUid = uidValue;
      if (currentUid !== undefined) {
        void this.#deleteExactPod(this.#importerNamespace, name, currentUid).catch(() => undefined);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const created = await this.#client.createPod(
        this.#importerNamespace,
        buildKubernetesRepositoryImportPod({
          image: this.#toolImage,
          name,
          namespace: this.#importerNamespace,
          importId,
          runtimeClassName: this.#runtimeClassName,
          serviceAccountName: this.#importerServiceAccountName,
          imagePullPolicy: this.#imagePullPolicy,
          timeoutMs: this.#repositoryImportTimeoutMs,
        }),
      );
      uidValue = this.#podUid(created);
      const running = await this.#waitForPodRunning(
        this.#importerNamespace,
        name,
        this.#readyTimeoutMs,
        "Repository importer startup",
      );
      if (this.#podUid(running) !== uidValue) {
        throw new SandboxManagerError(
          "kubernetes_pod_identity_mismatch",
          "The Repository importer Pod identity changed",
          false,
        );
      }
      connection = await this.#client.attach(
        this.#importerNamespace,
        name,
        IMPORT_CONTAINER_NAME,
        stdout,
        stderrStream,
        stdin,
      );
      const request: GitHubWorkspaceImportRequest = {
        workspaceImportProtocolVersion: 1,
        type: "workspace.import",
        importId,
        source,
      };
      stdin.write(`${JSON.stringify(request)}\n`);
      const terminal = await this.#waitForPodTerminal(
        this.#importerNamespace,
        name,
        this.#repositoryImportTimeoutMs,
        "Repository import",
        signal,
      );
      await delay(50);
      if (signal.aborted) {
        throw new SandboxManagerError(
          "repository_import_cancelled",
          "Repository import was cancelled",
          true,
        );
      }
      if (overflow || stdoutBytes.byteLength > MAX_IMPORT_STDOUT_BYTES) {
        throw new SandboxManagerError(
          "repository_import_output_too_large",
          "Repository importer output exceeded its limit",
          false,
        );
      }
      const lines = stdoutBytes.toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== 1) {
        throw new SandboxManagerError(
          "repository_import_protocol_error",
          "Repository importer returned invalid output",
          false,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(lines[0]!) as unknown;
      } catch {
        throw new SandboxManagerError(
          "repository_import_protocol_error",
          "Repository importer returned invalid output",
          false,
        );
      }
      const output = parseGitHubWorkspaceImportOutput(value);
      if (output.importId !== importId) {
        throw new SandboxManagerError(
          "repository_import_identity_mismatch",
          "Repository importer identity did not match",
          false,
        );
      }
      if (output.type === "workspace.import.failed") {
        throw new SandboxManagerError(output.code, output.message, output.retryable);
      }
      if (terminal.status?.phase !== "Succeeded") {
        throw new SandboxManagerError(
          "repository_import_process_failed",
          stderr.length > 0
            ? "Repository importer exited with diagnostic output"
            : "Repository importer exited unexpectedly",
          true,
        );
      }
      return decodeWorkspaceSnapshotBlob(output.snapshot);
    } finally {
      signal.removeEventListener("abort", abort);
      stdin.destroy();
      stdout.destroy();
      stderrStream.destroy();
      connection?.close();
      const cleanupUid =
        uidValue ??
        (await this.#managedPodUidForCleanup(
          this.#importerNamespace,
          name,
          "repository-importer",
          KUBERNETES_SANDBOX_ANNOTATIONS.importId,
          importId,
        ));
      if (cleanupUid !== undefined) {
        await this.#deleteExactPod(this.#importerNamespace, name, cleanupUid);
      }
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#activations.values()].map((activation) => this.#stopActivation(activation)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new SandboxManagerError(
        "sandbox_provider_cleanup_unverified",
        "Kubernetes gVisor Sandbox Provider shutdown could not confirm complete cleanup",
        true,
      );
    }
  }

  #newActivation(
    activationId: string,
    assignment: ToolSandboxAssignment,
    environment: EnvironmentRuntimeSnapshot,
    workload: ToolSandboxWorkload,
    name: string,
    uidValue: string,
  ): Activation {
    const ready = deferred<EnvironmentToolchainReport>();
    const closed = deferred<void>();
    void ready.promise.catch(() => undefined);
    void closed.promise.catch(() => undefined);
    return {
      activationId,
      assignment,
      environment,
      workload,
      runtimeName: name,
      runtimeId: uidValue,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderrStream: new PassThrough(),
      closed,
      ready,
      operations: new Map(),
      captures: new Map(),
      seenOperationIds: new Set(),
      stdoutBuffer: Buffer.alloc(0),
      stderr: "",
      stopping: false,
    };
  }

  #attachWorkerStreams(activation: Activation): void {
    const fail = (error: Error): void => {
      if (activation.failed !== undefined || activation.stopping) return;
      activation.failed = error;
      activation.ready.reject(error);
      for (const pending of activation.operations.values()) pending.reject(error);
      for (const pending of activation.captures.values()) pending.reject(error);
      activation.operations.clear();
      activation.captures.clear();
      void this.#stopActivation(activation).catch(() => undefined);
    };
    activation.stdout.on("data", (chunk: Buffer) => {
      if (activation.failed !== undefined) return;
      activation.stdoutBuffer = Buffer.concat([activation.stdoutBuffer, chunk]);
      if (activation.stdoutBuffer.byteLength > MAX_WORKER_STDOUT_BYTES) {
        activation.stdoutBuffer = Buffer.alloc(0);
        fail(
          new SandboxManagerError(
            "tool_worker_protocol_error",
            "Tool Sandbox output exceeded its buffer limit",
            false,
          ),
        );
        return;
      }
      let newline = activation.stdoutBuffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = activation.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
        activation.stdoutBuffer = activation.stdoutBuffer.subarray(newline + 1);
        if (line.length > 0) {
          let output: ToolWorkerOutput;
          try {
            output = parseToolWorkerOutput(JSON.parse(line) as unknown);
          } catch {
            fail(
              new SandboxManagerError(
                "tool_worker_protocol_error",
                "Tool Sandbox emitted invalid output",
                false,
              ),
            );
            return;
          }
          try {
            this.#handleWorkerOutput(activation, output);
          } catch (error: unknown) {
            fail(
              error instanceof SandboxManagerError
                ? error
                : new SandboxManagerError(
                    "tool_worker_protocol_error",
                    "Tool Sandbox emitted invalid output",
                    false,
                  ),
            );
            return;
          }
        }
        newline = activation.stdoutBuffer.indexOf(0x0a);
      }
    });
    activation.stderrStream.on("data", (chunk: Buffer) => {
      activation.stderr = `${activation.stderr}${chunk.toString("utf8")}`.slice(
        -MAX_WORKER_STDERR_BYTES,
      );
    });
    activation.stdin.once("error", () => {
      fail(
        new SandboxManagerError(
          "tool_sandbox_connection_failed",
          "Tool Sandbox input connection failed",
          true,
        ),
      );
    });
    activation.stdout.once("error", () => {
      fail(
        new SandboxManagerError(
          "tool_sandbox_connection_failed",
          "Tool Sandbox output connection failed",
          true,
        ),
      );
    });
  }

  #attachConnection(activation: Activation): void {
    const connection = activation.connection;
    if (connection === undefined) throw new Error("Kubernetes attach connection is missing");
    connection.once("error", () => {
      if (!activation.stopping) {
        const error = new SandboxManagerError(
          "tool_sandbox_connection_failed",
          "Tool Sandbox attach connection failed",
          true,
        );
        activation.failed ??= error;
        activation.ready.reject(error);
        for (const pending of activation.operations.values()) pending.reject(error);
        for (const pending of activation.captures.values()) pending.reject(error);
      }
      activation.closed.resolve();
    });
    connection.once("close", () => {
      if (!activation.stopping) {
        const error = new SandboxManagerError(
          "tool_sandbox_exit",
          "Tool Sandbox stopped before release",
          true,
        );
        activation.failed ??= error;
        activation.ready.reject(error);
        for (const pending of activation.operations.values()) pending.reject(error);
        for (const pending of activation.captures.values()) pending.reject(error);
        void this.#stopActivation(activation).catch(() => undefined);
      }
      activation.closed.resolve();
    });
  }

  #handleWorkerOutput(activation: Activation, output: ToolWorkerOutput): void {
    if (output.type === "worker.ready") {
      if (output.activationId !== activation.activationId) throw new Error("identity mismatch");
      if (
        output.environment.profileKey !== activation.environment.profileKey ||
        output.environment.profileVersion !== activation.environment.profileVersion ||
        output.environment.imageRevision !== activation.environment.imageRevision ||
        output.environment.specSha256 !== activation.environment.specSha256 ||
        output.environment.recipeSha256 !== activation.environment.recipeSha256
      ) {
        throw new SandboxManagerError(
          "environment_preflight_mismatch",
          "Tool Sandbox environment did not match the accepted Run",
          false,
        );
      }
      activation.ready.resolve(output.environment);
      return;
    }
    if (output.type === "worker.operation_result") {
      const response = output.response;
      if (response.activationId !== activation.activationId) throw new Error("identity mismatch");
      const pending = activation.operations.get(response.operationId);
      if (pending === undefined) throw new Error("unexpected operation result");
      pending.resolve(response);
      return;
    }
    if (output.type === "worker.captured") {
      if (output.activationId !== activation.activationId) throw new Error("identity mismatch");
      const pending = activation.captures.get(output.requestId);
      if (pending === undefined) throw new Error("unexpected capture result");
      pending.resolve({
        managerProtocolVersion: 1,
        type: "tool_sandbox.captured",
        requestId: output.requestId,
        activationId: output.activationId,
        workspace: output.workspace,
        environment: activation.handle!.environmentValidation,
        ...(output.workspacePatch === undefined ? {} : { workspacePatch: output.workspacePatch }),
      });
      return;
    }
    const error = new SandboxManagerError(output.code, output.message, output.retryable);
    if (output.operationId !== undefined) {
      const pending = activation.operations.get(output.operationId);
      if (pending === undefined) throw new Error("unexpected operation failure");
      pending.reject(error);
      return;
    }
    if (output.requestId !== undefined) {
      const pending = activation.captures.get(output.requestId);
      if (pending === undefined) throw new Error("unexpected capture failure");
      pending.reject(error);
      return;
    }
    throw error;
  }

  #assertHandleShape(handle: SandboxHandle): void {
    if (
      handle.providerApiVersion !== 1 ||
      handle.providerId !== this.providerId ||
      handle.workspaceRoot !== "/workspace" ||
      runtimeName(handle.activationId) !== handle.runtimeName
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
  }

  #ownedHandle(handle: SandboxHandle): Activation {
    this.#assertHandleShape(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.handle.runtimeName !== handle.runtimeName ||
      !sameAssignment(activation.assignment, handle.assignment)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
    return activation;
  }

  #managedRuntimeMatchesHandle(current: ManagedPodRuntime, handle: SandboxHandle): boolean {
    return (
      current.containerId === handle.runtimeId &&
      current.containerName === handle.runtimeName &&
      current.activationId === handle.activationId &&
      current.tenantId === handle.assignment.tenantId &&
      current.projectId === handle.assignment.projectId &&
      current.workspaceId === handle.assignment.workspaceId &&
      current.attemptId === handle.assignment.attemptId &&
      assignmentMatchesRuntime(handle.assignment, current)
    );
  }

  async #inspectEffectiveIsolation(pod: V1Pod): Promise<{
    running: boolean;
    effectiveIsolation: SandboxEffectiveIsolation;
  }> {
    const spec = pod.spec;
    const container = spec?.containers.find((entry) => entry.name === TOOL_CONTAINER_NAME);
    const annotations = pod.metadata?.annotations;
    if (spec === undefined || container === undefined || annotations === undefined) {
      throw new SandboxManagerError(
        "kubernetes_assignment_identity_invalid",
        "Tool Sandbox effective isolation was invalid",
        false,
      );
    }
    const numericAnnotation = (key: string): number | null => {
      const value = Number(annotations[key]);
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    };
    const memoryLimit = quantityToNumber(container.resources?.limits?.memory, "bytes");
    const cpuNano = quantityToNumber(container.resources?.limits?.cpu, "cpu");
    const volumes = spec.volumes ?? [];
    const hostMounts = volumes.filter((volume) => volume.hostPath !== undefined);
    const volumeMounts = container.volumeMounts ?? [];
    const processLimit = numericAnnotation(KUBERNETES_SANDBOX_ANNOTATIONS.processLimit);
    const openFiles = numericAnnotation(KUBERNETES_SANDBOX_ANNOTATIONS.openFilesLimit);
    const commandText = [...(container.command ?? []), ...(container.args ?? [])].join(" ");
    const limitsReflectedInCommand =
      processLimit !== null &&
      openFiles !== null &&
      commandText.includes(`ulimit -u ${String(processLimit)}`) &&
      commandText.includes(`ulimit -n ${String(openFiles)}`);
    const running = pod.status?.phase === "Running";
    let sandboxKernelRelease: string | undefined;
    if (running) {
      const result = await this.#client.exec(
        this.#sandboxNamespace,
        pod.metadata!.name!,
        TOOL_CONTAINER_NAME,
        ["uname", "-r"],
        this.#cleanupTimeoutMs,
        64 * 1_024,
      );
      sandboxKernelRelease = result.stdout.toString("utf8").trim();
      if (!statusSucceeded(result.status) || !GVISOR_KERNEL_PATTERN.test(sandboxKernelRelease)) {
        throw new SandboxManagerError(
          "gvisor_runtime_mismatch",
          "Tool Sandbox did not execute behind the required gVisor kernel",
          false,
        );
      }
    }
    const containerSecurity = container.securityContext;
    const podSecurity = spec.securityContext;
    const drop = containerSecurity?.capabilities?.drop ?? [];
    return {
      running,
      effectiveIsolation: {
        isolationBoundary: "gvisor",
        runtime: KUBERNETES_GVISOR_RUNTIME_NAME,
        user: `${String(containerSecurity?.runAsUser ?? podSecurity?.runAsUser)}:${String(containerSecurity?.runAsGroup ?? podSecurity?.runAsGroup)}`,
        privileged: containerSecurity?.privileged === true,
        readOnlyRootFilesystem: containerSecurity?.readOnlyRootFilesystem === true,
        networkMode:
          spec.hostNetwork === true
            ? "host"
            : pod.metadata?.labels?.[KUBERNETES_SANDBOX_LABELS.dependencyEgress] === "true"
              ? "kubernetes-network-policy/dependency-proxy"
              : "kubernetes-network-policy/deny-all",
        mountCount: hostMounts.length + (container.volumeDevices?.length ?? 0),
        hasDockerSocket:
          hostMounts.some((volume) => volume.hostPath?.path === "/var/run/docker.sock") ||
          volumeMounts.some((mount) => mount.mountPath === "/var/run/docker.sock"),
        pidLimit: limitsReflectedInCommand ? processLimit : null,
        processLimit: limitsReflectedInCommand ? processLimit : null,
        memoryBytes: memoryLimit,
        cpuNano,
        droppedCapabilities: drop,
        securityOptions: [
          ...(containerSecurity?.allowPrivilegeEscalation === false
            ? ["no-new-privileges:true"]
            : []),
          ...(containerSecurity?.seccompProfile?.type === "RuntimeDefault"
            ? ["seccomp=RuntimeDefault"]
            : []),
          `runtimeClass=${String(spec.runtimeClassName ?? "")}`,
          ...(spec.automountServiceAccountToken === false
            ? ["automount-service-account-token=false"]
            : []),
        ],
        ...(sandboxKernelRelease === undefined ? {} : { sandboxKernelRelease }),
      },
    };
  }

  #assertEffectiveIsolation(
    inspected: { running: boolean; effectiveIsolation: SandboxEffectiveIsolation },
    policy: SandboxPolicy,
    dependencyEgress: boolean,
  ): void {
    const isolation = inspected.effectiveIsolation;
    const expected = policy.resources;
    if (
      !inspected.running ||
      isolation.isolationBoundary !== "gvisor" ||
      isolation.runtime !== KUBERNETES_GVISOR_RUNTIME_NAME ||
      isolation.user !== policy.user ||
      isolation.privileged ||
      !isolation.readOnlyRootFilesystem ||
      isolation.networkMode !==
        (dependencyEgress
          ? "kubernetes-network-policy/dependency-proxy"
          : "kubernetes-network-policy/deny-all") ||
      isolation.mountCount !== 0 ||
      isolation.hasDockerSocket ||
      isolation.pidLimit !== expected.pids ||
      isolation.processLimit !== expected.pids ||
      isolation.memoryBytes !== expected.memoryBytes ||
      isolation.cpuNano !== expected.cpuNano ||
      !isolation.droppedCapabilities.includes("ALL") ||
      !isolation.securityOptions.includes("no-new-privileges:true") ||
      !isolation.securityOptions.includes("seccomp=RuntimeDefault") ||
      !isolation.securityOptions.includes(`runtimeClass=${this.#runtimeClassName}`) ||
      !isolation.securityOptions.includes("automount-service-account-token=false") ||
      isolation.sandboxKernelRelease === undefined ||
      !GVISOR_KERNEL_PATTERN.test(isolation.sandboxKernelRelease)
    ) {
      throw new SandboxManagerError(
        "gvisor_isolation_mismatch",
        "Tool Sandbox effective isolation did not match the required Kubernetes gVisor policy",
        false,
      );
    }
  }

  async #stopActivation(activation: Activation): Promise<void> {
    if (!activation.stopping) {
      activation.stopping = true;
      try {
        await withTimeout(
          sendLine(activation, {
            toolWorkerProtocolVersion: 1,
            type: "worker.shutdown",
            activationId: activation.activationId,
          }),
          2_000,
          "Tool Sandbox shutdown input",
        );
      } catch {
        // UID-fenced Pod deletion below is authoritative.
      }
      activation.stdin.end();
      await withTimeout(activation.closed.promise, 2_000, "Tool Sandbox clean stop").catch(
        () => undefined,
      );
    }
    activation.connection?.close();
    activation.stdin.destroy();
    activation.stdout.destroy();
    activation.stderrStream.destroy();
    await this.#deleteExactPod(
      this.#sandboxNamespace,
      activation.runtimeName,
      activation.runtimeId,
    );
    const stopped = new SandboxManagerError(
      "tool_sandbox_stopped",
      "Tool Sandbox was stopped",
      true,
    );
    activation.ready.reject(stopped);
    for (const pending of activation.operations.values()) pending.reject(stopped);
    for (const pending of activation.captures.values()) pending.reject(stopped);
    activation.operations.clear();
    activation.captures.clear();
    this.#activations.delete(activation.activationId);
  }

  async #deleteExactPod(namespace: string, name: string, uidValue: string): Promise<void> {
    const existing = await this.#client.readPod(namespace, name);
    if (existing === undefined || existing.metadata?.uid !== uidValue) return;
    await this.#client.deletePod(namespace, name, uidValue, 0);
    const deadline = Date.now() + this.#cleanupTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.#client.readPod(namespace, name);
      if (current === undefined || current.metadata?.uid !== uidValue) return;
      await delay(POLL_INTERVAL_MS);
    }
    throw new SandboxManagerError(
      "kubernetes_cleanup_unverified",
      "Tool Sandbox Pod removal could not be confirmed",
      true,
    );
  }

  async #cleanupOrphanedDependencyBootstraps(): Promise<void> {
    const pods = await this.#client.listPods(
      this.#sandboxNamespace,
      `${KUBERNETES_SANDBOX_LABELS.managed}=true,${KUBERNETES_SANDBOX_LABELS.workload}=dependency-bootstrap`,
    );
    for (const pod of pods) {
      const current = podToAssignment(pod);
      const tracked = this.#activations.get(current.activationId);
      if (tracked?.runtimeId === current.containerId) continue;
      await this.#deleteExactPod(
        this.#sandboxNamespace,
        current.containerName,
        current.containerId,
      );
    }
  }

  async #managedPodUidForCleanup(
    namespace: string,
    name: string,
    workload: string,
    identityAnnotation: string,
    identity: string,
  ): Promise<string | undefined> {
    const pod = await this.#client.readPod(namespace, name);
    if (pod === undefined) return undefined;
    if (
      pod.metadata?.labels?.[KUBERNETES_SANDBOX_LABELS.managed] !== "true" ||
      pod.metadata.labels[KUBERNETES_SANDBOX_LABELS.workload] !== workload ||
      pod.metadata.annotations?.[identityAnnotation] !== identity
    ) {
      throw new SandboxManagerError(
        "kubernetes_pod_identity_mismatch",
        "Refusing to clean up a Kubernetes Pod with different ownership identity",
        false,
      );
    }
    return this.#podUid(pod);
  }

  async #waitForPodRunning(
    namespace: string,
    name: string,
    timeoutMs: number,
    label: string,
  ): Promise<V1Pod> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.#client.readPod(namespace, name);
      if (pod === undefined) {
        throw new SandboxManagerError(
          "kubernetes_pod_disappeared",
          `${label} Pod disappeared`,
          true,
        );
      }
      if (pod.status?.phase === "Running") return pod;
      if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") {
        throw new SandboxManagerError(
          "kubernetes_pod_start_failed",
          `${label} Pod terminated before becoming ready`,
          true,
        );
      }
      const waiting = pod.status?.containerStatuses
        ?.map((status) => status.state?.waiting?.reason)
        .find((reason) =>
          reason === "ErrImageNeverPull" ||
          reason === "ImagePullBackOff" ||
          reason === "CreateContainerConfigError" ||
          reason === "RunContainerError"
            ? true
            : false,
        );
      if (waiting !== undefined) {
        throw new SandboxManagerError(
          "kubernetes_pod_start_failed",
          `${label} Pod could not start with the configured image and RuntimeClass`,
          false,
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new SandboxManagerError("sandbox_timeout", `${label} timed out`, true);
  }

  async #waitForPodTerminal(
    namespace: string,
    name: string,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<V1Pod> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new SandboxManagerError(
          "repository_import_cancelled",
          "Repository import was cancelled",
          true,
        );
      }
      const pod = await this.#client.readPod(namespace, name);
      if (pod === undefined) {
        throw new SandboxManagerError(
          "kubernetes_pod_disappeared",
          `${label} Pod disappeared`,
          true,
        );
      }
      if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return pod;
      const waiting = pod.status?.containerStatuses
        ?.map((status) => status.state?.waiting?.reason)
        .find((reason) =>
          reason === "ErrImageNeverPull" ||
          reason === "ImagePullBackOff" ||
          reason === "CreateContainerConfigError" ||
          reason === "RunContainerError"
            ? true
            : false,
        );
      if (waiting !== undefined) {
        throw new SandboxManagerError(
          "kubernetes_pod_start_failed",
          `${label} Pod could not start with the configured image and RuntimeClass`,
          false,
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new SandboxManagerError("sandbox_timeout", `${label} timed out`, true);
  }

  #podUid(pod: V1Pod): string {
    const uidValue = pod.metadata?.uid;
    if (typeof uidValue !== "string" || uidValue.length < 8 || uidValue.length > 128) {
      throw new SandboxManagerError(
        "kubernetes_assignment_identity_invalid",
        "Kubernetes Pod UID was unavailable",
        true,
      );
    }
    return uidValue;
  }
}
