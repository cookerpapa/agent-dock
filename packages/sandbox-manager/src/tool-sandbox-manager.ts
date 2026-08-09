import type {
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
  SandboxManagerMaterializeFileRequest,
  SandboxManagerMaterializeFileResponse,
} from "@agent-dock/protocol";
import {
  canonicalEnvironmentRecipeJson,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@agent-dock/protocol";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_TOOL_SANDBOX_POLICY,
  SandboxManagerError,
  type SandboxHandle,
  type SandboxInspection,
  type SandboxProvider,
} from "./sandbox-provider.ts";
import {
  InMemorySandboxActivationStateRepository,
  type SandboxActivationStateRepository,
} from "./activation-state-repository.ts";

export type ToolSandboxManagerOptions = {
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

export class SandboxManagerOwnerRedirectError extends Error {
  readonly ownerBaseUrl: string;

  constructor(ownerBaseUrl: string) {
    super("Tool Sandbox activation is owned by another Sandbox Manager replica");
    this.name = "SandboxManagerOwnerRedirectError";
    this.ownerBaseUrl = ownerBaseUrl;
  }
}

type ManagedActivation = {
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  attemptContextSha256: string;
  currentStep?: Readonly<{ sequence: number; sha256: string }>;
  capabilityDigest: Buffer;
  spec: Parameters<SandboxProvider["create"]>[0];
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  materializedForCurrentAssignment: boolean;
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
  expiresAt: number;
  lastUsedAt: number;
};

type AdmissionWaiter = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: SandboxManagerError) => void;
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
  return error instanceof SandboxManagerError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : "sandbox_manager_failed";
}

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
  if (!/^adts_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("Tool Sandbox capability generator returned an invalid value");
  }
  return value;
}

function validActivationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("Sandbox Manager ID generator returned an invalid UUID");
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

export class ToolSandboxManager {
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
  readonly #admitted = new Map<string, ToolSandboxAssignment>();
  readonly #admissionWaiters: AdmissionWaiter[] = [];
  readonly #reaper: NodeJS.Timeout;

  constructor(options: ToolSandboxManagerOptions) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#ownerBaseUrl = new URL(
      options.ownerBaseUrl ?? "http://sandbox-manager.invalid",
    ).toString();
    this.#stateRepository =
      options.stateRepository ?? new InMemorySandboxActivationStateRepository();
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#capabilityGenerator =
      options.capabilityGenerator ?? (() => `adts_${randomBytes(32).toString("base64url")}`);
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
        void Promise.all([this.reapWarm(), this.#reapOrphanedActivations()]).catch(() => undefined),
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
    return activeHandles + this.#warm.size;
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

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    await Promise.all([this.reapWarm(), this.#reapOrphanedActivations()]);
    if (
      request.environment.profileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      request.environment.profileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      request.environment.specSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      request.environment.imageRevision !== this.#imageRevision ||
      createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(request.environment.recipe))
        .digest("hex") !== request.environment.recipeSha256
    ) {
      throw new SandboxManagerError(
        "environment_policy_mismatch",
        "Run environment is not served by this Sandbox Manager",
        false,
      );
    }
    const key = workspaceKey(request.assignment);
    if ([...this.#activations.values()].some((entry) => workspaceKey(entry.assignment) === key)) {
      throw new SandboxManagerError(
        "tool_sandbox_workspace_busy",
        "Workspace already has a Tool Sandbox reservation",
        true,
      );
    }

    let inherited = this.#warm.get(key);
    if (
      inherited !== undefined &&
      (inherited.handle.assignment.sessionId !== request.assignment.sessionId ||
        request.workspaceRevision === undefined ||
        request.workspaceRevision !== inherited.workspaceRevision ||
        !sameEnvironment(request.environment, inherited.environment))
    ) {
      this.#warm.delete(key);
      await this.#provider.stop(inherited.handle);
      this.#releaseAdmission(inherited.handle.activationId);
      inherited = undefined;
    }
    if (inherited !== undefined) this.#warm.delete(key);

    const activationId = validActivationId(inherited?.handle.activationId ?? this.#idGenerator());
    if (this.#activations.has(activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    const capability = validCapability(this.#capabilityGenerator());
    const capabilitySha256 = capabilityDigest(capability).toString("hex");
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
    const reservation = await this.#stateRepository.reserve({
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
    });
    if (reservation.status === "redirect") {
      throw new SandboxManagerOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new SandboxManagerError(
        "tool_sandbox_workspace_busy",
        "Workspace already has a Tool Sandbox reservation",
        true,
      );
    }
    this.#activations.set(activationId, {
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      capabilityDigest: Buffer.from(capabilitySha256, "hex"),
      spec,
      ...(inherited === undefined ? {} : { handle: inherited.handle }),
      materializedForCurrentAssignment: false,
      operations: new Map(),
      seenCaptureIds: new Set(),
    });
    return {
      managerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      ownerBaseUrl: this.#ownerBaseUrl,
      capability,
      workspaceRoot: "/workspace",
      continuity: inherited === undefined ? "cold_restore" : "warm_reuse",
    };
  }

  async execute(
    capability: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#authorized(request.activationId, capability);
    if (request.turnContextSha256 !== activation.turnContextSha256) {
      throw new SandboxManagerError(
        "turn_context_mismatch",
        "Tool operation did not match the frozen Cloud Turn context",
        false,
      );
    }
    if (request.attemptContextSha256 !== activation.attemptContextSha256) {
      throw new SandboxManagerError(
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
      throw new SandboxManagerError(
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
      throw new SandboxManagerError(
        "step_context_mismatch",
        "Tool operation used a stale or conflicting Cloud Step",
        false,
      );
    }
    const durable = (async (): Promise<ToolSandboxOperationResponse> => {
      const started = await this.#stateRepository.beginOperation(
        request.activationId,
        request.operationId,
        requestSha256,
      );
      if (started !== "started") {
        throw new SandboxManagerError(
          "tool_operation_outcome_unknown",
          "Tool operation may already have produced side effects",
          false,
        );
      }
      try {
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
      throw new SandboxManagerError(
        "tool_capture_replay",
        "Tool Sandbox capture ID was already used",
        false,
      );
    }
    activation.seenCaptureIds.add(requestId);
    if (!activation.materializedForCurrentAssignment) {
      return {
        managerProtocolVersion: 1,
        type: "tool_sandbox.unused",
        requestId,
        activationId,
      };
    }
    return this.#provider.snapshot(await this.#materialize(activationId, activation), requestId);
  }

  async release(request: ToolSandboxReleaseRequest): Promise<ToolSandboxReleaseResponse> {
    const activation = this.#owned(request.activationId, request.assignment);
    this.#revoke(request.activationId, activation);
    let retained = false;
    let handle = activation.handle;
    if (activation.materializing !== undefined) {
      handle = await activation.materializing.catch(() => undefined);
    }
    if (
      request.disposition === "keep_warm" &&
      handle !== undefined &&
      this.#provider.supportsWarmRebind !== false
    ) {
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
    if (
      request.disposition === "keep_warm" &&
      handle !== undefined &&
      this.#provider.supportsWarmRebind !== false
    ) {
      const key = workspaceKey(request.assignment);
      const previous = this.#warm.get(key);
      if (previous !== undefined && previous.handle.runtimeId !== handle.runtimeId) {
        await this.#provider.stop(previous.handle);
        this.#releaseAdmission(previous.handle.activationId);
      }
      const now = this.#now();
      this.#warm.set(key, {
        handle,
        workspaceRevision: request.workspaceRevision,
        environment: activation.spec.environment,
        lastUsedAt: now,
        expiresAt: now + this.#warmTtlMs,
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
      managerProtocolVersion: 1,
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
      throw new SandboxManagerError(
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
      throw new SandboxManagerError(
        "repository_import_removed",
        "Repository import is not available; clone the repository from a Cube Tool session",
        false,
      );
    }
    return this.#provider.importGitHub(source, signal);
  }

  async materializeFile(
    request: SandboxManagerMaterializeFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxManagerMaterializeFileResponse> {
    if (this.#provider.materializeFile === undefined) {
      throw new SandboxManagerError(
        "snapshot_materializer_unavailable",
        "The configured Sandbox Provider cannot materialize immutable Workspace files",
        false,
      );
    }
    const assignment: ToolSandboxAssignment = {
      tenantId: request.tenantId,
      projectId: request.workspaceId,
      workspaceId: request.workspaceId,
      supervisorId: "snapshot-materializer",
      bootId: request.requestId,
      sandboxId: request.requestId,
      commandId: request.requestId,
      sessionId: request.workspaceId,
      turnId: request.requestId,
      attemptId: request.requestId,
      leaseId: request.requestId,
      fencingToken: 1,
    };
    await this.#acquireAdmission(request.requestId, assignment, signal);
    let releaseAdmission = true;
    try {
      return await this.#provider.materializeFile(request, signal);
    } catch (error: unknown) {
      if (
        error instanceof SandboxManagerError &&
        error.code === "snapshot_materializer_cleanup_failed"
      ) {
        releaseAdmission = false;
      }
      throw error;
    } finally {
      if (releaseAdmission) this.#releaseAdmission(request.requestId);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#reaper);
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
        new SandboxManagerError(
          "tool_sandbox_admission_closed",
          "Tool Sandbox admission closed",
          true,
        ),
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
    const expired = [...this.#warm.entries()].filter(([, warm]) => warm.expiresAt <= now);
    for (const [key, warm] of expired) {
      if (this.#warm.get(key) !== warm) continue;
      this.#warm.delete(key);
      await this.#provider.stop(warm.handle);
      this.#releaseAdmission(warm.handle.activationId);
      await this.#stateRepository.setActivationState(warm.handle.activationId, "released");
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
      throw new SandboxManagerError(
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
      throw new SandboxManagerError(
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
          throw new SandboxManagerError(
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
            if (error instanceof SandboxManagerError && !error.retryable) throw error;
          }
        }
        if (handle === undefined) handle = await this.#provider.create(activation.spec);
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
          throw new SandboxManagerError(
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

  async #enforceWarmLimit(): Promise<void> {
    while (this.#warm.size > this.#maximumWarmActivations) {
      const oldest = [...this.#warm.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest === undefined) return;
      this.#warm.delete(oldest[0]);
      await this.#provider.stop(oldest[1].handle);
      this.#releaseAdmission(oldest[1].handle.activationId);
      await this.#stateRepository.setActivationState(oldest[1].handle.activationId, "released");
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

  async #acquireAdmission(
    activationId: string,
    assignment: ToolSandboxAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#admitted.has(activationId)) return;
    if (signal?.aborted) {
      throw new SandboxManagerError(
        "tool_sandbox_admission_cancelled",
        "Tool Sandbox admission was cancelled",
        false,
      );
    }
    while (this.#admitted.size >= this.#maximumActiveSandboxes && this.#warm.size > 0) {
      const oldest = [...this.#warm.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest === undefined) break;
      if (this.#warm.get(oldest[0]) !== oldest[1]) continue;
      this.#warm.delete(oldest[0]);
      await this.#provider.stop(oldest[1].handle);
      this.#releaseAdmission(oldest[1].handle.activationId);
      if (signal?.aborted) {
        throw new SandboxManagerError(
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
            new SandboxManagerError(
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
      new SandboxManagerError(
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
      throw new TypeError("Sandbox Manager clock returned an invalid timestamp");
    }
    return value;
  }
}
