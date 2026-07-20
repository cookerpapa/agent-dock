import type {
  GitHubRepositorySource,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxCreateRequest,
  ToolSandboxCreateResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
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
};

type ManagedActivation = {
  capabilityDigest: Buffer;
  handle: SandboxHandle;
  seenOperationIds: Set<string>;
  seenCaptureIds: Set<string>;
};

function capabilityDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
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
): boolean {
  return (
    handle.providerApiVersion === 1 &&
    handle.providerId === provider.providerId &&
    handle.activationId === activationId &&
    handle.workspaceRoot === "/workspace" &&
    /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(handle.runtimeName) &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(handle.runtimeId) &&
    sameAssignment(handle.assignment, assignment)
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
  readonly #activations = new Map<string, ManagedActivation>();

  constructor(options: ToolSandboxManagerOptions) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#capabilityGenerator =
      options.capabilityGenerator ?? (() => `adts_${randomBytes(32).toString("base64url")}`);
  }

  get providerId(): string {
    return this.#provider.providerId;
  }

  get activeCount(): number {
    return this.#activations.size;
  }

  async checkHealth(): Promise<void> {
    await this.#provider.checkHealth();
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    const activationId = validActivationId(this.#idGenerator());
    if (this.#activations.has(activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    const capability = validCapability(this.#capabilityGenerator());
    const handle = await this.#provider.create({
      activationId,
      assignment: request.assignment,
      workspaceSeed: request.workspaceSeed,
      ...(request.workspaceRestore === undefined
        ? {}
        : { workspaceRestore: request.workspaceRestore }),
      policy: DEFAULT_TOOL_SANDBOX_POLICY,
    });
    if (!handleMatches(handle, this.#provider, activationId, request.assignment)) {
      await this.#provider.destroy(handle).catch(() => undefined);
      throw new SandboxManagerError(
        "sandbox_provider_protocol_error",
        "Sandbox Provider returned a mismatched handle",
        false,
      );
    }
    this.#activations.set(activationId, {
      capabilityDigest: capabilityDigest(capability),
      handle,
      seenOperationIds: new Set(),
      seenCaptureIds: new Set(),
    });
    return {
      managerProtocolVersion: 1,
      type: "tool_sandbox.created",
      requestId: request.requestId,
      activationId,
      capability,
      runtimeId: handle.runtimeId,
      runtimeName: handle.runtimeName,
      workspaceRoot: handle.workspaceRoot,
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
    return this.#provider.exec(activation.handle, request, signal);
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
    return this.#provider.snapshot(activation.handle, requestId);
  }

  async inspect(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<SandboxInspection> {
    return this.#provider.inspect(this.#owned(activationId, assignment).handle);
  }

  async stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#activations.get(activationId);
    if (activation === undefined) {
      await this.#provider.destroyActivation(activationId, assignment);
      return;
    }
    if (!sameAssignment(activation.handle.assignment, assignment)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    this.#revoke(activationId, activation);
    await this.#provider.stop(activation.handle);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    return this.#provider.listAssignments(sandboxId);
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const managed = [...this.#activations.entries()].find(([, activation]) =>
      sameRuntimeAssignment(activation.handle, assignment),
    );
    if (managed !== undefined) this.#revoke(managed[0], managed[1]);
    await this.#provider.terminateAndConfirmAbsent(assignment);
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#provider.confirmAbsent(assignment);
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    return this.#provider.importGitHub(source, signal);
  }

  async close(): Promise<void> {
    for (const [activationId, activation] of this.#activations) {
      this.#revoke(activationId, activation);
    }
    await this.#provider.close();
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
    if (activation === undefined || !sameAssignment(activation.handle.assignment, assignment)) {
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
}
