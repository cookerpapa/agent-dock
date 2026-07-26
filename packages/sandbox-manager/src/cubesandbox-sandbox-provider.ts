import {
  isExpectedDefaultToolchain,
  parseEnvironmentToolchainReport,
  parseSandboxManagerResponse,
  parseToolSandboxOperationResponse,
  type EnvironmentValidationReport,
  type EnvironmentToolchainReport,
  type GitHubRepositorySource,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWebProxyBootstrap,
} from "@agent-dock/protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import {
  CUBESANDBOX_TOOL_SERVICE_PORT,
  OfficialCubeSandboxRuntimeClient,
  type CubeSandboxInstance,
  type CubeSandboxRuntimeClient,
  type OfficialCubeSandboxRuntimeClientOptions,
} from "./cubesandbox-runtime-client.ts";
import {
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

const READY_TIMEOUT_MS = 60_000;
const TOOL_RESPONSE_LIMIT_BYTES = 8 * 1_024 * 1_024;

export const CUBESANDBOX_PROVIDER_ID = "cubesandbox";
export const CUBESANDBOX_RUNTIME_NAME = "cubesandbox-kvm";

export const CUBESANDBOX_TOOL_POLICY: SandboxPolicy = Object.freeze({
  policyVersion: 1,
  network: Object.freeze({ mode: "public_web_proxy_private_denied" }),
  resources: Object.freeze({
    cpuNano: 1_000_000_000,
    memoryBytes: 768 * 1_024 * 1_024,
    pids: 128,
    openFiles: 1_024,
    // Cube v0.6 templates expose a bounded disposable CoW guest rootfs
    // instead of separate Kubernetes emptyDir volumes.
    temporaryBytes: 1 * 1_024 * 1_024 * 1_024,
    workspaceBytes: 1 * 1_024 * 1_024 * 1_024,
    maximumOutputBytes: 1 * 1_024 * 1_024,
    maximumCommandTimeoutMs: 300_000,
    turnWallClockTimeoutMs: 900_000,
  }),
  user: "1000:1000",
  readOnlyRootFilesystem: false,
  privileged: false,
  dropAllCapabilities: true,
  noNewPrivileges: true,
  allowHostMounts: false,
  allowDockerSocket: false,
});

const METADATA = Object.freeze({
  managed: "agentdock.managed",
  provider: "agentdock.provider",
  workload: "agentdock.workload",
  activationId: "agentdock.activation_id",
  tenantId: "agentdock.tenant_id",
  projectId: "agentdock.project_id",
  workspaceId: "agentdock.workspace_id",
  supervisorId: "agentdock.supervisor_id",
  bootId: "agentdock.boot_id",
  sandboxId: "agentdock.sandbox_id",
  commandId: "agentdock.command_id",
  sessionId: "agentdock.session_id",
  turnId: "agentdock.turn_id",
  attemptId: "agentdock.attempt_id",
  leaseId: "agentdock.lease_id",
  fencingToken: "agentdock.fencing_token",
  bindingSha256: "agentdock.binding_sha256",
  imageRevision: "agentdock.image_revision",
} as const);

type CubeRuntimeEvidence = Readonly<{
  imageRevision: string;
  kernelRelease: string;
  cpuCount: number;
  memoryBytes: number;
  uid: number;
  gid: number;
  hypervisorFlag: boolean;
  noNewPrivileges: boolean;
  effectiveCapabilities: string;
  readOnlyRootFilesystem: boolean;
  supervisorUid: number;
  supervisorGid: number;
}>;

type CubeActivation = {
  instance: CubeSandboxInstance;
  handle: SandboxHandle;
  evidence: CubeRuntimeEvidence;
  toolchain: EnvironmentToolchainReport;
  seenOperationIds: Set<string>;
  seenCaptureIds: Set<string>;
  bindingSha256: string;
  handoffSecret: string;
  state: "running" | "sealed" | "paused";
};

export type CubeSandboxProviderOptions = Readonly<{
  templateId: string;
  imageRevision: string;
  runtimeClient?: CubeSandboxRuntimeClient;
  runtime?: OfficialCubeSandboxRuntimeClientOptions;
  readyTimeoutMs?: number;
  importGitHub: (source: GitHubRepositorySource, signal: AbortSignal) => Promise<Uint8Array>;
  checkImporter?: () => Promise<void>;
  closeImporter?: () => Promise<void>;
  bootstrapProvider?: SandboxProvider;
  webProxy: ToolWebProxyBootstrap;
}>;

function bounded(value: string, label: string, maximum = 1_024): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError("CubeSandbox Provider numeric configuration is invalid");
  }
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxManagerError("cubesandbox_protocol_error", `${label} was invalid`, false);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string, maximum = 256): string {
  const field = value[name];
  if (
    typeof field !== "string" ||
    field.length < 1 ||
    field.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(field)
  ) {
    throw new SandboxManagerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field;
}

function integerField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new SandboxManagerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field as number;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") {
    throw new SandboxManagerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field;
}

function parseEvidence(value: unknown): CubeRuntimeEvidence {
  const candidate = record(value, "CubeSandbox runtime evidence");
  const capabilities = stringField(candidate, "effectiveCapabilities", 64).toLowerCase();
  if (!/^[0-9a-f]+$/.test(capabilities)) {
    throw new SandboxManagerError(
      "cubesandbox_protocol_error",
      "CubeSandbox capability evidence was invalid",
      false,
    );
  }
  return Object.freeze({
    imageRevision: stringField(candidate, "imageRevision", 128),
    kernelRelease: stringField(candidate, "kernelRelease", 256),
    cpuCount: integerField(candidate, "cpuCount"),
    memoryBytes: integerField(candidate, "memoryBytes"),
    uid: integerField(candidate, "uid"),
    gid: integerField(candidate, "gid"),
    hypervisorFlag: booleanField(candidate, "hypervisorFlag"),
    noNewPrivileges: booleanField(candidate, "noNewPrivileges"),
    effectiveCapabilities: capabilities,
    readOnlyRootFilesystem: booleanField(candidate, "readOnlyRootFilesystem"),
    supervisorUid: integerField(candidate, "supervisorUid"),
    supervisorGid: integerField(candidate, "supervisorGid"),
  });
}

function physicalBindingSha256(
  activationId: string,
  assignment: ToolSandboxAssignment,
  environment: SandboxCreateSpec["environment"],
): string {
  return createHash("sha256")
    .update("agent-dock.cubesandbox-binding.v1\0")
    .update(
      JSON.stringify({
        activationId,
        tenantId: assignment.tenantId,
        projectId: assignment.projectId,
        workspaceId: assignment.workspaceId,
        sessionId: assignment.sessionId,
        environmentVersionId: environment.environmentVersionId,
        specSha256: environment.specSha256,
        recipeSha256: environment.recipeSha256,
        imageRevision: environment.imageRevision,
      }),
    )
    .digest("hex");
}

function handoffSecret(): string {
  return `adch_${randomBytes(32).toString("base64url")}`;
}

function assignmentMetadata(
  activationId: string,
  assignment: ToolSandboxAssignment,
  imageRevision: string,
  bindingSha256: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [METADATA.managed]: "true",
    [METADATA.provider]: CUBESANDBOX_PROVIDER_ID,
    [METADATA.workload]: "tool-sandbox",
    [METADATA.activationId]: activationId,
    [METADATA.tenantId]: assignment.tenantId,
    [METADATA.projectId]: assignment.projectId,
    [METADATA.workspaceId]: assignment.workspaceId,
    [METADATA.supervisorId]: assignment.supervisorId,
    [METADATA.bootId]: assignment.bootId,
    [METADATA.sandboxId]: assignment.sandboxId,
    [METADATA.commandId]: assignment.commandId,
    [METADATA.sessionId]: assignment.sessionId,
    [METADATA.turnId]: assignment.turnId,
    [METADATA.attemptId]: assignment.attemptId,
    [METADATA.leaseId]: assignment.leaseId,
    [METADATA.fencingToken]: String(assignment.fencingToken),
    [METADATA.bindingSha256]: bindingSha256,
    [METADATA.imageRevision]: imageRevision,
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

function metadataMatchesPhysicalBinding(
  values: Readonly<Record<string, string>>,
  activationId: string,
  assignment: ToolSandboxAssignment,
  bindingSha256: string,
): boolean {
  return (
    values[METADATA.managed] === "true" &&
    values[METADATA.provider] === CUBESANDBOX_PROVIDER_ID &&
    values[METADATA.workload] === "tool-sandbox" &&
    values[METADATA.activationId] === activationId &&
    values[METADATA.tenantId] === assignment.tenantId &&
    values[METADATA.projectId] === assignment.projectId &&
    values[METADATA.workspaceId] === assignment.workspaceId &&
    values[METADATA.sessionId] === assignment.sessionId &&
    values[METADATA.bindingSha256] === bindingSha256
  );
}

function metadataMatchesOrphanIdentity(
  values: Readonly<Record<string, string>>,
  activationId: string,
  assignment: ToolSandboxAssignment,
): boolean {
  return (
    values[METADATA.managed] === "true" &&
    values[METADATA.provider] === CUBESANDBOX_PROVIDER_ID &&
    values[METADATA.workload] === "tool-sandbox" &&
    values[METADATA.activationId] === activationId &&
    values[METADATA.tenantId] === assignment.tenantId &&
    values[METADATA.projectId] === assignment.projectId &&
    values[METADATA.workspaceId] === assignment.workspaceId &&
    values[METADATA.sessionId] === assignment.sessionId
  );
}

function assignmentFromMetadata(
  instance: CubeSandboxInstance,
): (ToolSandboxAssignment & { activationId: string }) | undefined {
  const values = instance.metadata;
  if (
    values[METADATA.managed] !== "true" ||
    values[METADATA.provider] !== CUBESANDBOX_PROVIDER_ID ||
    values[METADATA.workload] !== "tool-sandbox"
  ) {
    return undefined;
  }
  const fencingToken = Number(values[METADATA.fencingToken]);
  const required = [
    METADATA.activationId,
    METADATA.tenantId,
    METADATA.projectId,
    METADATA.workspaceId,
    METADATA.supervisorId,
    METADATA.bootId,
    METADATA.sandboxId,
    METADATA.commandId,
    METADATA.sessionId,
    METADATA.turnId,
    METADATA.attemptId,
    METADATA.leaseId,
  ] as const;
  if (
    required.some((key) => typeof values[key] !== "string" || values[key]!.length < 1) ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1
  ) {
    throw new SandboxManagerError(
      "cubesandbox_inventory_invalid",
      "CubeSandbox managed metadata was invalid",
      false,
    );
  }
  return {
    activationId: values[METADATA.activationId]!,
    tenantId: values[METADATA.tenantId]!,
    projectId: values[METADATA.projectId]!,
    workspaceId: values[METADATA.workspaceId]!,
    supervisorId: values[METADATA.supervisorId]!,
    bootId: values[METADATA.bootId]!,
    sandboxId: values[METADATA.sandboxId]!,
    commandId: values[METADATA.commandId]!,
    sessionId: values[METADATA.sessionId]!,
    turnId: values[METADATA.turnId]!,
    attemptId: values[METADATA.attemptId]!,
    leaseId: values[METADATA.leaseId]!,
    fencingToken,
  };
}

function runtimeUuid(sandboxId: string): string {
  const bytes = createHash("sha256")
    .update(`agentdock:cubesandbox:${sandboxId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function supervisorAssignment(
  instance: CubeSandboxInstance,
  assignment: ToolSandboxAssignment,
): SupervisorRuntimeAssignment {
  return {
    containerId: runtimeUuid(instance.sandboxId),
    containerName: bounded(instance.sandboxId, "CubeSandbox runtime name", 128),
    supervisorId: assignment.supervisorId,
    bootId: assignment.bootId,
    sandboxId: assignment.sandboxId,
    commandId: assignment.commandId,
    sessionId: assignment.sessionId,
    turnId: assignment.turnId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
  };
}

function sameRuntimeAssignment(
  instance: CubeSandboxInstance,
  assignment: ToolSandboxAssignment,
  expected: SupervisorRuntimeAssignment,
): boolean {
  const actual = supervisorAssignment(instance, assignment);
  return (
    actual.containerId === expected.containerId &&
    actual.containerName === expected.containerName &&
    actual.supervisorId === expected.supervisorId &&
    actual.bootId === expected.bootId &&
    actual.sandboxId === expected.sandboxId &&
    actual.commandId === expected.commandId &&
    actual.sessionId === expected.sessionId &&
    actual.turnId === expected.turnId &&
    actual.leaseId === expected.leaseId &&
    actual.fencingToken === expected.fencingToken
  );
}

function effectiveIsolation(
  evidence: CubeRuntimeEvidence,
  policy: SandboxPolicy,
): SandboxEffectiveIsolation {
  return {
    isolationBoundary: "microvm",
    runtime: CUBESANDBOX_RUNTIME_NAME,
    user: `${evidence.uid}:${evidence.gid}`,
    privileged: false,
    readOnlyRootFilesystem: evidence.readOnlyRootFilesystem,
    networkMode: "public_web_proxy_private_denied",
    mountCount: 0,
    hasDockerSocket: false,
    pidLimit: policy.resources.pids,
    processLimit: policy.resources.pids,
    memoryBytes: evidence.memoryBytes,
    cpuNano: evidence.cpuCount * 1_000_000_000,
    droppedCapabilities: evidence.effectiveCapabilities === "0000000000000000" ? ["ALL"] : [],
    securityOptions: evidence.noNewPrivileges ? ["no-new-privileges"] : [],
    sandboxKernelRelease: evidence.kernelRelease,
  };
}

export class CubeSandboxProvider implements SandboxProvider {
  readonly providerId = CUBESANDBOX_PROVIDER_ID;
  readonly defaultPolicy = CUBESANDBOX_TOOL_POLICY;
  readonly supportsWarmRebind = true;
  readonly #templateId: string;
  readonly #imageRevision: string;
  readonly #client: CubeSandboxRuntimeClient;
  readonly #readyTimeoutMs: number;
  readonly #importGitHub: CubeSandboxProviderOptions["importGitHub"];
  readonly #checkImporter: (() => Promise<void>) | undefined;
  readonly #closeImporter: (() => Promise<void>) | undefined;
  readonly #bootstrapProvider: SandboxProvider | undefined;
  readonly #webProxy: ToolWebProxyBootstrap;
  readonly #activations = new Map<string, CubeActivation>();
  #runtimeProbe: Promise<void> | undefined;

  constructor(options: CubeSandboxProviderOptions) {
    this.#templateId = bounded(options.templateId, "CubeSandbox template ID", 256);
    this.#imageRevision = bounded(options.imageRevision, "CubeSandbox image revision", 128);
    this.#readyTimeoutMs = positiveInteger(options.readyTimeoutMs, READY_TIMEOUT_MS, 300_000);
    this.#importGitHub = options.importGitHub;
    this.#checkImporter = options.checkImporter;
    this.#closeImporter = options.closeImporter;
    this.#bootstrapProvider = options.bootstrapProvider;
    if (
      !isIPv4(options.webProxy.host) ||
      !Number.isSafeInteger(options.webProxy.port) ||
      options.webProxy.port < 1 ||
      options.webProxy.port > 65_535
    ) {
      throw new TypeError("CubeSandbox web proxy configuration is invalid");
    }
    this.#webProxy = Object.freeze({ ...options.webProxy });
    if (options.runtimeClient !== undefined) {
      this.#client = options.runtimeClient;
    } else {
      if (options.runtime === undefined) {
        throw new TypeError("CubeSandbox runtime configuration is missing");
      }
      this.#client = new OfficialCubeSandboxRuntimeClient(options.runtime);
    }
  }

  async checkHealth(): Promise<void> {
    await Promise.all([this.#client.checkHealth(), this.#checkImporter?.()]);
    this.#runtimeProbe ??= this.#probeRuntime();
    try {
      await this.#runtimeProbe;
    } catch (error: unknown) {
      this.#runtimeProbe = undefined;
      throw error;
    }
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    if (this.#activations.has(spec.activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "CubeSandbox activation identity collided",
        false,
      );
    }
    if (
      spec.policy.network.mode !== "public_web_proxy_private_denied" ||
      spec.policy.allowHostMounts ||
      spec.policy.allowDockerSocket ||
      spec.policy.privileged
    ) {
      throw new SandboxManagerError(
        "cubesandbox_policy_unsupported",
        "CubeSandbox Provider does not support the requested policy",
        false,
      );
    }
    let workspaceRestore = spec.workspaceRestore;
    let offlineSetupCommands: EnvironmentToolchainReport["recipeCommands"] | undefined;
    if (spec.environment.recipe.dependencyHosts !== undefined) {
      if (this.#bootstrapProvider === undefined) {
        throw new SandboxManagerError(
          "cubesandbox_dependency_bootstrap_unavailable",
          "CubeSandbox dependency bootstrap was unavailable",
          false,
        );
      }
      let bootstrapHandle: SandboxHandle | undefined;
      try {
        bootstrapHandle = await this.#bootstrapProvider.create(spec);
        const captured = await this.#bootstrapProvider.snapshot(bootstrapHandle, randomUUID());
        if (captured.type !== "tool_sandbox.captured") {
          throw new SandboxManagerError(
            "cubesandbox_dependency_bootstrap_failed",
            "Dependency bootstrap did not produce a Workspace",
            false,
          );
        }
        workspaceRestore = captured.workspace;
        offlineSetupCommands = captured.environment.recipeCommands.filter(
          (command) => command.phase === "setup",
        );
      } finally {
        if (bootstrapHandle !== undefined) {
          await this.#bootstrapProvider.destroy(bootstrapHandle).catch(() => undefined);
        }
      }
    }
    const bindingSha256 = physicalBindingSha256(
      spec.activationId,
      spec.assignment,
      spec.environment,
    );
    const authoritySecret = handoffSecret();
    const instance = await this.#client.create({
      templateId: this.#templateId,
      timeoutSeconds: Math.ceil(spec.policy.resources.turnWallClockTimeoutMs / 1_000),
      metadata: assignmentMetadata(
        spec.activationId,
        spec.assignment,
        this.#imageRevision,
        bindingSha256,
      ),
      allowInternetAccess: true,
      allowPublicTraffic: false,
    });
    try {
      const evidence = await this.#waitForEvidence(instance);
      this.#assertEvidence(evidence, spec.policy);
      const toolchain = parseEnvironmentToolchainReport(
        await this.#client.request(instance, {
          method: "POST",
          path: "/v1/initialize",
          body: {
            toolWorkerProtocolVersion: 1,
            type: "worker.initialize",
            activationId: spec.activationId,
            environment: spec.environment,
            workspaceSeed: spec.workspaceSeed,
            ...(workspaceRestore === undefined ? {} : { workspaceRestore }),
            webProxy: this.#webProxy,
            ...(offlineSetupCommands === undefined
              ? {}
              : {
                  environmentStage: {
                    type: "offline_restore",
                    setupCommands: offlineSetupCommands,
                  },
                }),
          },
          timeoutMs: this.#readyTimeoutMs,
          maximumResponseBytes: 1 * 1_024 * 1_024,
          authority: {
            handoffSecret: authoritySecret,
            fencingToken: spec.assignment.fencingToken,
            bindingSha256,
          },
        }),
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
          "CubeSandbox environment did not match the accepted Run",
          false,
        );
      }
      const environmentValidation: EnvironmentValidationReport = {
        ...toolchain,
        isolationBoundary: "microvm",
        runtime: CUBESANDBOX_RUNTIME_NAME,
        networkMode: "public_web_proxy_private_denied",
        runAsUser: "1000:1000",
        readOnlyRootFilesystem: false,
      };
      const handle: SandboxHandle = Object.freeze({
        providerApiVersion: 1,
        providerId: this.providerId,
        activationId: spec.activationId,
        runtimeId: runtimeUuid(instance.sandboxId),
        runtimeName: bounded(instance.sandboxId, "CubeSandbox runtime name", 128),
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      });
      this.#activations.set(spec.activationId, {
        instance,
        handle,
        evidence,
        toolchain,
        seenOperationIds: new Set(),
        seenCaptureIds: new Set(),
        bindingSha256,
        handoffSecret: authoritySecret,
        state: "running",
      });
      return handle;
    } catch (error: unknown) {
      await this.#client.destroy(instance.sandboxId).catch(() => undefined);
      throw error;
    }
  }

  async suspendForWarm(handle: SandboxHandle): Promise<SandboxHandle> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running") {
      throw new SandboxManagerError(
        "cubesandbox_handoff_state_invalid",
        "CubeSandbox was not running before warm suspension",
        true,
      );
    }
    try {
      const sealed = record(
        await this.#client.request(activation.instance, {
          method: "POST",
          path: "/v1/seal",
          body: {},
          timeoutMs: this.#readyTimeoutMs,
          maximumResponseBytes: 64 * 1_024,
          authority: this.#authority(activation),
        }),
        "CubeSandbox seal",
      );
      if (
        sealed.sealed !== true ||
        sealed.fencingToken !== handle.assignment.fencingToken ||
        sealed.remainingToolProcesses !== 0
      ) {
        throw new SandboxManagerError(
          "cubesandbox_seal_invalid",
          "CubeSandbox did not prove a sealed Tool boundary",
          false,
        );
      }
      activation.state = "sealed";
      activation.instance = await this.#client.pause(activation.instance, this.#readyTimeoutMs);
      activation.state = "paused";
      return handle;
    } catch (error: unknown) {
      await this.#client.destroy(activation.instance.sandboxId).catch(() => undefined);
      this.#activations.delete(handle.activationId);
      throw new SandboxManagerError(
        "cubesandbox_suspend_failed",
        "CubeSandbox warm suspension failed and the VM was destroyed",
        true,
      );
    }
  }

  async rebind(handle: SandboxHandle, assignment: ToolSandboxAssignment): Promise<SandboxHandle> {
    this.#assertHandle(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.state !== "paused" ||
      assignment.tenantId !== handle.assignment.tenantId ||
      assignment.projectId !== handle.assignment.projectId ||
      assignment.workspaceId !== handle.assignment.workspaceId ||
      assignment.sessionId !== handle.assignment.sessionId ||
      assignment.fencingToken <= handle.assignment.fencingToken
    ) {
      throw new SandboxManagerError(
        "cubesandbox_rebind_identity_invalid",
        "CubeSandbox warm rebind identity was invalid",
        false,
      );
    }
    const nextSecret = handoffSecret();
    try {
      const connected = await this.#client.connect(
        activation.instance,
        Math.ceil(this.defaultPolicy.resources.turnWallClockTimeoutMs / 1_000),
      );
      const response = record(
        await this.#client.request(connected, {
          method: "POST",
          path: "/v1/rebind",
          body: {
            handoffSecret: nextSecret,
            fencingToken: assignment.fencingToken,
            bindingSha256: activation.bindingSha256,
          },
          timeoutMs: this.#readyTimeoutMs,
          maximumResponseBytes: 1 * 1_024 * 1_024,
          authority: this.#authority(activation),
        }),
        "CubeSandbox rebind",
      );
      if (response.rebound !== true || response.fencingToken !== assignment.fencingToken) {
        throw new SandboxManagerError(
          "cubesandbox_rebind_invalid",
          "CubeSandbox warm rebind did not acknowledge the new fence",
          false,
        );
      }
      const toolchain = parseEnvironmentToolchainReport(response.environment);
      if (
        toolchain.profileKey !== handle.environment.profileKey ||
        toolchain.profileVersion !== handle.environment.profileVersion ||
        toolchain.imageRevision !== handle.environment.imageRevision ||
        toolchain.specSha256 !== handle.environment.specSha256 ||
        toolchain.recipeSha256 !== handle.environment.recipeSha256
      ) {
        throw new SandboxManagerError(
          "cubesandbox_rebind_environment_mismatch",
          "CubeSandbox preserved environment did not match",
          false,
        );
      }
      const rebound: SandboxHandle = Object.freeze({ ...handle, assignment });
      activation.instance = connected;
      activation.handle = rebound;
      activation.handoffSecret = nextSecret;
      activation.toolchain = toolchain;
      activation.state = "running";
      activation.seenOperationIds.clear();
      activation.seenCaptureIds.clear();
      return rebound;
    } catch (error: unknown) {
      await this.#client.destroy(activation.instance.sandboxId).catch(() => undefined);
      this.#activations.delete(handle.activationId);
      throw new SandboxManagerError(
        "cubesandbox_rebind_failed",
        "CubeSandbox warm rebind failed and requires a cold restore",
        true,
      );
    }
  }

  async exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = await this.#owned(handle);
    if (request.activationId !== handle.activationId) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool operation activation identity did not match",
        false,
      );
    }
    if (activation.seenOperationIds.has(request.operationId)) {
      throw new SandboxManagerError(
        "tool_operation_replay",
        "Tool operation ID was already used",
        false,
      );
    }
    activation.seenOperationIds.add(request.operationId);
    const cancel = (): void => {
      void this.#client
        .request(activation.instance, {
          method: "POST",
          path: "/v1/cancel",
          body: {
            activationId: handle.activationId,
            operationId: request.operationId,
          },
          timeoutMs: 5_000,
          maximumResponseBytes: 64 * 1_024,
          authority: this.#authority(activation),
        })
        .catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const timeoutMs =
        request.operation === "bash.exec" ? request.timeoutMs + 5_000 : this.#readyTimeoutMs;
      const result = await this.#client.request(activation.instance, {
        method: "POST",
        path: "/v1/operation",
        body: request,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
        maximumResponseBytes: TOOL_RESPONSE_LIMIT_BYTES,
        authority: this.#authority(activation),
      });
      return parseToolSandboxOperationResponse(result);
    } catch (error: unknown) {
      // A disconnected remote command has an unknowable execution result.
      // Destroying the disposable VM prevents it from continuing behind a
      // newer Attempt and is safer than replaying arbitrary Bash.
      await this.#client.destroy(activation.instance.sandboxId).catch(() => undefined);
      this.#activations.delete(handle.activationId);
      throw new SandboxManagerError(
        signal?.aborted ? "tool_cancelled" : "cubesandbox_tool_result_unknown",
        signal?.aborted
          ? "Tool command was cancelled"
          : "CubeSandbox Tool command result was unknown; the VM was destroyed",
        signal?.aborted === true,
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
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
        "cubesandbox_protocol_error",
        "CubeSandbox returned the wrong file operation",
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
        "cubesandbox_protocol_error",
        "CubeSandbox returned the wrong file operation",
        false,
      );
    }
  }

  async snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse> {
    const activation = await this.#owned(handle);
    if (activation.seenCaptureIds.has(requestId)) {
      throw new SandboxManagerError(
        "tool_capture_replay",
        "Tool capture ID was already used",
        false,
      );
    }
    activation.seenCaptureIds.add(requestId);
    const raw = record(
      await this.#client.request(activation.instance, {
        method: "POST",
        path: "/v1/capture",
        body: { activationId: handle.activationId, requestId },
        timeoutMs: this.#readyTimeoutMs,
        maximumResponseBytes: TOOL_RESPONSE_LIMIT_BYTES,
        authority: this.#authority(activation),
      }),
      "CubeSandbox capture",
    );
    const parsed = parseSandboxManagerResponse({
      ...raw,
      environment: handle.environmentValidation,
    });
    if (parsed.type !== "tool_sandbox.captured") {
      throw new SandboxManagerError(
        "cubesandbox_protocol_error",
        "CubeSandbox returned the wrong capture response",
        false,
      );
    }
    return parsed;
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await this.destroy(handle);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.#assertHandle(handle);
    const instance = await this.#client.read(handle.runtimeName);
    if (instance === undefined) {
      this.#activations.delete(handle.activationId);
      return;
    }
    if (
      runtimeUuid(instance.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        instance.metadata,
        handle.activationId,
        handle.assignment,
        physicalBindingSha256(handle.activationId, handle.assignment, handle.environment),
      )
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle identity did not match",
        false,
      );
    }
    await this.#client.destroy(instance.sandboxId);
    this.#activations.delete(handle.activationId);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspection> {
    this.#assertHandle(handle);
    const instance = await this.#client.read(handle.runtimeName);
    if (instance === undefined) {
      return {
        providerApiVersion: 1,
        providerId: this.providerId,
        state: "absent",
        handle,
      };
    }
    if (
      runtimeUuid(instance.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        instance.metadata,
        handle.activationId,
        handle.assignment,
        physicalBindingSha256(handle.activationId, handle.assignment, handle.environment),
      )
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox inspection identity did not match",
        false,
      );
    }
    const activation = this.#activations.get(handle.activationId);
    const evidence = activation?.evidence ?? (await this.#waitForEvidence(instance));
    return {
      providerApiVersion: 1,
      providerId: this.providerId,
      state: instance.state === "running" ? "running" : "stopped",
      handle,
      effectiveIsolation: effectiveIsolation(evidence, this.defaultPolicy),
    };
  }

  async destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#activations.get(activationId);
    if (activation !== undefined) {
      if (!sameAssignment(activation.handle.assignment, assignment)) {
        throw new SandboxManagerError(
          "tool_sandbox_identity_mismatch",
          "CubeSandbox assignment identity did not match",
          false,
        );
      }
      await this.destroy(activation.handle);
      return;
    }
    const matches = (await this.#client.list()).filter((instance) =>
      metadataMatchesOrphanIdentity(instance.metadata, activationId, assignment),
    );
    if (matches.length > 1) {
      throw new SandboxManagerError(
        "cubesandbox_inventory_ambiguous",
        "CubeSandbox activation inventory was ambiguous",
        false,
      );
    }
    if (matches[0] !== undefined) await this.#client.destroy(matches[0].sandboxId);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    bounded(sandboxId, "Sandbox inventory ID", 512);
    const output: SupervisorRuntimeAssignment[] = [];
    for (const instance of await this.#client.list()) {
      const managed = [...this.#activations.values()].find(
        (activation) => activation.instance.sandboxId === instance.sandboxId,
      );
      const assignment = managed?.handle.assignment ?? assignmentFromMetadata(instance);
      if (assignment !== undefined && assignment.sandboxId === sandboxId) {
        output.push(supervisorAssignment(instance, assignment));
      }
    }
    return output;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const instance = await this.#client.read(assignment.containerName);
    if (instance === undefined) return;
    const managed = [...this.#activations.values()].find(
      (activation) => activation.instance.sandboxId === instance.sandboxId,
    );
    const current = managed?.handle.assignment ?? assignmentFromMetadata(instance);
    if (current === undefined || !sameRuntimeAssignment(instance, current, assignment)) {
      throw new SandboxManagerError(
        "cubesandbox_assignment_identity_mismatch",
        "CubeSandbox termination identity did not match",
        false,
      );
    }
    await this.#client.destroy(instance.sandboxId);
    for (const [activationId, active] of this.#activations) {
      if (active.instance.sandboxId === instance.sandboxId) {
        this.#activations.delete(activationId);
      }
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const instance = await this.#client.read(assignment.containerName);
    if (instance !== undefined && runtimeUuid(instance.sandboxId) === assignment.containerId) {
      throw new SandboxManagerError(
        "cubesandbox_assignment_still_alive",
        "CubeSandbox absence could not be confirmed",
        false,
      );
    }
  }

  importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    return this.#importGitHub(source, signal);
  }

  async close(): Promise<void> {
    const instances = [...this.#activations.values()].map((activation) => activation.instance);
    this.#activations.clear();
    await Promise.allSettled(instances.map((instance) => this.#client.destroy(instance.sandboxId)));
    await Promise.all([this.#client.close(), this.#closeImporter?.()]);
  }

  async #probeRuntime(): Promise<void> {
    const instance = await this.#client.create({
      templateId: this.#templateId,
      timeoutSeconds: 60,
      metadata: {
        [METADATA.managed]: "true",
        [METADATA.provider]: this.providerId,
        [METADATA.workload]: "runtime-probe",
        [METADATA.imageRevision]: this.#imageRevision,
      },
      allowInternetAccess: true,
      allowPublicTraffic: false,
    });
    try {
      this.#assertEvidence(await this.#waitForEvidence(instance), this.defaultPolicy);
    } finally {
      await this.#client.destroy(instance.sandboxId);
    }
  }

  async #waitForEvidence(instance: CubeSandboxInstance): Promise<CubeRuntimeEvidence> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return parseEvidence(
          await this.#client.request(instance, {
            method: "GET",
            path: "/v1/evidence",
            timeoutMs: Math.min(5_000, this.#readyTimeoutMs),
            maximumResponseBytes: 64 * 1_024,
          }),
        );
      } catch (error: unknown) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    void lastError;
    throw new SandboxManagerError(
      "cubesandbox_data_plane_unavailable",
      "CubeSandbox Tool data plane did not become ready",
      true,
    );
  }

  #assertEvidence(evidence: CubeRuntimeEvidence, policy: SandboxPolicy): void {
    if (
      evidence.imageRevision !== this.#imageRevision ||
      evidence.uid !== 1_000 ||
      evidence.gid !== 1_000 ||
      evidence.supervisorUid !== 0 ||
      evidence.supervisorGid !== 0 ||
      evidence.cpuCount * 1_000_000_000 < policy.resources.cpuNano ||
      evidence.memoryBytes < Math.floor(policy.resources.memoryBytes * 0.9) ||
      !evidence.hypervisorFlag ||
      !evidence.noNewPrivileges ||
      !/^0+$/.test(evidence.effectiveCapabilities) ||
      evidence.readOnlyRootFilesystem
    ) {
      throw new SandboxManagerError(
        "cubesandbox_isolation_mismatch",
        "CubeSandbox runtime evidence did not satisfy the required policy",
        false,
      );
    }
  }

  async #owned(handle: SandboxHandle): Promise<CubeActivation> {
    this.#assertHandle(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.handle.runtimeName !== handle.runtimeName ||
      !sameAssignment(activation.handle.assignment, handle.assignment)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle identity did not match",
        false,
      );
    }
    const current = await this.#client.read(handle.runtimeName);
    if (
      current === undefined ||
      runtimeUuid(current.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        current.metadata,
        handle.activationId,
        handle.assignment,
        activation.bindingSha256,
      )
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox runtime identity did not match",
        false,
      );
    }
    return activation;
  }

  #authority(
    activation: CubeActivation,
  ): NonNullable<Parameters<CubeSandboxRuntimeClient["request"]>[1]["authority"]> {
    return {
      handoffSecret: activation.handoffSecret,
      fencingToken: activation.handle.assignment.fencingToken,
      bindingSha256: activation.bindingSha256,
    };
  }

  #assertHandle(handle: SandboxHandle): void {
    if (
      handle.providerApiVersion !== 1 ||
      handle.providerId !== this.providerId ||
      handle.workspaceRoot !== "/workspace" ||
      handle.runtimeId !== runtimeUuid(handle.runtimeName)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle shape did not match",
        false,
      );
    }
  }
}

export { CUBESANDBOX_TOOL_SERVICE_PORT };
