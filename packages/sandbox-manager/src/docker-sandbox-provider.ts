import {
  parseGitHubWorkspaceImportOutput,
  parseToolWorkerOutput,
  type GitHubRepositorySource,
  type GitHubWorkspaceImportRequest,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWorkerOutput,
} from "@agent-dock/protocol";
import { decodeWorkspaceSnapshotBlob } from "@agent-dock/workspace-runtime";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_OPERATION_GRACE_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_IMPORT_STDOUT_BYTES = 3 * 1_024 * 1_024;

export const TOOL_SANDBOX_LABELS = {
  managed: "agent-dock.managed",
  activationId: "agent-dock.activation-id",
  tenantId: "agent-dock.tenant-id",
  supervisorId: "agent-dock.supervisor-id",
  bootId: "agent-dock.boot-id",
  sandboxId: "agent-dock.sandbox-id",
  commandId: "agent-dock.command-id",
  sessionId: "agent-dock.session-id",
  turnId: "agent-dock.turn-id",
  attemptId: "agent-dock.attempt-id",
  leaseId: "agent-dock.lease-id",
  fencingToken: "agent-dock.fencing-token",
} as const;

export type DockerSandboxProviderOptions = {
  toolImage: string;
  repositoryImportNetwork: string;
  dockerCommand?: string;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  repositoryImportTimeoutMs?: number;
  idGenerator?: () => string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

type DockerManagedRuntime = SupervisorRuntimeAssignment & {
  activationId: string;
  tenantId: string;
  attemptId: string;
};

type Activation = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  runtimeName: string;
  runtimeId?: string;
  handle?: SandboxHandle;
  child: ChildProcessWithoutNullStreams;
  exit: Promise<ExitResult>;
  ready: Deferred<void>;
  operations: Map<string, Deferred<ToolSandboxOperationResponse>>;
  captures: Map<string, Deferred<ToolSandboxCaptureResponse>>;
  seenOperationIds: Set<string>;
  stdoutBuffer: Buffer;
  stderr: string;
  failed?: Error;
  stopping: boolean;
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

function dockerNetwork(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "none") {
    throw new TypeError("Repository import network is invalid");
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new SandboxManagerError("sandbox_timeout", `${label} timed out`, true));
    }, timeoutMs);
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

function runtimeName(activationId: string): string {
  return `agent-dock-tool-${activationId}`.slice(0, 63);
}

function dockerArgs(
  image: string,
  name: string,
  activationId: string,
  assignment: ToolSandboxAssignment,
  policy: SandboxPolicy,
): readonly string[] {
  for (const [nameValue, value] of Object.entries(assignment)) {
    if (nameValue === "fencingToken") continue;
    bounded(String(value), `Tool Sandbox assignment ${nameValue}`, 512);
  }
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
      "Docker Sandbox Provider does not support the requested policy",
      false,
    );
  }
  const resources = policy.resources;
  for (const [nameValue, value] of Object.entries(resources)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Sandbox resource limit ${nameValue} is invalid`);
    }
  }
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    name,
    "--label",
    `${TOOL_SANDBOX_LABELS.managed}=true`,
    "--label",
    `${TOOL_SANDBOX_LABELS.activationId}=${activationId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.tenantId}=${assignment.tenantId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.supervisorId}=${assignment.supervisorId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.bootId}=${assignment.bootId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.sandboxId}=${assignment.sandboxId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.commandId}=${assignment.commandId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.sessionId}=${assignment.sessionId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.turnId}=${assignment.turnId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.attemptId}=${assignment.attemptId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.leaseId}=${assignment.leaseId}`,
    "--label",
    `${TOOL_SANDBOX_LABELS.fencingToken}=${String(assignment.fencingToken)}`,
    "--user",
    policy.user,
    "--read-only",
    "--network",
    "none",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(resources.pids),
    "--memory",
    String(resources.memoryBytes),
    "--cpus",
    String(resources.cpuNano / 1_000_000_000),
    "--ulimit",
    `nofile=${String(resources.openFiles)}:${String(resources.openFiles)}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${String(resources.temporaryBytes)},mode=1777,uid=1000,gid=1000`,
    "--tmpfs",
    `/workspace:rw,nosuid,nodev,size=${String(resources.workspaceBytes)},uid=1000,gid=1000,mode=0700`,
    "--workdir",
    "/workspace",
    "--stop-timeout",
    "5",
    image,
  ];
}

function sendLine(activation: Activation, message: unknown): void {
  if (activation.child.stdin.destroyed || !activation.child.stdin.writable) {
    throw new SandboxManagerError(
      "tool_sandbox_unavailable",
      "Tool Sandbox input is unavailable",
      true,
    );
  }
  if (!activation.child.stdin.write(`${JSON.stringify(message)}\n`)) {
    throw new SandboxManagerError(
      "tool_sandbox_backpressure",
      "Tool Sandbox input is backpressured",
      true,
    );
  }
}

function dockerExec(
  dockerCommand: string,
  args: readonly string[],
  timeoutMs: number,
  maximumBytes = 4 * 1_024 * 1_024,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      dockerCommand,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: maximumBytes },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          rejectPromise(
            new SandboxManagerError(
              "docker_unavailable",
              "Docker service is unavailable to Sandbox Manager",
              true,
            ),
          );
          return;
        }
        resolvePromise({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function notFound(stderr: string): boolean {
  return /no such (?:object|container)/i.test(stderr);
}

function labelsToAssignment(
  runtimeId: string,
  runtimeNameValue: string,
  labels: Record<string, unknown>,
): DockerManagedRuntime {
  const required = (key: string): string => {
    const value = labels[key];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new SandboxManagerError(
        "docker_assignment_identity_invalid",
        "Managed Tool Sandbox labels were invalid",
        false,
      );
    }
    return value;
  };
  const fencingToken = Number(required(TOOL_SANDBOX_LABELS.fencingToken));
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new SandboxManagerError(
      "docker_assignment_identity_invalid",
      "Managed Tool Sandbox fence was invalid",
      false,
    );
  }
  return {
    containerId: runtimeId,
    containerName: runtimeNameValue.replace(/^\//, ""),
    activationId: required(TOOL_SANDBOX_LABELS.activationId),
    tenantId: required(TOOL_SANDBOX_LABELS.tenantId),
    supervisorId: required(TOOL_SANDBOX_LABELS.supervisorId),
    bootId: required(TOOL_SANDBOX_LABELS.bootId),
    sandboxId: required(TOOL_SANDBOX_LABELS.sandboxId),
    commandId: required(TOOL_SANDBOX_LABELS.commandId),
    sessionId: required(TOOL_SANDBOX_LABELS.sessionId),
    turnId: required(TOOL_SANDBOX_LABELS.turnId),
    attemptId: required(TOOL_SANDBOX_LABELS.attemptId),
    leaseId: required(TOOL_SANDBOX_LABELS.leaseId),
    fencingToken,
  };
}

export function buildToolSandboxDockerArguments(
  image: string,
  name: string,
  activationId: string,
  assignment: ToolSandboxAssignment,
  policy: SandboxPolicy = DEFAULT_TOOL_SANDBOX_POLICY,
): readonly string[] {
  bounded(image, "Tool Sandbox image");
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) {
    throw new TypeError("Tool Sandbox container name is invalid");
  }
  if (!/^[0-9a-f-]{36}$/.test(activationId)) {
    throw new TypeError("Tool Sandbox activation ID is invalid");
  }
  return dockerArgs(image, name, activationId, assignment, policy);
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly providerId = "docker";
  readonly #toolImage: string;
  readonly #repositoryImportNetwork: string;
  readonly #dockerCommand: string;
  readonly #readyTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #repositoryImportTimeoutMs: number;
  readonly #idGenerator: () => string;
  readonly #activations = new Map<string, Activation>();

  constructor(options: DockerSandboxProviderOptions) {
    this.#toolImage = bounded(options.toolImage, "Tool Sandbox image");
    this.#repositoryImportNetwork = dockerNetwork(options.repositoryImportNetwork);
    this.#dockerCommand = bounded(options.dockerCommand ?? "docker", "Docker command");
    this.#readyTimeoutMs = positiveInteger(
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs",
      60_000,
    );
    this.#cleanupTimeoutMs = positiveInteger(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
      60_000,
    );
    this.#repositoryImportTimeoutMs = positiveInteger(
      options.repositoryImportTimeoutMs ?? 180_000,
      "repositoryImportTimeoutMs",
      300_000,
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async checkHealth(): Promise<void> {
    const result = await dockerExec(
      this.#dockerCommand,
      ["version", "--format", "{{.Server.Version}}"],
      this.#cleanupTimeoutMs,
      64 * 1_024,
    );
    if (result.code !== 0 || !/^\d+\.\d+(?:\.\d+)?\s*$/.test(result.stdout)) {
      throw new SandboxManagerError("docker_unavailable", "Docker service is unavailable", true);
    }
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    const activationId = spec.activationId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        activationId,
      )
    ) {
      throw new TypeError("Sandbox Manager ID generator returned an invalid UUID");
    }
    if (this.#activations.has(activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    const name = runtimeName(activationId);
    const child = spawn(
      this.#dockerCommand,
      buildToolSandboxDockerArguments(
        this.#toolImage,
        name,
        activationId,
        spec.assignment,
        spec.policy,
      ),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const ready = deferred<void>();
    void ready.promise.catch(() => undefined);
    const activation: Activation = {
      activationId,
      assignment: spec.assignment,
      runtimeName: name,
      child,
      exit: new Promise<ExitResult>((resolveExit) => {
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      }),
      ready,
      operations: new Map(),
      captures: new Map(),
      seenOperationIds: new Set(),
      stdoutBuffer: Buffer.alloc(0),
      stderr: "",
      stopping: false,
    };
    this.#activations.set(activationId, activation);
    this.#attachWorker(activation);
    try {
      sendLine(activation, {
        toolWorkerProtocolVersion: 1,
        type: "worker.initialize",
        activationId,
        workspaceSeed: spec.workspaceSeed,
        ...(spec.workspaceRestore === undefined ? {} : { workspaceRestore: spec.workspaceRestore }),
      });
      await withTimeout(ready.promise, this.#readyTimeoutMs, "Tool Sandbox readiness");
      activation.runtimeId = await this.#inspectRuntimeId(name);
      const handle: SandboxHandle = {
        providerApiVersion: 1,
        providerId: this.providerId,
        activationId,
        runtimeId: activation.runtimeId,
        runtimeName: name,
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
      };
      activation.handle = handle;
      return handle;
    } catch (error: unknown) {
      await this.#stopActivation(activation);
      throw error;
    }
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
      try {
        sendLine(activation, {
          toolWorkerProtocolVersion: 1,
          type: "worker.cancel",
          activationId: activation.activationId,
          operationId: request.operationId,
        });
      } catch {
        // The pending operation will fail through worker/process teardown.
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      sendLine(activation, {
        toolWorkerProtocolVersion: 1,
        type: "worker.operation",
        request,
      });
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
        "Docker Sandbox Provider returned the wrong file operation",
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
        "Docker Sandbox Provider returned the wrong file operation",
        false,
      );
    }
  }

  async snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse> {
    const activation = this.#ownedHandle(handle);
    const activationId = handle.activationId;
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
      sendLine(activation, {
        toolWorkerProtocolVersion: 1,
        type: "worker.capture",
        activationId,
        requestId,
      });
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
    const current = await this.#inspectAssignment(handle.runtimeId);
    if (current === undefined) {
      this.#activations.delete(handle.activationId);
      return;
    }
    if (!this.#managedRuntimeMatchesHandle(current, handle)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
    await this.#removeContainer(current.containerId);
    this.#activations.delete(handle.activationId);
  }

  async destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
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
    await this.#confirmNamedActivationAbsent(activationId, assignment);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspection> {
    const current = await this.#inspectAssignment(handle.runtimeId);
    if (current === undefined) {
      return {
        providerApiVersion: 1,
        providerId: this.providerId,
        state: "absent",
        handle,
      };
    }
    if (!this.#managedRuntimeMatchesHandle(current, handle)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox inspection identity did not match",
        false,
      );
    }
    const inspected = await this.#inspectEffectiveIsolation(handle.runtimeId);
    return {
      providerApiVersion: 1,
      providerId: this.providerId,
      state: inspected.running ? "running" : "stopped",
      handle,
      effectiveIsolation: inspected.effectiveIsolation,
    };
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const result = await dockerExec(
      this.#dockerCommand,
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${TOOL_SANDBOX_LABELS.managed}=true`,
        "--filter",
        `label=${TOOL_SANDBOX_LABELS.sandboxId}=${sandboxId}`,
        "--format",
        "{{.ID}}",
      ],
      this.#cleanupTimeoutMs,
    );
    if (result.code !== 0) {
      throw new SandboxManagerError(
        "docker_inventory_unavailable",
        "Tool Sandbox inventory failed",
        true,
      );
    }
    const references = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (references.length > 1_000 || new Set(references).size !== references.length) {
      throw new SandboxManagerError(
        "docker_inventory_ambiguous",
        "Tool Sandbox inventory exceeded its safe scope",
        false,
      );
    }
    const assignments: SupervisorRuntimeAssignment[] = [];
    for (const reference of references) {
      const inspected = await this.#inspectAssignment(reference);
      if (inspected !== undefined && inspected.sandboxId === sandboxId) assignments.push(inspected);
    }
    return assignments;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const current = await this.#inspectAssignment(assignment.containerId);
    if (current === undefined) return;
    if (!sameRuntimeAssignment(current, assignment)) {
      throw new SandboxManagerError(
        "docker_assignment_identity_mismatch",
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
          "docker_assignment_identity_mismatch",
          "Tracked Tool Sandbox identity did not match",
          false,
        );
      }
      await this.#stopActivation(tracked);
      return;
    }
    const removed = await dockerExec(
      this.#dockerCommand,
      ["rm", "--force", assignment.containerId],
      this.#cleanupTimeoutMs,
    );
    if (removed.code !== 0 && !notFound(removed.stderr)) {
      throw new SandboxManagerError(
        "docker_cleanup_unverified",
        "Tool Sandbox could not be removed",
        true,
      );
    }
    if ((await this.#inspectAssignment(assignment.containerId)) !== undefined) {
      throw new SandboxManagerError(
        "docker_cleanup_unverified",
        "Tool Sandbox removal could not be confirmed",
        true,
      );
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    if ((await this.#inspectAssignment(assignment.containerId)) !== undefined) {
      throw new SandboxManagerError(
        "docker_assignment_still_alive",
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
    const importId = this.#idGenerator();
    const name = `agent-dock-import-${importId}`.slice(0, 63);
    const child = spawn(
      this.#dockerCommand,
      [
        "run",
        "--rm",
        "--interactive",
        "--name",
        name,
        "--label",
        "agent-dock.workspace-import=true",
        "--label",
        `agent-dock.workspace-import-id=${importId}`,
        "--user",
        "1000:1000",
        "--read-only",
        "--network",
        this.#repositoryImportNetwork,
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "96",
        "--memory",
        "384m",
        "--cpus",
        "0.75",
        "--ulimit",
        "nofile=512:512",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=1000,gid=1000",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
        "--workdir",
        "/workspace",
        "--stop-timeout",
        "5",
        "--entrypoint",
        "node",
        this.#toolImage,
        "/app/packages/tool-sandbox/src/github-import-worker.ts",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_IMPORT_STDOUT_BYTES) {
        stdout = stdout.subarray(0, MAX_IMPORT_STDOUT_BYTES + 1);
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_WORKER_STDERR_BYTES);
    });
    const exit = new Promise<ExitResult>((resolveExit, rejectExit) => {
      child.once("error", () => {
        rejectExit(
          new SandboxManagerError(
            "repository_import_start_failed",
            "Repository importer could not start",
            true,
          ),
        );
      });
      child.once("close", (code, closeSignal) => resolveExit({ code, signal: closeSignal }));
    });
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    const request: GitHubWorkspaceImportRequest = {
      workspaceImportProtocolVersion: 1,
      type: "workspace.import",
      importId,
      source,
    };
    child.stdin.end(`${JSON.stringify(request)}\n`);
    try {
      const result = await withTimeout(exit, this.#repositoryImportTimeoutMs, "Repository import");
      if (signal.aborted) {
        throw new SandboxManagerError(
          "repository_import_cancelled",
          "Repository import was cancelled",
          true,
        );
      }
      if (stdout.byteLength > MAX_IMPORT_STDOUT_BYTES) {
        throw new SandboxManagerError(
          "repository_import_output_too_large",
          "Repository importer output exceeded its limit",
          false,
        );
      }
      const lines = stdout.toString("utf8").split("\n").filter(Boolean);
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
      if (result.code !== 0 || result.signal !== null) {
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
      await this.#removeContainer(name);
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#activations.values()].map((value) => this.#stopActivation(value)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new SandboxManagerError(
        "sandbox_provider_cleanup_unverified",
        "Docker Sandbox Provider shutdown could not confirm complete cleanup",
        true,
      );
    }
  }

  #attachWorker(activation: Activation): void {
    const fail = (error: Error): void => {
      if (activation.failed !== undefined) return;
      activation.failed = error;
      activation.ready.reject(error);
      for (const pending of activation.operations.values()) pending.reject(error);
      for (const pending of activation.captures.values()) pending.reject(error);
      activation.operations.clear();
      activation.captures.clear();
      void this.#stopActivation(activation).catch(() => undefined);
    };
    activation.child.stdout.on("data", (chunk: Buffer) => {
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
          try {
            this.#handleWorkerOutput(
              activation,
              parseToolWorkerOutput(JSON.parse(line) as unknown),
            );
          } catch {
            fail(
              new SandboxManagerError(
                "tool_worker_protocol_error",
                "Tool Sandbox emitted invalid output",
                false,
              ),
            );
          }
        }
        newline = activation.stdoutBuffer.indexOf(0x0a);
      }
    });
    activation.child.stderr.on("data", (chunk: Buffer) => {
      activation.stderr = `${activation.stderr}${chunk.toString("utf8")}`.slice(
        -MAX_WORKER_STDERR_BYTES,
      );
    });
    activation.child.once("error", () => {
      fail(
        new SandboxManagerError("tool_sandbox_start_failed", "Tool Sandbox could not start", true),
      );
    });
    void activation.exit.then((result) => {
      if (!activation.stopping) {
        fail(
          new SandboxManagerError(
            "tool_sandbox_exit",
            result.code !== 0 || result.signal !== null
              ? "Tool Sandbox exited unexpectedly"
              : "Tool Sandbox stopped before release",
            true,
          ),
        );
      }
    });
  }

  #handleWorkerOutput(activation: Activation, output: ToolWorkerOutput): void {
    if (output.type === "worker.ready") {
      if (output.activationId !== activation.activationId) {
        throw new Error("identity mismatch");
      }
      activation.ready.resolve();
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

  #ownedHandle(handle: SandboxHandle): Activation {
    const activation = this.#activations.get(handle.activationId);
    if (
      handle.providerApiVersion !== 1 ||
      handle.providerId !== this.providerId ||
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

  #managedRuntimeMatchesHandle(current: DockerManagedRuntime, handle: SandboxHandle): boolean {
    return (
      current.containerId === handle.runtimeId &&
      current.containerName === handle.runtimeName &&
      current.activationId === handle.activationId &&
      current.tenantId === handle.assignment.tenantId &&
      current.attemptId === handle.assignment.attemptId &&
      assignmentMatchesRuntime(handle.assignment, current)
    );
  }

  async #inspectRuntimeId(name: string): Promise<string> {
    const result = await dockerExec(
      this.#dockerCommand,
      ["inspect", "--format", "{{.Id}}", name],
      this.#cleanupTimeoutMs,
      64 * 1_024,
    );
    const id = result.stdout.trim();
    if (result.code !== 0 || !/^[a-f0-9]{12,128}$/.test(id)) {
      throw new SandboxManagerError(
        "docker_assignment_identity_invalid",
        "Tool Sandbox runtime identity was unavailable",
        true,
      );
    }
    return id;
  }

  async #inspectAssignment(reference: string): Promise<DockerManagedRuntime | undefined> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(reference)) {
      throw new TypeError("Tool Sandbox runtime reference is invalid");
    }
    const result = await dockerExec(
      this.#dockerCommand,
      ["inspect", reference],
      this.#cleanupTimeoutMs,
    );
    if (result.code !== 0) {
      if (notFound(result.stderr)) return undefined;
      throw new SandboxManagerError(
        "docker_inventory_unverified",
        "Tool Sandbox identity could not be verified",
        true,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new SandboxManagerError(
        "docker_inventory_malformed",
        "Docker returned malformed Tool Sandbox inventory",
        false,
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      typeof parsed[0] !== "object" ||
      parsed[0] === null
    ) {
      throw new SandboxManagerError(
        "docker_inventory_malformed",
        "Docker returned ambiguous Tool Sandbox inventory",
        false,
      );
    }
    const value = parsed[0] as {
      Id?: unknown;
      Name?: unknown;
      Config?: { Labels?: unknown };
    };
    if (
      typeof value.Id !== "string" ||
      typeof value.Name !== "string" ||
      typeof value.Config?.Labels !== "object" ||
      value.Config.Labels === null
    ) {
      throw new SandboxManagerError(
        "docker_assignment_identity_invalid",
        "Managed Tool Sandbox identity was invalid",
        false,
      );
    }
    const labels = value.Config.Labels as Record<string, unknown>;
    if (labels[TOOL_SANDBOX_LABELS.managed] !== "true") {
      throw new SandboxManagerError(
        "docker_assignment_identity_invalid",
        "Docker runtime is not an AgentDock Tool Sandbox",
        false,
      );
    }
    return labelsToAssignment(value.Id, value.Name, labels);
  }

  async #inspectEffectiveIsolation(reference: string): Promise<{
    running: boolean;
    effectiveIsolation: SandboxEffectiveIsolation;
  }> {
    const result = await dockerExec(
      this.#dockerCommand,
      ["inspect", reference],
      this.#cleanupTimeoutMs,
    );
    if (result.code !== 0) {
      throw new SandboxManagerError(
        "docker_inventory_unverified",
        "Tool Sandbox effective isolation could not be verified",
        true,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new SandboxManagerError(
        "docker_inventory_malformed",
        "Docker returned malformed Tool Sandbox inspection",
        false,
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      typeof parsed[0] !== "object" ||
      parsed[0] === null
    ) {
      throw new SandboxManagerError(
        "docker_inventory_malformed",
        "Docker returned ambiguous Tool Sandbox inspection",
        false,
      );
    }
    const value = parsed[0] as {
      Config?: { User?: unknown };
      State?: { Running?: unknown };
      HostConfig?: {
        Privileged?: unknown;
        ReadonlyRootfs?: unknown;
        NetworkMode?: unknown;
        PidsLimit?: unknown;
        Memory?: unknown;
        NanoCpus?: unknown;
        CapDrop?: unknown;
        SecurityOpt?: unknown;
      };
      Mounts?: unknown;
    };
    const host = value.HostConfig;
    if (
      typeof value.Config?.User !== "string" ||
      typeof value.State?.Running !== "boolean" ||
      typeof host?.Privileged !== "boolean" ||
      typeof host.ReadonlyRootfs !== "boolean" ||
      typeof host.NetworkMode !== "string" ||
      !Array.isArray(value.Mounts)
    ) {
      throw new SandboxManagerError(
        "docker_assignment_identity_invalid",
        "Tool Sandbox effective isolation was invalid",
        false,
      );
    }
    const mounts = value.Mounts as Array<{ Source?: unknown; Destination?: unknown }>;
    const strings = (input: unknown): readonly string[] =>
      Array.isArray(input) && input.every((entry) => typeof entry === "string") ? input : [];
    const numberOrNull = (input: unknown): number | null =>
      typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : null;
    return {
      running: value.State.Running,
      effectiveIsolation: {
        user: value.Config.User,
        privileged: host.Privileged,
        readOnlyRootFilesystem: host.ReadonlyRootfs,
        networkMode: host.NetworkMode,
        mountCount: mounts.length,
        hasDockerSocket: mounts.some(
          (mount) =>
            mount.Source === "/var/run/docker.sock" || mount.Destination === "/var/run/docker.sock",
        ),
        pidLimit: numberOrNull(host.PidsLimit),
        memoryBytes: numberOrNull(host.Memory),
        cpuNano: numberOrNull(host.NanoCpus),
        droppedCapabilities: strings(host.CapDrop),
        securityOptions: strings(host.SecurityOpt),
      },
    };
  }

  async #stopActivation(activation: Activation): Promise<void> {
    if (activation.stopping) {
      await withTimeout(activation.exit, this.#cleanupTimeoutMs, "Tool Sandbox stop").catch(
        async () => this.#removeContainer(activation.runtimeName),
      );
      await this.#removeContainer(activation.runtimeName);
      this.#activations.delete(activation.activationId);
      return;
    }
    activation.stopping = true;
    try {
      sendLine(activation, {
        toolWorkerProtocolVersion: 1,
        type: "worker.shutdown",
        activationId: activation.activationId,
      });
    } catch {
      // Force removal below is authoritative.
    }
    activation.child.stdin.end();
    await withTimeout(activation.exit, 2_000, "Tool Sandbox clean stop").catch(async () => {
      await this.#removeContainer(activation.runtimeName);
      await withTimeout(activation.exit, this.#cleanupTimeoutMs, "Tool Sandbox forced stop").catch(
        () => undefined,
      );
    });
    await this.#removeContainer(activation.runtimeName);
    this.#activations.delete(activation.activationId);
  }

  async #removeContainer(reference: string): Promise<void> {
    const inspected = await dockerExec(
      this.#dockerCommand,
      ["inspect", "--format", "{{.Id}}", reference],
      this.#cleanupTimeoutMs,
      64 * 1_024,
    );
    if (inspected.code !== 0) {
      if (notFound(inspected.stderr)) return;
      throw new SandboxManagerError(
        "docker_cleanup_unverified",
        "Tool Sandbox absence could not be verified",
        true,
      );
    }
    const removed = await dockerExec(
      this.#dockerCommand,
      ["rm", "--force", reference],
      this.#cleanupTimeoutMs,
      64 * 1_024,
    );
    if (removed.code !== 0 && !notFound(removed.stderr)) {
      throw new SandboxManagerError(
        "docker_cleanup_unverified",
        "Tool Sandbox could not be removed",
        true,
      );
    }
    const remaining = await dockerExec(
      this.#dockerCommand,
      ["inspect", "--format", "{{.Id}}", reference],
      this.#cleanupTimeoutMs,
      64 * 1_024,
    );
    if (remaining.code !== 0 && notFound(remaining.stderr)) return;
    throw new SandboxManagerError(
      "docker_cleanup_unverified",
      "Tool Sandbox removal could not be confirmed",
      true,
    );
  }

  async #confirmNamedActivationAbsent(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<void> {
    const current = await this.#inspectAssignment(runtimeName(activationId));
    if (current === undefined) return;
    if (
      current.activationId !== activationId ||
      current.tenantId !== assignment.tenantId ||
      current.supervisorId !== assignment.supervisorId ||
      current.bootId !== assignment.bootId ||
      current.sandboxId !== assignment.sandboxId ||
      current.commandId !== assignment.commandId ||
      current.sessionId !== assignment.sessionId ||
      current.turnId !== assignment.turnId ||
      current.attemptId !== assignment.attemptId ||
      current.leaseId !== assignment.leaseId ||
      current.fencingToken !== assignment.fencingToken
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    await this.#removeContainer(current.containerId);
  }
}
