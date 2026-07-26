import type {
  AgentWorkspaceSeed,
  EnvironmentRuntimeSnapshot,
  EnvironmentValidationReport,
  GitHubRepositorySource,
  SandboxCheckpointBlob,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
} from "@agent-dock/protocol";

export const SANDBOX_PROVIDER_API_VERSION = 1 as const;

export class SandboxManagerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SandboxManagerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type SandboxNetworkPolicy =
  | Readonly<{ mode: "deny_all" }>
  | Readonly<{ mode: "public_egress_private_denied" }>
  | Readonly<{ mode: "github" }>
  | Readonly<{
      mode: "package_registries";
      ecosystems: readonly ("maven" | "npm" | "pypi")[];
    }>
  | Readonly<{ mode: "explicit_hosts"; hosts: readonly string[] }>;

export type SandboxResourceLimits = Readonly<{
  cpuNano: number;
  memoryBytes: number;
  pids: number;
  openFiles: number;
  temporaryBytes: number;
  workspaceBytes: number;
  maximumOutputBytes: number;
  maximumCommandTimeoutMs: number;
  turnWallClockTimeoutMs: number;
}>;

export type SandboxPolicy = Readonly<{
  policyVersion: 1;
  network: SandboxNetworkPolicy;
  resources: SandboxResourceLimits;
  user: "1000:1000";
  readOnlyRootFilesystem: boolean;
  privileged: boolean;
  dropAllCapabilities: boolean;
  noNewPrivileges: boolean;
  allowHostMounts: boolean;
  allowDockerSocket: boolean;
}>;

export const DEFAULT_TOOL_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  policyVersion: 1,
  network: Object.freeze({ mode: "deny_all" }),
  resources: Object.freeze({
    cpuNano: 1_000_000_000,
    memoryBytes: 768 * 1_024 * 1_024,
    pids: 128,
    openFiles: 1_024,
    temporaryBytes: 64 * 1_024 * 1_024,
    workspaceBytes: 128 * 1_024 * 1_024,
    maximumOutputBytes: 1 * 1_024 * 1_024,
    maximumCommandTimeoutMs: 300_000,
    turnWallClockTimeoutMs: 900_000,
  }),
  user: "1000:1000",
  readOnlyRootFilesystem: true,
  privileged: false,
  dropAllCapabilities: true,
  noNewPrivileges: true,
  allowHostMounts: false,
  allowDockerSocket: false,
});

export type SandboxCreateSpec = Readonly<{
  activationId: string;
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  workspaceSeed: AgentWorkspaceSeed;
  workspaceRestore?: SandboxCheckpointBlob;
  policy: SandboxPolicy;
}>;

export type SandboxHandle = Readonly<{
  providerApiVersion: 1;
  providerId: string;
  activationId: string;
  runtimeId: string;
  runtimeName: string;
  workspaceRoot: "/workspace";
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  environmentValidation: EnvironmentValidationReport;
}>;

type SandboxRuntimeIsolation =
  | Readonly<{ isolationBoundary: "gvisor"; runtime: "runsc" }>
  | Readonly<{ isolationBoundary: "microvm"; runtime: "cubesandbox-kvm" }>;

export type SandboxEffectiveIsolation = SandboxRuntimeIsolation &
  Readonly<{
    user: string;
    privileged: boolean;
    readOnlyRootFilesystem: boolean;
    networkMode: string;
    mountCount: number;
    hasDockerSocket: boolean;
    pidLimit: number | null;
    processLimit: number | null;
    memoryBytes: number | null;
    cpuNano: number | null;
    droppedCapabilities: readonly string[];
    securityOptions: readonly string[];
    sandboxKernelRelease?: string;
  }>;

export type SandboxInspection =
  | Readonly<{
      providerApiVersion: 1;
      providerId: string;
      state: "absent";
      handle: SandboxHandle;
    }>
  | Readonly<{
      providerApiVersion: 1;
      providerId: string;
      state: "running" | "stopped";
      handle: SandboxHandle;
      effectiveIsolation: SandboxEffectiveIsolation;
    }>;

export type SandboxReadFileInput = Readonly<{
  operationId: string;
  path: string;
}>;

export type SandboxWriteFileInput = Readonly<{
  operationId: string;
  path: string;
  content: string;
}>;

/**
 * Provider-neutral execution contract owned by the trusted Sandbox Manager.
 * Implementations must not expose their native SDK/client objects through a
 * handle or require the Agent Runner to know provider-specific arguments.
 */
export interface SandboxProvider {
  readonly providerId: string;
  readonly cleanPrewarmCount?: number;
  /** Provider-specific policy selected only by trusted deployment config. */
  readonly defaultPolicy?: SandboxPolicy;
  /**
   * False when the runtime cannot atomically rebind persisted assignment
   * metadata to a higher fencing token. Such Providers are destroyed at the
   * Run boundary instead of entering the exact-Session warm pool.
   */
  readonly supportsWarmRebind?: boolean;

  checkHealth(): Promise<void>;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  /**
   * Quiesce a runtime before it enters the exact-Session warm pool. Providers
   * that do not need a physical suspend may omit this hook.
   */
  suspendForWarm?(handle: SandboxHandle): Promise<SandboxHandle>;
  rebind(handle: SandboxHandle, assignment: ToolSandboxAssignment): Promise<SandboxHandle>;
  exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse>;
  readFile(
    handle: SandboxHandle,
    input: SandboxReadFileInput,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  writeFile(
    handle: SandboxHandle,
    input: SandboxWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void>;
  snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse>;
  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxInspection>;

  /** Used only when the Manager restarted before it could reconstruct a handle. */
  destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;

  listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]>;
  terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
  confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
  importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
