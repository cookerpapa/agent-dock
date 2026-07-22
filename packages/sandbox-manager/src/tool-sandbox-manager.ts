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

export type ToolSandboxManagerOptions = {
  provider: SandboxProvider;
  idGenerator?: () => string;
  capabilityGenerator?: () => string;
  warmTtlMs?: number;
  maximumWarmActivations?: number;
  clock?: () => number;
  imageRevision?: string;
};

type ManagedActivation = {
  assignment: ToolSandboxAssignment;
  capabilityDigest: Buffer;
  spec: Parameters<SandboxProvider["create"]>[0];
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  materializedForCurrentAssignment: boolean;
  seenOperationIds: Set<string>;
  seenCaptureIds: Set<string>;
};

type WarmActivation = {
  handle: SandboxHandle;
  workspaceRevision: string;
  environment: EnvironmentRuntimeSnapshot;
  expiresAt: number;
  lastUsedAt: number;
};

const DEFAULT_WARM_TTL_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_WARM_ACTIVATIONS = 4;

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function workspaceKey(assignment: ToolSandboxAssignment): string {
  return [
    assignment.tenantId,
    assignment.projectId,
    assignment.workspaceId,
    assignment.sessionId,
    assignment.supervisorId,
    assignment.bootId,
    assignment.sandboxId,
  ].join("\0");
}

function capabilityDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
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

function sameRuntimeAssignment(
  handle: SandboxHandle,
  assignment: SupervisorRuntimeAssignment,
): boolean {
  return (
    handle.runtimeId === assignment.containerId &&
    handle.runtimeName === assignment.containerName &&
    handle.assignment.supervisorId === assignment.supervisorId &&
    handle.assignment.bootId === assignment.bootId &&
    handle.assignment.sandboxId === assignment.sandboxId &&
    handle.assignment.commandId === assignment.commandId &&
    handle.assignment.sessionId === assignment.sessionId &&
    handle.assignment.turnId === assignment.turnId &&
    handle.assignment.leaseId === assignment.leaseId &&
    handle.assignment.fencingToken === assignment.fencingToken
  );
}

export class ToolSandboxManager {
  readonly #provider: SandboxProvider;
  readonly #idGenerator: () => string;
  readonly #capabilityGenerator: () => string;
  readonly #warmTtlMs: number;
  readonly #maximumWarmActivations: number;
  readonly #clock: () => number;
  readonly #imageRevision: string;
  readonly #activations = new Map<string, ManagedActivation>();
  readonly #warm = new Map<string, WarmActivation>();
  readonly #reaper: NodeJS.Timeout;

  constructor(options: ToolSandboxManagerOptions) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#capabilityGenerator =
      options.capabilityGenerator ?? (() => `adts_${randomBytes(32).toString("base64url")}`);
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
    this.#reaper = setInterval(() => void this.reapWarm().catch(() => undefined), 30_000);
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
    await this.#provider.checkHealth();
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    await this.reapWarm();
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
        "tool_sandbox_session_busy",
        "Workspace session already has a Tool Sandbox reservation",
        true,
      );
    }

    let inherited = this.#warm.get(key);
    if (
      inherited !== undefined &&
      (request.workspaceRevision === undefined ||
        request.workspaceRevision !== inherited.workspaceRevision ||
        !sameEnvironment(request.environment, inherited.environment))
    ) {
      this.#warm.delete(key);
      await this.#provider.stop(inherited.handle);
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
    const spec = {
      activationId,
      assignment: request.assignment,
      environment: request.environment,
      workspaceSeed: request.workspaceSeed,
      ...(request.workspaceRestore === undefined
        ? {}
        : { workspaceRestore: request.workspaceRestore }),
      policy: DEFAULT_TOOL_SANDBOX_POLICY,
    } as const;
    this.#activations.set(activationId, {
      assignment: request.assignment,
      capabilityDigest: capabilityDigest(capability),
      spec,
      ...(inherited === undefined ? {} : { handle: inherited.handle }),
      materializedForCurrentAssignment: false,
      seenOperationIds: new Set(),
      seenCaptureIds: new Set(),
    });
    return {
      managerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      capability,
      workspaceRoot: "/workspace",
    };
  }

  async execute(
    capability: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#authorized(request.activationId, capability);
    if (activation.seenOperationIds.has(request.operationId)) {
      throw new SandboxManagerError(
        "tool_operation_replay",
        "Tool operation ID was already used",
        false,
      );
    }
    activation.seenOperationIds.add(request.operationId);
    const handle = await this.#materialize(request.activationId, activation);
    return this.#provider.exec(handle, request, signal);
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
      handle = await activation.materializing;
    }
    if (request.disposition === "keep_warm" && handle !== undefined) {
      const key = workspaceKey(request.assignment);
      const previous = this.#warm.get(key);
      if (previous !== undefined && previous.handle.runtimeId !== handle.runtimeId) {
        await this.#provider.stop(previous.handle);
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
      await this.#enforceWarmLimit();
    } else if (handle !== undefined) {
      await this.#provider.stop(handle);
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
    if (handle !== undefined) await this.#provider.stop(handle);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    return this.#provider.listAssignments(sandboxId);
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const managed = [...this.#activations.entries()].find(([, activation]) =>
      activation.handle === undefined
        ? false
        : sameRuntimeAssignment(activation.handle, assignment),
    );
    if (managed !== undefined) this.#revoke(managed[0], managed[1]);
    for (const [key, warm] of this.#warm) {
      if (sameRuntimeAssignment(warm.handle, assignment)) this.#warm.delete(key);
    }
    await this.#provider.terminateAndConfirmAbsent(assignment);
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#provider.confirmAbsent(assignment);
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    return this.#provider.importGitHub(source, signal);
  }

  async close(): Promise<void> {
    clearInterval(this.#reaper);
    for (const [activationId, activation] of this.#activations) {
      this.#revoke(activationId, activation);
    }
    this.#warm.clear();
    await this.#provider.close();
  }

  async reapWarm(): Promise<void> {
    const now = this.#now();
    const expired = [...this.#warm.entries()].filter(([, warm]) => warm.expiresAt <= now);
    for (const [key, warm] of expired) {
      if (this.#warm.get(key) !== warm) continue;
      this.#warm.delete(key);
      await this.#provider.stop(warm.handle);
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
  }

  async #materialize(activationId: string, activation: ManagedActivation): Promise<SandboxHandle> {
    if (activation.materializedForCurrentAssignment && activation.handle !== undefined) {
      return activation.handle;
    }
    if (activation.materializing !== undefined) return activation.materializing;
    const materializing = (async (): Promise<SandboxHandle> => {
      let handle = activation.handle;
      if (handle !== undefined) {
        try {
          handle = await this.#provider.rebind(handle, activation.assignment);
        } catch (error: unknown) {
          await this.#provider.stop(handle);
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
        await this.#provider.destroy(handle).catch(() => undefined);
        throw new SandboxManagerError(
          "sandbox_provider_protocol_error",
          "Sandbox Provider returned a mismatched handle",
          false,
        );
      }
      activation.handle = handle;
      activation.materializedForCurrentAssignment = true;
      return handle;
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
