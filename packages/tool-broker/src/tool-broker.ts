import type {
  AgentWorkspaceSeed,
  DevelopmentEnvironmentBrokerResponse,
  DevelopmentEnvironmentLifecycleRequest,
  DevelopmentEnvironmentProvisionRequest,
  DevelopmentEnvironmentTerminalOpenRequest,
  EnvironmentRuntimeSnapshot,
  GitHubRepositorySource,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxCreateRequest,
  ToolSandboxCreateResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
  ToolSandboxReleaseRequest,
  ToolSandboxReleaseResponse,
  ToolBrokerMaterializeFileRequest,
  ToolBrokerMaterializeFileResponse,
  ToolBrokerWorkspaceForkRequest,
  ToolBrokerWorkspaceForkResponse,
  CloudToolName,
} from "@pi-cloud/protocol";
import { parseCloudToolCapabilitySnapshot } from "@pi-cloud/protocol";
import {
  canonicalEnvironmentRecipeJson,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@pi-cloud/protocol";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_TOOL_SANDBOX_POLICY,
  ToolBrokerError,
  type SandboxHandle,
  type SandboxInspection,
  type SandboxProvider,
  type SandboxTerminalSession,
  type SandboxTerminalSize,
} from "./sandbox-provider.ts";
import {
  InMemorySandboxActivationStateRepository,
  type SandboxActivationReservation,
  type SandboxActivationStateRepository,
  type DevelopmentEnvironmentReservation,
} from "./activation-state-repository.ts";

export type ToolBrokerOptions = {
  provider: SandboxProvider;
  ownerBaseUrl?: string;
  stateRepository?: SandboxActivationStateRepository;
  idGenerator?: () => string;
  capabilityGenerator?: () => string;
  maximumActiveSandboxes?: number;
  warmTtlMs?: number;
  maximumWarmActivations?: number;
  clock?: () => number;
  imageRevision?: string;
};

export class ToolBrokerOwnerRedirectError extends Error {
  readonly ownerBaseUrl: string;

  constructor(ownerBaseUrl: string) {
    super("Tool Sandbox activation is owned by another Tool Broker replica");
    this.name = "ToolBrokerOwnerRedirectError";
    this.ownerBaseUrl = ownerBaseUrl;
  }
}

type ManagedActivation = {
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  attemptContextSha256: string;
  currentStep?: Readonly<{ sequence: number; sha256: string }>;
  capabilityDigest: Buffer;
  allowedTools: ReadonlySet<CloudToolName>;
  spec: Parameters<SandboxProvider["create"]>[0];
  reservation: SandboxActivationReservation;
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  materializedForCurrentAssignment: boolean;
  activeOperations: number;
  exclusiveOperation: boolean;
  operations: Map<
    string,
    Readonly<{ requestSha256: string; result: Promise<ToolSandboxOperationResponse> }>
  >;
  seenCaptureIds: Set<string>;
};

type WarmActivation = {
  handle: SandboxHandle;
  workspaceRevision: string;
  environment: EnvironmentRuntimeSnapshot;
  retention: "ephemeral" | "persistent";
  expiresAt: number | null;
  lastUsedAt: number;
};

type SuspendedActivation = Readonly<{
  activation: ManagedActivation;
  reservation: SandboxActivationReservation;
}>;

export type WorkspaceTerminalOpenInput = Readonly<{
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  environment: EnvironmentRuntimeSnapshot;
  workspaceSeed: AgentWorkspaceSeed;
  size: SandboxTerminalSize;
}>;

export type WorkspaceTerminalConnection = Readonly<{
  terminalId: string;
  pid: number;
  output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: SandboxTerminalSize): Promise<void>;
  close(): Promise<void>;
}>;

type ManagedWorkspaceTerminal = {
  assignment: ToolSandboxAssignment;
  handle: SandboxHandle;
  session: SandboxTerminalSession;
  closing?: Promise<void>;
};

type ManagedDevelopmentEnvironment = {
  reservation: DevelopmentEnvironmentReservation;
  assignment: ToolSandboxAssignment;
  handle: SandboxHandle;
  terminal?: SandboxTerminalSession;
};

type AdmissionWaiter = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: ToolBrokerError) => void;
  abort?: () => void;
};

const DEFAULT_WARM_TTL_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_WARM_ACTIVATIONS = 4;
const DEFAULT_MAXIMUM_ACTIVE_SANDBOXES = 2;

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function workspaceKey(assignment: ToolSandboxAssignment): string {
  // One Workspace must have at most one active or warm process world. A second
  // Session may share its files, but it must not leave the first Session's
  // background processes alive as an independent writer.
  return [assignment.tenantId, assignment.projectId, assignment.workspaceId].join("\0");
}

function capabilityDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function operationFailureCode(error: unknown): string {
  return error instanceof ToolBrokerError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : "tool_broker_failed";
}

const TOOL_OPERATIONS: Readonly<Record<CloudToolName, ReadonlySet<string>>> = {
  read: new Set(["file.read", "file.read_range", "file.access"]),
  write: new Set(["file.write", "file.mkdir"]),
  edit: new Set(["file.read", "file.write", "file.access"]),
  bash: new Set(["bash.exec"]),
};

function sameEnvironment(
  left: EnvironmentRuntimeSnapshot,
  right: EnvironmentRuntimeSnapshot,
): boolean {
  return (
    left.environmentVersionId === right.environmentVersionId &&
    left.versionNumber === right.versionNumber &&
    left.profileKey === right.profileKey &&
    left.profileVersion === right.profileVersion &&
    left.imageRevision === right.imageRevision &&
    left.specSha256 === right.specSha256 &&
    left.recipeSha256 === right.recipeSha256 &&
    canonicalEnvironmentRecipeJson(left.recipe) === canonicalEnvironmentRecipeJson(right.recipe)
  );
}

function validCapability(value: string): string {
  if (!/^pcts_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("Tool Sandbox capability generator returned an invalid value");
  }
  return value;
}

function validActivationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("Tool Broker ID generator returned an invalid UUID");
  }
  return value;
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
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.fencingToken === right.fencingToken
  );
}

function handleMatches(
  handle: SandboxHandle,
  provider: SandboxProvider,
  activationId: string,
  assignment: ToolSandboxAssignment,
  environment: EnvironmentRuntimeSnapshot,
): boolean {
  return (
    handle.providerApiVersion === 1 &&
    handle.providerId === provider.providerId &&
    handle.activationId === activationId &&
    handle.workspaceRoot === "/workspace" &&
    /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(handle.runtimeName) &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(handle.runtimeId) &&
    sameAssignment(handle.assignment, assignment) &&
    sameEnvironment(handle.environment, environment) &&
    handle.environmentValidation.profileKey === environment.profileKey &&
    handle.environmentValidation.profileVersion === environment.profileVersion &&
    handle.environmentValidation.imageRevision === environment.imageRevision &&
    handle.environmentValidation.specSha256 === environment.specSha256 &&
    handle.environmentValidation.recipeSha256 === environment.recipeSha256
  );
}

function samePhysicalRuntime(
  handle: SandboxHandle,
  assignment: SupervisorRuntimeAssignment,
): boolean {
  return (
    handle.runtimeId === assignment.containerId &&
    handle.runtimeName === assignment.containerName &&
    handle.assignment.supervisorId === assignment.supervisorId &&
    handle.assignment.bootId === assignment.bootId &&
    handle.assignment.sandboxId === assignment.sandboxId
  );
}

function sameSupervisorAssignment(
  left: ToolSandboxAssignment,
  right: SupervisorRuntimeAssignment,
): boolean {
  return (
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

function terminalAssignment(
  terminalId: string,
  input: Pick<WorkspaceTerminalOpenInput, "tenantId" | "projectId" | "workspaceId" | "sessionId">,
): ToolSandboxAssignment {
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    supervisorId: "workspace-terminal",
    bootId: terminalId,
    sandboxId: terminalId,
    commandId: terminalId,
    sessionId: input.sessionId,
    turnId: terminalId,
    attemptId: terminalId,
    leaseId: terminalId,
    fencingToken: 1,
  };
}

function developmentEnvironmentAssignment(
  input: Pick<
    DevelopmentEnvironmentProvisionRequest,
    "environmentId" | "tenantId" | "projectId" | "workspaceId" | "generation"
  >,
): ToolSandboxAssignment {
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    supervisorId: "development-environment",
    bootId: input.environmentId,
    sandboxId: input.environmentId,
    commandId: input.environmentId,
    sessionId: input.environmentId,
    turnId: input.environmentId,
    attemptId: input.environmentId,
    leaseId: input.environmentId,
    fencingToken: input.generation,
  };
}

export class ToolBroker {
  readonly #provider: SandboxProvider;
  readonly #ownerBaseUrl: string;
  readonly #stateRepository: SandboxActivationStateRepository;
  readonly #idGenerator: () => string;
  readonly #capabilityGenerator: () => string;
  readonly #maximumActiveSandboxes: number;
  readonly #warmTtlMs: number;
  readonly #maximumWarmActivations: number;
  readonly #clock: () => number;
  readonly #imageRevision: string;
  readonly #activations = new Map<string, ManagedActivation>();
  readonly #warm = new Map<string, WarmActivation>();
  readonly #suspended = new Map<string, SuspendedActivation>();
  readonly #terminals = new Map<string, ManagedWorkspaceTerminal>();
  readonly #developmentEnvironments = new Map<string, ManagedDevelopmentEnvironment>();
  readonly #admitted = new Map<string, ToolSandboxAssignment>();
  readonly #admissionWaiters: AdmissionWaiter[] = [];
  readonly #reaper: NodeJS.Timeout;

  constructor(options: ToolBrokerOptions) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl ?? "http://tool-broker.invalid").toString();
    this.#stateRepository =
      options.stateRepository ?? new InMemorySandboxActivationStateRepository();
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#capabilityGenerator =
      options.capabilityGenerator ?? (() => `pcts_${randomBytes(32).toString("base64url")}`);
    this.#maximumActiveSandboxes = positiveInteger(
      options.maximumActiveSandboxes ?? DEFAULT_MAXIMUM_ACTIVE_SANDBOXES,
      "maximumActiveSandboxes",
      1_000,
    );
    this.#warmTtlMs = positiveInteger(
      options.warmTtlMs ?? DEFAULT_WARM_TTL_MS,
      "warmTtlMs",
      24 * 60 * 60_000,
    );
    this.#maximumWarmActivations = positiveInteger(
      options.maximumWarmActivations ?? DEFAULT_MAXIMUM_WARM_ACTIVATIONS,
      "maximumWarmActivations",
      1_000,
    );
    this.#clock = options.clock ?? Date.now;
    this.#imageRevision = options.imageRevision ?? "development";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#imageRevision)) {
      throw new TypeError("Tool Sandbox image revision is invalid");
    }
    this.#reaper = setInterval(
      () =>
        void Promise.all([
          this.reapWarm(),
          this.reapRetiredWarm(),
          this.#reapOrphanedActivations(),
          this.#reapTerminalRunActivations(),
          this.#reapOrphanedTerminals(),
          this.#reapOrphanedDevelopmentEnvironments(),
        ]).catch(() => undefined),
      30_000,
    );
    this.#reaper.unref();
  }

  get providerId(): string {
    return this.#provider.providerId;
  }

  get activeCount(): number {
    const activeHandles = [...this.#activations.values()].filter(
      (activation) => activation.handle !== undefined || activation.materializing !== undefined,
    ).length;
    return (
      activeHandles + this.#warm.size + this.#terminals.size + this.#developmentEnvironments.size
    );
  }

  get admittedCount(): number {
    return this.#admitted.size;
  }

  get admissionWaitingCount(): number {
    return this.#admissionWaiters.length;
  }

  get maximumActiveSandboxes(): number {
    return this.#maximumActiveSandboxes;
  }

  get reservedCount(): number {
    return this.#activations.size;
  }

  get warmCount(): number {
    return this.#warm.size;
  }

  get cleanPrewarmCount(): number {
    return this.#provider.cleanPrewarmCount ?? 0;
  }

  async checkHealth(): Promise<void> {
    await Promise.all([this.#provider.checkHealth(), this.#stateRepository.checkHealth()]);
  }

  async provisionDevelopmentEnvironment(
    request: DevelopmentEnvironmentProvisionRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    if (
      this.#provider.openTerminal === undefined ||
      this.#provider.pause === undefined ||
      this.#provider.resume === undefined
    ) {
      throw new ToolBrokerError(
        "development_environment_unsupported",
        "The configured Sandbox Provider does not support development environments",
        false,
      );
    }
    const existing = this.#developmentEnvironments.get(request.environmentId);
    if (existing !== undefined) {
      if (
        existing.reservation.tenantId !== request.tenantId ||
        existing.reservation.userId !== request.userId ||
        existing.reservation.workspaceId !== request.workspaceId ||
        existing.reservation.generation !== request.generation
      ) {
        throw new ToolBrokerError(
          "development_environment_identity_conflict",
          "Development environment identity was reused with different ownership",
          false,
        );
      }
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
      };
    }
    const reservation: DevelopmentEnvironmentReservation = {
      environmentId: request.environmentId,
      tenantId: request.tenantId,
      userId: request.userId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      environmentVersionId: request.environment.environmentVersionId,
      generation: request.generation,
    };
    const reserved = await this.#stateRepository.reserveDevelopmentEnvironment(reservation);
    if (reserved.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reserved.ownerBaseUrl);
    }
    if (reserved.status === "busy") {
      throw new ToolBrokerError(
        "development_environment_workspace_busy",
        "Workspace is already owned by another execution environment",
        true,
      );
    }
    if (reserved.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    if (reserved.status === "tenant_capacity") {
      throw new ToolBrokerError(
        "tenant_sandbox_capacity_exhausted",
        "Tenant has reached its active Sandbox limit",
        true,
      );
    }
    const assignment = developmentEnvironmentAssignment(request);
    let handle: SandboxHandle | undefined;
    let admitted = false;
    try {
      await this.#acquireAdmission(request.environmentId, assignment);
      admitted = true;
      handle = await this.#provider.create({
        activationId: request.environmentId,
        assignment,
        environment: request.environment,
        workspaceSeed: request.workspaceSeed,
        policy: this.#provider.defaultPolicy ?? DEFAULT_TOOL_SANDBOX_POLICY,
        lifetime: "development_environment",
      });
      if (
        !handleMatches(
          handle,
          this.#provider,
          request.environmentId,
          assignment,
          request.environment,
        )
      ) {
        throw new ToolBrokerError(
          "sandbox_provider_protocol_error",
          "Sandbox Provider returned a mismatched development environment handle",
          false,
        );
      }
      this.#developmentEnvironments.set(request.environmentId, {
        reservation,
        assignment,
        handle,
      });
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "running", {
        handle,
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
      };
    } catch (error: unknown) {
      if (handle !== undefined) await this.#provider.destroy(handle).catch(() => undefined);
      if (admitted) this.#releaseAdmission(request.environmentId);
      await this.#stateRepository
        .setDevelopmentEnvironmentState(request.environmentId, "failed", {
          failureCode: operationFailureCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async developmentEnvironmentLifecycle(
    request: DevelopmentEnvironmentLifecycleRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    const ownership = await this.#stateRepository.developmentEnvironmentOwner(
      request.tenantId,
      request.userId,
      request.environmentId,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(request.environmentId);
    if (ownership.status !== "owned" || environment === undefined) {
      throw new ToolBrokerError(
        "development_environment_unavailable",
        "Development environment is unavailable on its owning Tool Broker",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== request.tenantId ||
      environment.reservation.userId !== request.userId
    ) {
      throw new ToolBrokerError(
        "development_environment_unauthorized",
        "Development environment ownership did not match",
        false,
      );
    }
    if (request.action === "pause") {
      if (ownership.state !== "running" || environment.terminal !== undefined) {
        throw new ToolBrokerError(
          "development_environment_pause_conflict",
          "Close the active terminal before pausing the development environment",
          true,
        );
      }
      try {
        await this.#provider.pause!(environment.handle);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "paused", {
        handle: environment.handle,
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "paused",
      };
    }
    if (request.action === "resume") {
      if (ownership.state !== "paused") {
        throw new ToolBrokerError(
          "development_environment_resume_conflict",
          "Development environment is not paused",
          false,
        );
      }
      try {
        environment.handle = await this.#provider.resume!(environment.handle);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "running", {
        handle: environment.handle,
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
      };
    }
    await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "releasing");
    environment.terminal?.disconnect();
    await environment.terminal?.kill().catch(() => undefined);
    try {
      await this.#provider.destroy(environment.handle);
    } catch (error: unknown) {
      await this.#stateRepository
        .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
          failureCode: operationFailureCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
    this.#developmentEnvironments.delete(request.environmentId);
    this.#releaseAdmission(request.environmentId);
    await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "released");
    return {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.state",
      requestId: request.requestId,
      environmentId: request.environmentId,
      state: "released",
    };
  }

  async openDevelopmentEnvironmentTerminal(
    input: DevelopmentEnvironmentTerminalOpenRequest,
  ): Promise<WorkspaceTerminalConnection> {
    if (this.#provider.openTerminal === undefined) {
      throw new ToolBrokerError(
        "development_environment_terminal_unsupported",
        "The configured Sandbox Provider does not support interactive terminals",
        false,
      );
    }
    const ownership = await this.#stateRepository.developmentEnvironmentOwner(
      input.tenantId,
      input.userId,
      input.environmentId,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(input.environmentId);
    if (
      ownership.status !== "owned" ||
      ownership.state !== "running" ||
      environment === undefined
    ) {
      throw new ToolBrokerError(
        "development_environment_terminal_unavailable",
        "Development environment must be running before opening a terminal",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== input.tenantId ||
      environment.reservation.userId !== input.userId
    ) {
      throw new ToolBrokerError(
        "development_environment_unauthorized",
        "Development environment ownership did not match",
        false,
      );
    }
    if (environment.terminal !== undefined) {
      throw new ToolBrokerError(
        "development_environment_terminal_busy",
        "Development environment already has an active terminal",
        true,
      );
    }
    const terminal = await this.#provider.openTerminal(environment.handle, {
      rows: input.rows,
      cols: input.cols,
    });
    environment.terminal = terminal;
    let closed = false;
    return Object.freeze({
      terminalId: input.environmentId,
      pid: terminal.pid,
      output: terminal.output,
      sendInput: (data: Uint8Array) => terminal.sendInput(data),
      resize: (size: SandboxTerminalSize) => terminal.resize(size),
      close: async () => {
        if (closed) return;
        closed = true;
        terminal.disconnect();
        await terminal.kill().catch(() => undefined);
        if (environment.terminal === terminal) delete environment.terminal;
      },
    });
  }

  async openTerminal(input: WorkspaceTerminalOpenInput): Promise<WorkspaceTerminalConnection> {
    await Promise.all([
      this.reapWarm(),
      this.reapRetiredWarm(),
      this.#reapOrphanedActivations(),
      this.#reapTerminalRunActivations(),
      this.#reapOrphanedTerminals(),
    ]);
    if (this.#provider.openTerminal === undefined) {
      throw new ToolBrokerError(
        "workspace_terminal_unsupported",
        "The configured Sandbox Provider does not support interactive terminals",
        false,
      );
    }
    if (
      input.environment.profileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      input.environment.profileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      input.environment.specSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      input.environment.imageRevision !== this.#imageRevision ||
      createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(input.environment.recipe))
        .digest("hex") !== input.environment.recipeSha256
    ) {
      throw new ToolBrokerError(
        "environment_policy_mismatch",
        "Workspace environment is not served by this Tool Broker",
        false,
      );
    }
    const terminalId = validActivationId(this.#idGenerator());
    const assignment = terminalAssignment(terminalId, input);
    const reservation = await this.#stateRepository.reserveTerminal({
      terminalId,
      tenantId: input.tenantId,
      userId: input.userId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (reservation.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new ToolBrokerError(
        "workspace_terminal_busy",
        "Workspace is currently owned by an Agent or another terminal",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    if (reservation.status === "tenant_capacity") {
      throw new ToolBrokerError(
        "tenant_sandbox_capacity_exhausted",
        "Tenant has reached its active Sandbox limit",
        true,
      );
    }
    let admitted = false;
    let handle: SandboxHandle | undefined;
    let terminal: SandboxTerminalSession | undefined;
    try {
      if (reservation.retiredActivation !== undefined) {
        const retired = reservation.retiredActivation;
        const warmEntry = [...this.#warm.entries()].find(
          ([, warm]) => warm.handle.activationId === retired.activationId,
        );
        if (warmEntry === undefined) {
          await this.#provider.destroyActivation(retired.activationId, retired.assignment);
        } else {
          this.#warm.delete(warmEntry[0]);
          await this.#provider.stop(warmEntry[1].handle);
          this.#releaseAdmission(retired.activationId);
        }
        await this.#stateRepository.setActivationState(retired.activationId, "released");
      }
      await this.#stateRepository.setTerminalState(terminalId, "materializing");
      await this.#acquireAdmission(terminalId, assignment);
      admitted = true;
      handle = await this.#provider.create({
        activationId: terminalId,
        assignment,
        environment: input.environment,
        workspaceSeed: input.workspaceSeed,
        policy: this.#provider.defaultPolicy ?? DEFAULT_TOOL_SANDBOX_POLICY,
      });
      terminal = await this.#provider.openTerminal(handle, input.size);
      const activeTerminal = terminal;
      const managed: ManagedWorkspaceTerminal = { assignment, handle, session: activeTerminal };
      await this.#stateRepository.setTerminalState(terminalId, "active", { handle });
      this.#terminals.set(terminalId, managed);
      return Object.freeze({
        terminalId,
        pid: activeTerminal.pid,
        output: activeTerminal.output,
        sendInput: async (data: Uint8Array) => {
          this.#stateRepository.assertLocalOwnership();
          await activeTerminal.sendInput(data);
        },
        resize: async (size: SandboxTerminalSize) => {
          this.#stateRepository.assertLocalOwnership();
          await activeTerminal.resize(size);
        },
        close: () => this.#closeTerminal(terminalId, managed),
      });
    } catch (error: unknown) {
      this.#terminals.delete(terminalId);
      terminal?.disconnect();
      await terminal?.kill().catch(() => undefined);
      if (handle !== undefined) await this.#provider.destroy(handle).catch(() => undefined);
      if (admitted) this.#releaseAdmission(terminalId);
      await this.#stateRepository
        .setTerminalState(terminalId, "unknown", { failureCode: operationFailureCode(error) })
        .catch(() => undefined);
      throw error;
    }
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    await Promise.all([
      this.reapWarm(),
      this.reapRetiredWarm(),
      this.#reapOrphanedActivations(),
      this.#reapTerminalRunActivations(),
    ]);
    if (
      request.environment.profileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      request.environment.profileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      request.environment.specSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      request.environment.imageRevision !== this.#imageRevision ||
      createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(request.environment.recipe))
        .digest("hex") !== request.environment.recipeSha256
    ) {
      throw new ToolBrokerError(
        "environment_policy_mismatch",
        "Run environment is not served by this Tool Broker",
        false,
      );
    }
    const key = workspaceKey(request.assignment);
    const activeWorkspace = [...this.#activations.entries()].find(
      ([, entry]) => workspaceKey(entry.assignment) === key,
    );
    let delegatedParent: ManagedActivation | undefined;
    if (activeWorkspace !== undefined) {
      const [activeId, active] = activeWorkspace;
      const delegated = await this.#stateRepository.allowsDelegatedSandboxHandoff({
        tenantId: request.assignment.tenantId,
        workspaceId: request.assignment.workspaceId,
        currentSessionId: active.assignment.sessionId,
        nextSessionId: request.assignment.sessionId,
      });
      if (
        !delegated ||
        active.activeOperations !== 0 ||
        active.exclusiveOperation ||
        active.materializing !== undefined
      ) {
        throw new ToolBrokerError(
          "tool_sandbox_workspace_busy",
          "Workspace already has a Tool Sandbox reservation",
          true,
        );
      }
      if (active.handle !== undefined && active.materializedForCurrentAssignment) {
        await this.#provider.snapshot(active.handle, request.requestId);
        active.materializedForCurrentAssignment = false;
      }
      delegatedParent = active;
      this.#activations.delete(activeId);
      if (this.#admitted.has(activeId)) this.#admitted.set(activeId, request.assignment);
      this.#suspended.set(key, { activation: active, reservation: active.reservation });
    }

    let inherited = this.#warm.get(key);
    let crossSessionHandoffAllowed = false;
    if (
      inherited !== undefined &&
      inherited.handle.assignment.sessionId !== request.assignment.sessionId
    ) {
      crossSessionHandoffAllowed = await this.#stateRepository.allowsDelegatedSandboxHandoff({
        tenantId: request.assignment.tenantId,
        workspaceId: request.assignment.workspaceId,
        currentSessionId: inherited.handle.assignment.sessionId,
        nextSessionId: request.assignment.sessionId,
      });
    }
    if (
      inherited?.retention === "persistent" &&
      inherited.handle.assignment.sessionId !== request.assignment.sessionId
    ) {
      const persistentHandoffAllowed =
        crossSessionHandoffAllowed ||
        (await this.#stateRepository.allowsPersistentConversationHandoff({
          tenantId: request.assignment.tenantId,
          workspaceId: request.assignment.workspaceId,
          currentSessionId: inherited.handle.assignment.sessionId,
          nextSessionId: request.assignment.sessionId,
        }));
      if (!persistentHandoffAllowed) {
        throw new ToolBrokerError(
          "tool_sandbox_workspace_pinned",
          "Workspace is pinned to another persistent Sandbox conversation",
          false,
        );
      }
    }
    if (
      inherited !== undefined &&
      ((!crossSessionHandoffAllowed &&
        inherited.handle.assignment.sessionId !== request.assignment.sessionId) ||
        request.workspaceRevision === undefined ||
        request.workspaceRevision !== inherited.workspaceRevision ||
        !sameEnvironment(request.environment, inherited.environment))
    ) {
      await this.#discardWarm(key, inherited);
      inherited = undefined;
    }
    if (inherited !== undefined) this.#warm.delete(key);

    const activationId = validActivationId(
      delegatedParent?.spec.activationId ?? inherited?.handle.activationId ?? this.#idGenerator(),
    );
    if (this.#activations.has(activationId)) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    const capability = validCapability(this.#capabilityGenerator());
    const capabilitySha256 = capabilityDigest(capability).toString("hex");
    const allowedTools = parseCloudToolCapabilitySnapshot(request.allowedTools);
    const spec = {
      activationId,
      assignment: request.assignment,
      environment: request.environment,
      workspaceSeed: request.workspaceSeed,
      ...(request.workspaceRestore === undefined
        ? {}
        : { workspaceRestore: request.workspaceRestore }),
      policy: this.#provider.defaultPolicy ?? DEFAULT_TOOL_SANDBOX_POLICY,
    } as const;
    const reservationInput: SandboxActivationReservation = {
      activationId,
      assignment: request.assignment,
      capabilitySha256,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      environmentSha256: createHash("sha256")
        .update(
          JSON.stringify({
            environmentVersionId: request.environment.environmentVersionId,
            specSha256: request.environment.specSha256,
            recipeSha256: request.environment.recipeSha256,
          }),
        )
        .digest("hex"),
      ...(request.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: request.workspaceRevision }),
    };
    const reservation = await this.#stateRepository.reserve(reservationInput).catch((error) => {
      if (delegatedParent !== undefined) {
        this.#suspended.delete(key);
        this.#activations.set(delegatedParent.spec.activationId, delegatedParent);
        if (this.#admitted.has(delegatedParent.spec.activationId)) {
          this.#admitted.set(delegatedParent.spec.activationId, delegatedParent.assignment);
        }
      }
      throw error;
    });
    if (reservation.status !== "reserved" && delegatedParent !== undefined) {
      this.#suspended.delete(key);
      this.#activations.set(delegatedParent.spec.activationId, delegatedParent);
      if (this.#admitted.has(delegatedParent.spec.activationId)) {
        this.#admitted.set(delegatedParent.spec.activationId, delegatedParent.assignment);
      }
    }
    if (reservation.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new ToolBrokerError(
        "tool_sandbox_workspace_busy",
        "Workspace already has a Tool Sandbox reservation",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    if (reservation.status === "tenant_capacity") {
      throw new ToolBrokerError(
        "tenant_sandbox_capacity_exhausted",
        "Tenant has reached its active Sandbox limit",
        true,
      );
    }
    this.#activations.set(activationId, {
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      capabilityDigest: Buffer.from(capabilitySha256, "hex"),
      allowedTools: new Set(allowedTools),
      spec,
      reservation: reservationInput,
      ...(delegatedParent?.handle === undefined
        ? inherited === undefined
          ? {}
          : { handle: inherited.handle }
        : { handle: delegatedParent.handle }),
      materializedForCurrentAssignment: false,
      activeOperations: 0,
      exclusiveOperation: false,
      operations: new Map(),
      seenCaptureIds: new Set(),
    });
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      ownerBaseUrl: this.#ownerBaseUrl,
      capability,
      workspaceRoot: "/workspace",
      continuity:
        delegatedParent === undefined && inherited === undefined ? "cold_restore" : "warm_reuse",
    };
  }

  async execute(
    capability: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#authorized(request.activationId, capability);
    if (activation.exclusiveOperation) {
      throw new ToolBrokerError(
        "tool_sandbox_workspace_busy",
        "Workspace is establishing an isolated Subagent fork",
        true,
      );
    }
    if (!activation.allowedTools.has(request.toolName)) {
      throw new ToolBrokerError(
        "tool_not_granted",
        "Tool is not present in this Run capability snapshot",
        false,
      );
    }
    if (!TOOL_OPERATIONS[request.toolName].has(request.operation)) {
      throw new ToolBrokerError(
        "tool_operation_not_granted",
        "Tool operation does not match its granted Tool",
        false,
      );
    }
    if (request.turnContextSha256 !== activation.turnContextSha256) {
      throw new ToolBrokerError(
        "turn_context_mismatch",
        "Tool operation did not match the frozen Cloud Turn context",
        false,
      );
    }
    if (request.attemptContextSha256 !== activation.attemptContextSha256) {
      throw new ToolBrokerError(
        "attempt_context_mismatch",
        "Tool operation did not match the current Cloud Attempt context",
        false,
      );
    }
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
    const existing = activation.operations.get(request.operationId);
    if (existing !== undefined) {
      if (existing.requestSha256 === requestSha256) return existing.result;
      throw new ToolBrokerError(
        "tool_operation_identity_conflict",
        "Tool operation ID was reused for a different request",
        false,
      );
    }
    const currentStep = activation.currentStep;
    if (currentStep === undefined || request.stepContextSequence > currentStep.sequence) {
      activation.currentStep = {
        sequence: request.stepContextSequence,
        sha256: request.stepContextSha256,
      };
    } else if (
      request.stepContextSequence < currentStep.sequence ||
      request.stepContextSha256 !== currentStep.sha256
    ) {
      throw new ToolBrokerError(
        "step_context_mismatch",
        "Tool operation used a stale or conflicting Cloud Step",
        false,
      );
    }
    const durable = (async (): Promise<ToolSandboxOperationResponse> => {
      activation.activeOperations += 1;
      try {
        const started = await this.#stateRepository.beginOperation(
          request.activationId,
          request.operationId,
          requestSha256,
        );
        if (started !== "started") {
          throw new ToolBrokerError(
            "tool_operation_outcome_unknown",
            "Tool operation may already have produced side effects",
            false,
          );
        }
        const handle = await this.#materialize(request.activationId, activation, signal);
        const response = await this.#provider.exec(handle, request, signal);
        await this.#stateRepository.settleOperation(request.operationId, "succeeded");
        return response;
      } catch (error: unknown) {
        await this.#stateRepository
          .settleOperation(
            request.operationId,
            signal?.aborted ? "cancelled" : "failed",
            operationFailureCode(error),
          )
          .catch(() => undefined);
        throw error;
      } finally {
        activation.activeOperations -= 1;
      }
    })();
    activation.operations.set(request.operationId, { requestSha256, result: durable });
    return durable;
  }

  async capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
    requestId: string,
  ): Promise<ToolSandboxCaptureResponse> {
    const activation = this.#owned(activationId, assignment);
    if (activation.seenCaptureIds.has(requestId)) {
      throw new ToolBrokerError(
        "tool_capture_replay",
        "Tool Sandbox capture ID was already used",
        false,
      );
    }
    activation.seenCaptureIds.add(requestId);
    if (!activation.materializedForCurrentAssignment) {
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.unused",
        requestId,
        activationId,
      };
    }
    return this.#provider.snapshot(await this.#materialize(activationId, activation), requestId);
  }

  async forkWorkspace(
    request: ToolBrokerWorkspaceForkRequest,
  ): Promise<ToolBrokerWorkspaceForkResponse> {
    if (this.#provider.forkWorkspace === undefined) {
      throw new ToolBrokerError(
        "workspace_fork_unsupported",
        "The configured Sandbox Provider cannot create isolated Workspace forks",
        false,
      );
    }
    const activation = this.#owned(request.sourceActivationId, request.sourceAssignment);
    if (
      activation.exclusiveOperation ||
      activation.activeOperations !== 0 ||
      activation.materializing !== undefined
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_workspace_busy",
        "Parent Workspace is busy and cannot be isolated",
        true,
      );
    }
    activation.exclusiveOperation = true;
    try {
      const handle = await this.#materialize(request.sourceActivationId, activation);
      const forked = await this.#provider.forkWorkspace(handle, request);
      activation.handle = forked.sourceHandle;
      activation.materializedForCurrentAssignment = true;
      return {
        toolBrokerProtocolVersion: 1,
        type: "workspace.forked",
        requestId: request.requestId,
        sourceActivationId: request.sourceActivationId,
        targetWorkspaceId: request.target.workspaceId,
        sourceRevision: forked.sourceRevision,
        targetRevision: forked.targetRevision,
      };
    } finally {
      activation.exclusiveOperation = false;
    }
  }

  async release(request: ToolSandboxReleaseRequest): Promise<ToolSandboxReleaseResponse> {
    const activation = this.#owned(request.activationId, request.assignment);
    this.#revoke(request.activationId, activation);
    let retained = false;
    let handle = activation.handle;
    if (activation.materializing !== undefined) {
      handle = await activation.materializing.catch(() => undefined);
    }
    const retainRequested = request.disposition !== "destroy";
    if (retainRequested && handle !== undefined && this.#provider.supportsWarmRebind !== false) {
      if (this.#provider.retainForWarm !== undefined) {
        try {
          handle = await this.#provider.retainForWarm(handle);
        } catch {
          await this.#provider.stop(handle).catch(() => undefined);
          this.#releaseAdmission(handle.activationId);
          handle = undefined;
        }
      }
    }
    const key = workspaceKey(request.assignment);
    if (this.#suspended.has(key)) {
      if (!retainRequested && handle !== undefined) {
        await this.#provider.stop(handle).catch(() => undefined);
        handle = undefined;
      }
      await this.#restoreSuspended(key, handle);
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: handle !== undefined,
      };
    }
    if (retainRequested && handle !== undefined && this.#provider.supportsWarmRebind !== false) {
      const previous = this.#warm.get(key);
      if (previous !== undefined && previous.handle.runtimeId !== handle.runtimeId) {
        await this.#discardWarm(key, previous);
      }
      const now = this.#now();
      this.#warm.set(key, {
        handle,
        workspaceRevision: request.workspaceRevision,
        environment: activation.spec.environment,
        retention: request.disposition === "keep_persistent" ? "persistent" : "ephemeral",
        lastUsedAt: now,
        expiresAt: request.disposition === "keep_persistent" ? null : now + this.#warmTtlMs,
      });
      retained = true;
      await this.#stateRepository.setActivationState(request.activationId, "warm", {
        handle,
        workspaceRevision: request.workspaceRevision,
      });
      await this.#enforceWarmLimit();
    } else if (handle !== undefined) {
      await this.#provider.stop(handle);
      this.#releaseAdmission(handle.activationId);
      await this.#stateRepository.setActivationState(request.activationId, "released");
    } else {
      this.#releaseAdmission(request.activationId);
      await this.#stateRepository.setActivationState(request.activationId, "released");
    }
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.released",
      requestId: request.requestId,
      activationId: request.activationId,
      retained,
    };
  }

  async inspect(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<SandboxInspection> {
    const activation = this.#owned(activationId, assignment);
    return this.#provider.inspect(await this.#materialize(activationId, activation));
  }

  async stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#activations.get(activationId);
    if (activation === undefined) {
      await this.#provider.destroyActivation(activationId, assignment);
      this.#releaseAdmission(activationId);
      return;
    }
    if (!sameAssignment(activation.assignment, assignment)) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    this.#revoke(activationId, activation);
    const handle =
      activation.materializing === undefined
        ? activation.handle
        : await activation.materializing.catch(() => undefined);
    const key = workspaceKey(assignment);
    if (this.#suspended.has(key)) {
      if (handle !== undefined) await this.#provider.stop(handle).catch(() => undefined);
      await this.#restoreSuspended(key, undefined);
      return;
    }
    if (handle !== undefined) {
      await this.#provider.stop(handle);
      this.#releaseAdmission(handle.activationId);
    } else {
      this.#releaseAdmission(activationId);
    }
    await this.#stateRepository.setActivationState(activationId, "released");
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const [providerAssignments, durableAssignments] = await Promise.all([
      this.#provider.listAssignments(sandboxId),
      this.#stateRepository.listRuntimeAssignments(sandboxId),
    ]);
    const assignments = new Map<string, SupervisorRuntimeAssignment>();
    for (const assignment of [...providerAssignments, ...durableAssignments]) {
      assignments.set(`${assignment.containerId}\0${assignment.fencingToken}`, assignment);
    }
    return [...assignments.values()];
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const managed = [...this.#activations.entries()].filter(([, activation]) =>
      activation.handle === undefined ? false : samePhysicalRuntime(activation.handle, assignment),
    );
    for (const [activationId, activation] of managed) this.#revoke(activationId, activation);
    const terminatedActivationIds = new Set(
      [...this.#admitted.entries()]
        .filter(([, admittedAssignment]) =>
          sameSupervisorAssignment(admittedAssignment, assignment),
        )
        .map(([activationId]) => activationId),
    );
    for (const [activationId] of managed) terminatedActivationIds.add(activationId);
    for (const [key, warm] of this.#warm) {
      if (samePhysicalRuntime(warm.handle, assignment)) {
        this.#warm.delete(key);
        terminatedActivationIds.add(warm.handle.activationId);
      }
    }
    await this.#provider.terminateAndConfirmAbsent(assignment);
    await this.#stateRepository.releaseRuntimeAssignment(assignment);
    for (const activationId of terminatedActivationIds) {
      this.#releaseAdmission(activationId);
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#provider.confirmAbsent(assignment);
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#provider.importGitHub === undefined) {
      throw new ToolBrokerError(
        "repository_import_removed",
        "Repository import is not available; clone the repository from a Cube Tool session",
        false,
      );
    }
    return this.#provider.importGitHub(source, signal);
  }

  async materializeFile(
    request: ToolBrokerMaterializeFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerMaterializeFileResponse> {
    if (this.#provider.materializeFile === undefined) {
      throw new ToolBrokerError(
        "snapshot_materializer_unavailable",
        "The configured Sandbox Provider cannot materialize immutable Workspace files",
        false,
      );
    }
    // Current Workspace snapshots are persistent-Volume references. Reading
    // one file is a trusted Volume Gateway operation and must not wait for or
    // consume a Cube KVM admission slot. The provider still validates tenant,
    // Workspace, revision, path and content hash before returning bytes.
    return this.#provider.materializeFile(request, signal);
  }

  async close(): Promise<void> {
    clearInterval(this.#reaper);
    await Promise.all(
      [...this.#terminals.entries()].map(([terminalId, terminal]) =>
        this.#closeTerminal(terminalId, terminal).catch(() => undefined),
      ),
    );
    for (const [environmentId, environment] of this.#developmentEnvironments) {
      environment.terminal?.disconnect();
      await environment.terminal?.kill().catch(() => undefined);
      await this.#provider.destroy(environment.handle).catch(() => undefined);
      this.#releaseAdmission(environmentId);
      await this.#stateRepository
        .setDevelopmentEnvironmentState(environmentId, "failed", {
          failureCode: "tool_broker_stopped",
        })
        .catch(() => undefined);
    }
    this.#developmentEnvironments.clear();
    const ownedActivationIds = new Set([
      ...this.#activations.keys(),
      ...[...this.#warm.values()].map((warm) => warm.handle.activationId),
    ]);
    for (const [activationId, activation] of this.#activations) {
      this.#revoke(activationId, activation);
    }
    this.#warm.clear();
    for (const waiter of this.#admissionWaiters.splice(0)) {
      this.#removeAbortListener(waiter);
      waiter.reject(
        new ToolBrokerError("tool_sandbox_admission_closed", "Tool Sandbox admission closed", true),
      );
    }
    this.#admitted.clear();
    try {
      await this.#provider.close();
      for (const activationId of ownedActivationIds) {
        await this.#stateRepository.setActivationState(activationId, "released");
      }
    } finally {
      await this.#stateRepository.close();
    }
  }

  async reapWarm(): Promise<void> {
    const now = this.#now();
    const expired = [...this.#warm.entries()].filter(
      ([, warm]) => warm.expiresAt !== null && warm.expiresAt <= now,
    );
    for (const [key, warm] of expired) {
      if (this.#warm.get(key) !== warm) continue;
      await this.#discardWarm(key, warm);
    }
  }

  async reapRetiredWarm(): Promise<void> {
    const retired = new Set(await this.#stateRepository.listRetiredWarmActivationIds());
    if (retired.size === 0) return;
    for (const [key, warm] of this.#warm) {
      if (!retired.has(warm.handle.activationId) || this.#warm.get(key) !== warm) continue;
      await this.#discardWarm(key, warm);
    }
  }

  #authorized(activationId: string, capability: string): ManagedActivation {
    const activation = this.#activations.get(activationId);
    const candidate = capabilityDigest(capability);
    const expected = activation?.capabilityDigest ?? Buffer.alloc(32);
    if (
      activation === undefined ||
      candidate.byteLength !== expected.byteLength ||
      !timingSafeEqual(candidate, expected)
    ) {
      throw new ToolBrokerError(
        "invalid_tool_capability",
        "Tool Sandbox operation is not authorized",
        false,
      );
    }
    return activation;
  }

  #owned(activationId: string, assignment: ToolSandboxAssignment): ManagedActivation {
    const activation = this.#activations.get(activationId);
    if (activation === undefined || !sameAssignment(activation.assignment, assignment)) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    return activation;
  }

  #revoke(activationId: string, activation: ManagedActivation): void {
    activation.capabilityDigest.fill(0);
    this.#activations.delete(activationId);
    this.#cancelAdmissionWaiter(activationId);
  }

  async #materialize(
    activationId: string,
    activation: ManagedActivation,
    signal?: AbortSignal,
  ): Promise<SandboxHandle> {
    if (activation.materializedForCurrentAssignment && activation.handle !== undefined) {
      return activation.handle;
    }
    if (activation.materializing !== undefined) return activation.materializing;
    const materializing = (async (): Promise<SandboxHandle> => {
      await this.#stateRepository.setActivationState(activationId, "materializing");
      await this.#acquireAdmission(activationId, activation.assignment, signal);
      let releaseAdmissionOnFailure = true;
      try {
        if (this.#activations.get(activationId) !== activation || signal?.aborted) {
          throw new ToolBrokerError(
            "tool_sandbox_admission_cancelled",
            "Tool Sandbox admission was cancelled",
            false,
          );
        }
        let handle = activation.handle;
        if (handle !== undefined) {
          try {
            handle = await this.#provider.rebind(handle, activation.assignment);
          } catch (error: unknown) {
            try {
              await this.#provider.stop(handle);
              delete activation.handle;
            } catch (cleanupError: unknown) {
              releaseAdmissionOnFailure = false;
              throw cleanupError;
            }
            handle = undefined;
            if (error instanceof ToolBrokerError && !error.retryable) throw error;
          }
        }
        if (handle === undefined) handle = await this.#provider.create(activation.spec);
        if (this.#activations.get(activationId) !== activation || signal?.aborted) {
          await this.#provider.destroy(handle).catch(() => undefined);
          throw new ToolBrokerError(
            "tool_sandbox_admission_cancelled",
            "Tool Sandbox admission was cancelled after provider creation",
            false,
          );
        }
        if (
          !handleMatches(
            handle,
            this.#provider,
            activationId,
            activation.assignment,
            activation.spec.environment,
          )
        ) {
          try {
            await this.#provider.destroy(handle);
          } catch (cleanupError: unknown) {
            activation.handle = handle;
            releaseAdmissionOnFailure = false;
            throw cleanupError;
          }
          throw new ToolBrokerError(
            "sandbox_provider_protocol_error",
            "Sandbox Provider returned a mismatched handle",
            false,
          );
        }
        activation.handle = handle;
        activation.materializedForCurrentAssignment = true;
        await this.#stateRepository.setActivationState(activationId, "active", { handle });
        return handle;
      } catch (error: unknown) {
        if (releaseAdmissionOnFailure) this.#releaseAdmission(activationId);
        await this.#stateRepository
          .setActivationState(activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
    })();
    activation.materializing = materializing;
    try {
      return await materializing;
    } finally {
      delete activation.materializing;
    }
  }

  async #restoreSuspended(key: string, handle: SandboxHandle | undefined): Promise<boolean> {
    const suspended = this.#suspended.get(key);
    if (suspended === undefined) return false;
    let restoredHandle: SandboxHandle | undefined;
    if (handle !== undefined) {
      try {
        restoredHandle = await this.#provider.rebind(handle, suspended.activation.assignment);
      } catch {
        await this.#provider.stop(handle).catch(() => undefined);
      }
    }
    let reservation: Awaited<ReturnType<SandboxActivationStateRepository["reserve"]>>;
    try {
      reservation = await this.#stateRepository.reserve(suspended.reservation);
    } catch (error: unknown) {
      if (restoredHandle !== undefined)
        await this.#provider.stop(restoredHandle).catch(() => undefined);
      this.#suspended.delete(key);
      this.#releaseAdmission(suspended.activation.spec.activationId);
      throw error;
    }
    if (reservation.status !== "reserved") {
      if (restoredHandle !== undefined)
        await this.#provider.stop(restoredHandle).catch(() => undefined);
      this.#suspended.delete(key);
      this.#releaseAdmission(suspended.activation.spec.activationId);
      throw new ToolBrokerError(
        "tool_sandbox_parent_restore_failed",
        "Parent Tool Sandbox authority could not be restored after Subagent execution",
        true,
      );
    }
    if (restoredHandle === undefined) delete suspended.activation.handle;
    else suspended.activation.handle = restoredHandle;
    suspended.activation.materializedForCurrentAssignment = restoredHandle !== undefined;
    delete suspended.activation.materializing;
    this.#suspended.delete(key);
    this.#activations.set(suspended.activation.spec.activationId, suspended.activation);
    if (this.#admitted.has(suspended.activation.spec.activationId)) {
      this.#admitted.set(suspended.activation.spec.activationId, suspended.activation.assignment);
    }
    return true;
  }

  async #enforceWarmLimit(): Promise<void> {
    while (
      [...this.#warm.values()].filter((warm) => warm.retention === "ephemeral").length >
      this.#maximumWarmActivations
    ) {
      const oldest = [...this.#warm.entries()]
        .filter(([, warm]) => warm.retention === "ephemeral")
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest === undefined) return;
      await this.#discardWarm(oldest[0], oldest[1]);
    }
  }

  async #reapOrphanedActivations(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedActivations(16);
    for (const orphan of orphaned) {
      try {
        await this.#provider.destroyActivation(orphan.activationId, orphan.assignment);
        await this.#stateRepository.setActivationState(orphan.activationId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setActivationState(orphan.activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapTerminalRunActivations(): Promise<void> {
    const orphaned = await this.#stateRepository.claimTerminalRunActivations(16);
    for (const orphan of orphaned) {
      const local = this.#activations.get(orphan.activationId);
      if (local !== undefined) this.#revoke(orphan.activationId, local);
      this.#releaseAdmission(orphan.activationId);
      try {
        await this.#provider.destroyActivation(orphan.activationId, orphan.assignment);
        await this.#stateRepository.setActivationState(orphan.activationId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setActivationState(orphan.activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapOrphanedTerminals(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedTerminals(16);
    for (const terminal of orphaned) {
      const assignment = terminalAssignment(terminal.terminalId, terminal);
      try {
        await this.#provider.destroyActivation(terminal.terminalId, assignment);
        await this.#stateRepository.setTerminalState(terminal.terminalId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setTerminalState(terminal.terminalId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapOrphanedDevelopmentEnvironments(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedDevelopmentEnvironments(16);
    for (const environment of orphaned) {
      const local = this.#developmentEnvironments.get(environment.environmentId);
      local?.terminal?.disconnect();
      if (local?.terminal !== undefined) await local.terminal.kill().catch(() => undefined);
      this.#developmentEnvironments.delete(environment.environmentId);
      const assignment = developmentEnvironmentAssignment({
        environmentId: environment.environmentId,
        tenantId: environment.tenantId,
        projectId: environment.projectId,
        workspaceId: environment.workspaceId,
        generation: environment.generation,
      });
      try {
        await this.#provider.destroyActivation(environment.environmentId, assignment);
        this.#releaseAdmission(environment.environmentId);
        await this.#stateRepository.setDevelopmentEnvironmentState(
          environment.environmentId,
          "failed",
          { failureCode: "tool_broker_owner_lost" },
        );
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(environment.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  #closeTerminal(terminalId: string, terminal: ManagedWorkspaceTerminal): Promise<void> {
    terminal.closing ??= (async () => {
      this.#terminals.delete(terminalId);
      await this.#stateRepository.setTerminalState(terminalId, "cleaning").catch(() => undefined);
      terminal.session.disconnect();
      await terminal.session.kill().catch(() => undefined);
      try {
        await this.#provider.destroy(terminal.handle);
        this.#releaseAdmission(terminalId);
        await this.#stateRepository.setTerminalState(terminalId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setTerminalState(terminalId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
    })();
    return terminal.closing;
  }

  async #acquireAdmission(
    activationId: string,
    assignment: ToolSandboxAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#admitted.has(activationId)) return;
    if (signal?.aborted) {
      throw new ToolBrokerError(
        "tool_sandbox_admission_cancelled",
        "Tool Sandbox admission was cancelled",
        false,
      );
    }
    while (this.#admitted.size >= this.#maximumActiveSandboxes) {
      const oldest = [...this.#warm.entries()]
        .filter(([, warm]) => warm.retention === "ephemeral")
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest === undefined) break;
      if (this.#warm.get(oldest[0]) !== oldest[1]) continue;
      await this.#discardWarm(oldest[0], oldest[1]);
      if (signal?.aborted) {
        throw new ToolBrokerError(
          "tool_sandbox_admission_cancelled",
          "Tool Sandbox admission was cancelled",
          false,
        );
      }
    }
    if (this.#admitted.size < this.#maximumActiveSandboxes) {
      this.#admitted.set(activationId, assignment);
      return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const waiter: AdmissionWaiter = {
        activationId,
        assignment,
        ...(signal === undefined ? {} : { signal }),
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#admissionWaiters.indexOf(waiter);
          if (index >= 0) this.#admissionWaiters.splice(index, 1);
          this.#removeAbortListener(waiter);
          rejectPromise(
            new ToolBrokerError(
              "tool_sandbox_admission_cancelled",
              "Tool Sandbox admission was cancelled",
              false,
            ),
          );
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#admissionWaiters.push(waiter);
    });
  }

  async #discardWarm(key: string, warm: WarmActivation): Promise<void> {
    if (this.#warm.get(key) === warm) this.#warm.delete(key);
    await this.#provider.stop(warm.handle);
    this.#releaseAdmission(warm.handle.activationId);
    await this.#stateRepository.setActivationState(warm.handle.activationId, "released");
  }

  #releaseAdmission(activationId: string): void {
    if (!this.#admitted.delete(activationId)) return;
    while (this.#admissionWaiters.length > 0) {
      const waiter = this.#admissionWaiters.shift();
      if (waiter === undefined) return;
      this.#removeAbortListener(waiter);
      if (waiter.signal?.aborted) continue;
      this.#admitted.set(waiter.activationId, waiter.assignment);
      waiter.resolve();
      return;
    }
  }

  #cancelAdmissionWaiter(activationId: string): void {
    const index = this.#admissionWaiters.findIndex(
      (waiter) => waiter.activationId === activationId,
    );
    if (index < 0) return;
    const [waiter] = this.#admissionWaiters.splice(index, 1);
    if (waiter === undefined) return;
    this.#removeAbortListener(waiter);
    waiter.reject(
      new ToolBrokerError(
        "tool_sandbox_admission_cancelled",
        "Tool Sandbox admission was cancelled",
        false,
      ),
    );
  }

  #removeAbortListener(waiter: AdmissionWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Tool Broker clock returned an invalid timestamp");
    }
    return value;
  }
}
