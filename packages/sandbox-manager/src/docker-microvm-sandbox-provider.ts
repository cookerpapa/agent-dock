import type {
  GitHubRepositorySource,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DockerSandboxProvider } from "./docker-sandbox-provider.ts";
import {
  SandboxManagerError,
  type SandboxCreateSpec,
  type SandboxHandle,
  type SandboxInspection,
  type SandboxProvider,
  type SandboxReadFileInput,
  type SandboxWriteFileInput,
} from "./sandbox-provider.ts";

const MANIFEST_VERSION = 1 as const;
const DEFAULT_CREATE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024;
export const DEFAULT_DOCKER_SANDBOX_TEMPLATE =
  "docker/sandbox-templates@sha256:bd90847e98720dde718fe95b24bd4c7d9d4de41966339eb8bf3ab2bb683259e5";

export type DockerMicrovmSandboxProviderOptions = {
  toolImage: string;
  repositoryImportNetwork: string;
  stateDirectory: string;
  dockerCommand?: string;
  templateImage?: string;
  templatePullPolicy?: "always" | "missing" | "never";
  createTimeoutMs?: number;
  operationTimeoutMs?: number;
  repositoryImportTimeoutMs?: number;
};

type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

type MicrovmManifest = Readonly<{
  manifestVersion: 1;
  activationId: string;
  vmName: string;
  stageDirectory: string;
  toolImageId: string;
  assignment: ToolSandboxAssignment;
  innerHandle: SandboxHandle;
  outerHandle: SandboxHandle;
}>;

type MicrovmActivation = Readonly<{
  manifest: MicrovmManifest;
  innerProvider: DockerSandboxProvider;
}>;

function bounded(value: string, name: string, maximum = 4_096): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
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

function microvmName(activationId: string): string {
  // Docker Desktop uses AF_UNIX paths below the VM directory on Windows.
  // Keep the managed name short enough for that platform's socket-path cap.
  return `admv-${activationId.replaceAll("-", "")}`;
}

function parseAssignment(value: unknown): ToolSandboxAssignment {
  if (typeof value !== "object" || value === null) throw new Error("invalid assignment");
  const candidate = value as Record<string, unknown>;
  const stringFields = ["tenantId", "supervisorId", "commandId", "sessionId", "turnId"] as const;
  const uuidFields = ["bootId", "sandboxId", "attemptId", "leaseId"] as const;
  if (
    !stringFields.every((name) => validOpaque(candidate[name])) ||
    !uuidFields.every(
      (name) => typeof candidate[name] === "string" && validUuid(candidate[name] as string),
    ) ||
    !Number.isSafeInteger(candidate.fencingToken) ||
    Number(candidate.fencingToken) < 1
  ) {
    throw new Error("invalid assignment");
  }
  return candidate as ToolSandboxAssignment;
}

function parseHandle(value: unknown, expectedProvider: "docker" | "docker_microvm"): SandboxHandle {
  if (typeof value !== "object" || value === null) throw new Error("invalid handle");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.providerApiVersion !== 1 ||
    candidate.providerId !== expectedProvider ||
    typeof candidate.activationId !== "string" ||
    !validUuid(candidate.activationId) ||
    typeof candidate.runtimeId !== "string" ||
    !/^[a-f0-9]{12,128}$/.test(candidate.runtimeId) ||
    typeof candidate.runtimeName !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(candidate.runtimeName) ||
    candidate.workspaceRoot !== "/workspace"
  ) {
    throw new Error("invalid handle");
  }
  return { ...candidate, assignment: parseAssignment(candidate.assignment) } as SandboxHandle;
}

function parseManifest(value: unknown): MicrovmManifest {
  if (typeof value !== "object" || value === null) throw new Error("invalid manifest");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.manifestVersion !== MANIFEST_VERSION ||
    typeof candidate.activationId !== "string" ||
    !validUuid(candidate.activationId) ||
    candidate.vmName !== microvmName(candidate.activationId) ||
    typeof candidate.stageDirectory !== "string" ||
    !isAbsolute(candidate.stageDirectory) ||
    typeof candidate.toolImageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.toolImageId)
  ) {
    throw new Error("invalid manifest");
  }
  const assignment = parseAssignment(candidate.assignment);
  const innerHandle = parseHandle(candidate.innerHandle, "docker");
  const outerHandle = parseHandle(candidate.outerHandle, "docker_microvm");
  if (
    innerHandle.activationId !== candidate.activationId ||
    outerHandle.activationId !== candidate.activationId ||
    innerHandle.runtimeId !== outerHandle.runtimeId ||
    outerHandle.runtimeName !== candidate.vmName ||
    !sameAssignment(assignment, innerHandle.assignment) ||
    !sameAssignment(assignment, outerHandle.assignment)
  ) {
    throw new Error("manifest identity mismatch");
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    activationId: candidate.activationId,
    vmName: candidate.vmName,
    stageDirectory: candidate.stageDirectory,
    toolImageId: candidate.toolImageId,
    assignment,
    innerHandle,
    outerHandle,
  };
}

function execute(
  command: string,
  argumentsValue: readonly string[],
  timeoutMs: number,
  maximumBytes = MAX_COMMAND_OUTPUT_BYTES,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...argumentsValue],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: maximumBytes },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          rejectPromise(
            new SandboxManagerError(
              "microvm_runtime_unavailable",
              "Docker Sandbox microVM runtime is unavailable",
              true,
            ),
          );
          return;
        }
        resolvePromise({
          code: error !== null && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * Strong-isolation Provider backed by Docker Sandboxes. The Docker Sandbox
 * shell container is a trusted provisioning bridge only. Agent-generated
 * commands execute in the existing hardened Tool Worker container, nested
 * inside the microVM with no network or Docker socket.
 */
export class DockerMicrovmSandboxProvider implements SandboxProvider {
  readonly providerId = "docker_microvm";
  readonly #toolImage: string;
  readonly #repositoryImportNetwork: string;
  readonly #stateDirectory: string;
  readonly #dockerCommand: string;
  readonly #templateImage: string;
  readonly #templatePullPolicy: "always" | "missing" | "never";
  readonly #createTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #repositoryImporter: DockerSandboxProvider;
  readonly #activations = new Map<string, MicrovmActivation>();
  #imageArchive?: Promise<Readonly<{ imageId: string; path: string }>>;

  constructor(options: DockerMicrovmSandboxProviderOptions) {
    this.#toolImage = bounded(options.toolImage, "Tool Sandbox image", 1_024);
    this.#repositoryImportNetwork = bounded(
      options.repositoryImportNetwork,
      "Repository import network",
      128,
    );
    if (!isAbsolute(options.stateDirectory) || options.stateDirectory.includes("\0")) {
      throw new TypeError("Docker microVM state directory must be absolute");
    }
    this.#stateDirectory = resolve(options.stateDirectory);
    this.#dockerCommand = bounded(options.dockerCommand ?? "docker", "Docker command");
    this.#templateImage = bounded(
      options.templateImage ?? DEFAULT_DOCKER_SANDBOX_TEMPLATE,
      "Docker Sandbox template image",
      1_024,
    );
    this.#templatePullPolicy = options.templatePullPolicy ?? "missing";
    this.#createTimeoutMs = positiveInteger(
      options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
      "createTimeoutMs",
      30 * 60_000,
    );
    this.#operationTimeoutMs = positiveInteger(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs",
      5 * 60_000,
    );
    this.#repositoryImporter = new DockerSandboxProvider({
      toolImage: this.#toolImage,
      repositoryImportNetwork: this.#repositoryImportNetwork,
      dockerCommand: this.#dockerCommand,
      ...(options.repositoryImportTimeoutMs === undefined
        ? {}
        : { repositoryImportTimeoutMs: options.repositoryImportTimeoutMs }),
    });
  }

  async checkHealth(): Promise<void> {
    await this.#initializeState();
    const version = await execute(
      this.#dockerCommand,
      ["sandbox", "version"],
      this.#operationTimeoutMs,
      128 * 1_024,
    );
    if (version.code !== 0 || !/Server Version:\s*v?\d+\.\d+\.\d+/.test(version.stdout)) {
      throw new SandboxManagerError(
        "microvm_runtime_unavailable",
        "Docker Sandbox client and daemon are unavailable",
        true,
      );
    }
    const image = await execute(
      this.#dockerCommand,
      ["image", "inspect", "--format", "{{.Id}}", this.#toolImage],
      this.#operationTimeoutMs,
      128 * 1_024,
    );
    if (image.code !== 0 || !/^sha256:[a-f0-9]{64}\s*$/.test(image.stdout)) {
      throw new SandboxManagerError(
        "microvm_tool_image_unavailable",
        "Docker microVM Tool image is unavailable on the trusted host",
        false,
      );
    }
    await this.#removeManifestsWithoutVms();
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    if (!validUuid(spec.activationId)) {
      throw new TypeError("Sandbox Manager ID generator returned an invalid UUID");
    }
    if (this.#activations.has(spec.activationId)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_collision",
        "Tool Sandbox activation identity collided",
        false,
      );
    }
    await this.#initializeState();
    const vmName = microvmName(spec.activationId);
    if (await this.#vmExists(vmName)) {
      throw new SandboxManagerError(
        "microvm_identity_collision",
        "Docker Sandbox microVM identity already exists",
        false,
      );
    }
    const manifestPath = this.#manifestPath(spec.activationId);
    if (await this.#pathExists(manifestPath)) {
      throw new SandboxManagerError(
        "microvm_identity_collision",
        "Docker Sandbox microVM manifest already exists",
        false,
      );
    }
    const stageDirectory = this.#stageDirectory(spec.activationId);
    await mkdir(stageDirectory, { mode: 0o700 });
    let innerProvider: DockerSandboxProvider | undefined;
    try {
      const archive = await this.#ensureImageArchive();
      const stagedArchive = join(stageDirectory, "tool-image.tar");
      await link(archive.path, stagedArchive).catch(async (error: unknown) => {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EXDEV"
        ) {
          throw error;
        }
        await copyFile(archive.path, stagedArchive);
      });
      await chmod(stagedArchive, 0o444);

      await this.#mustExecute(
        [
          "sandbox",
          "create",
          "--quiet",
          "--name",
          vmName,
          "--pull-template",
          this.#templatePullPolicy,
          "--template",
          this.#templateImage,
          "shell",
          stageDirectory,
        ],
        this.#createTimeoutMs,
        "Docker Sandbox microVM could not be created",
      );
      await this.#mustExecute(
        ["sandbox", "network", "proxy", vmName, "--policy", "deny"],
        this.#operationTimeoutMs,
        "Docker Sandbox deny-all policy could not be applied",
      );
      const workspaceTarget = await this.#workspaceTarget(vmName, stageDirectory);
      await this.#mustExecute(
        [
          "sandbox",
          "exec",
          "--workdir",
          workspaceTarget,
          vmName,
          "docker",
          "load",
          "--input",
          "tool-image.tar",
        ],
        this.#createTimeoutMs,
        "Docker Sandbox Tool image could not be loaded",
      );
      const loadedImage = await this.#mustExecute(
        [
          "sandbox",
          "exec",
          vmName,
          "docker",
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          this.#toolImage,
        ],
        this.#operationTimeoutMs,
        "Docker Sandbox Tool image identity could not be verified",
        128 * 1_024,
      );
      if (loadedImage.stdout.trim() !== archive.imageId) {
        throw new SandboxManagerError(
          "microvm_tool_image_identity_mismatch",
          "Docker Sandbox Tool image identity did not match the trusted host",
          false,
        );
      }
      await unlink(stagedArchive);

      innerProvider = this.#innerProvider(vmName);
      await innerProvider.checkHealth();
      const innerHandle = await innerProvider.create(spec);
      const outerHandle: SandboxHandle = {
        ...innerHandle,
        providerId: this.providerId,
        runtimeName: vmName,
      };
      const manifest: MicrovmManifest = {
        manifestVersion: MANIFEST_VERSION,
        activationId: spec.activationId,
        vmName,
        stageDirectory,
        toolImageId: archive.imageId,
        assignment: spec.assignment,
        innerHandle,
        outerHandle,
      };
      await this.#writeManifest(manifest);
      this.#activations.set(spec.activationId, { manifest, innerProvider });
      return outerHandle;
    } catch (error: unknown) {
      await innerProvider?.close().catch(() => undefined);
      await this.#removeVm(vmName).catch(() => undefined);
      await this.#removeState(spec.activationId, stageDirectory).catch(() => undefined);
      throw error;
    }
  }

  async exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#owned(handle);
    return activation.innerProvider.exec(activation.manifest.innerHandle, request, signal);
  }

  async readFile(
    handle: SandboxHandle,
    input: SandboxReadFileInput,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const activation = this.#owned(handle);
    return activation.innerProvider.readFile(activation.manifest.innerHandle, input, signal);
  }

  async writeFile(
    handle: SandboxHandle,
    input: SandboxWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const activation = this.#owned(handle);
    await activation.innerProvider.writeFile(activation.manifest.innerHandle, input, signal);
  }

  async snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse> {
    const activation = this.#owned(handle);
    return activation.innerProvider.snapshot(activation.manifest.innerHandle, requestId);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const activation = this.#activations.get(handle.activationId);
    if (activation === undefined) {
      await this.destroy(handle);
      return;
    }
    this.#owned(handle);
    await this.#stopTracked(activation);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const activation = this.#activations.get(handle.activationId);
    if (activation !== undefined) {
      this.#owned(handle);
      await this.#stopTracked(activation);
      return;
    }
    const manifest = await this.#readManifest(handle.activationId);
    if (manifest === undefined) {
      if (await this.#vmExists(handle.runtimeName)) {
        throw new SandboxManagerError(
          "microvm_identity_unverified",
          "Docker Sandbox microVM identity could not be verified",
          false,
        );
      }
      return;
    }
    this.#assertHandle(manifest, handle);
    await this.#removeVm(manifest.vmName);
    await this.#removeState(manifest.activationId, manifest.stageDirectory);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspection> {
    const activation = this.#activations.get(handle.activationId);
    if (activation === undefined) {
      const manifest = await this.#readManifest(handle.activationId);
      if (manifest === undefined || !(await this.#vmExists(handle.runtimeName))) {
        return {
          providerApiVersion: 1,
          providerId: this.providerId,
          state: "absent",
          handle,
        };
      }
      this.#assertHandle(manifest, handle);
      const inner = this.#innerProvider(manifest.vmName);
      try {
        const inspected = await inner.inspect(manifest.innerHandle);
        return await this.#wrapInspection(handle, manifest.vmName, inspected);
      } finally {
        await inner.close();
      }
    }
    this.#owned(handle);
    const inspected = await activation.innerProvider.inspect(activation.manifest.innerHandle);
    return this.#wrapInspection(handle, activation.manifest.vmName, inspected);
  }

  async destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const tracked = this.#activations.get(activationId);
    if (tracked !== undefined) {
      if (!sameAssignment(tracked.manifest.assignment, assignment)) {
        throw new SandboxManagerError(
          "tool_sandbox_identity_mismatch",
          "Tool Sandbox assignment identity did not match",
          false,
        );
      }
      await this.#stopTracked(tracked);
      return;
    }
    const manifest = await this.#readManifest(activationId);
    if (manifest === undefined) {
      if (await this.#vmExists(microvmName(activationId))) {
        throw new SandboxManagerError(
          "microvm_identity_unverified",
          "Docker Sandbox microVM identity could not be verified",
          false,
        );
      }
      return;
    }
    if (!sameAssignment(manifest.assignment, assignment)) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox assignment identity did not match",
        false,
      );
    }
    await this.#removeVm(manifest.vmName);
    await this.#removeState(manifest.activationId, manifest.stageDirectory);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    bounded(sandboxId, "Sandbox ID", 512);
    const vmNames = await this.#vmNames();
    const assignments: SupervisorRuntimeAssignment[] = [];
    for (const manifest of await this.#readManifests()) {
      if (manifest.assignment.sandboxId !== sandboxId || !vmNames.has(manifest.vmName)) continue;
      const inner = this.#innerProvider(manifest.vmName);
      try {
        const candidates = await inner.listAssignments(sandboxId);
        const candidate = candidates.find(
          (value) =>
            value.containerId === manifest.innerHandle.runtimeId &&
            assignmentMatchesRuntime(manifest.assignment, value),
        );
        if (candidate === undefined) {
          await this.#removeVm(manifest.vmName);
          await this.#removeState(manifest.activationId, manifest.stageDirectory);
          continue;
        }
        assignments.push({ ...candidate, containerName: manifest.vmName });
      } finally {
        await inner.close();
      }
    }
    return assignments.sort((left, right) => left.containerName.localeCompare(right.containerName));
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const tracked = [...this.#activations.values()].find(
      (value) => value.manifest.outerHandle.runtimeId === assignment.containerId,
    );
    if (tracked !== undefined) {
      this.#assertRuntimeAssignment(tracked.manifest, assignment);
      await this.#stopTracked(tracked);
      return;
    }
    const manifest = (await this.#readManifests()).find(
      (value) => value.outerHandle.runtimeId === assignment.containerId,
    );
    if (manifest === undefined) {
      if (await this.#vmExists(assignment.containerName)) {
        throw new SandboxManagerError(
          "microvm_identity_unverified",
          "Docker Sandbox microVM identity could not be verified",
          false,
        );
      }
      return;
    }
    this.#assertRuntimeAssignment(manifest, assignment);
    await this.#removeVm(manifest.vmName);
    await this.#removeState(manifest.activationId, manifest.stageDirectory);
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    if (await this.#vmExists(assignment.containerName)) {
      throw new SandboxManagerError(
        "microvm_assignment_still_alive",
        "Docker Sandbox microVM absence could not be confirmed",
        false,
      );
    }
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    return this.#repositoryImporter.importGitHub(source, signal);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#activations.values()].map((activation) => this.#stopTracked(activation)),
    );
    await this.#repositoryImporter.close();
    if (results.some((result) => result.status === "rejected")) {
      throw new SandboxManagerError(
        "microvm_cleanup_unverified",
        "Docker Sandbox microVM shutdown could not confirm complete cleanup",
        true,
      );
    }
  }

  #innerProvider(vmName: string): DockerSandboxProvider {
    return new DockerSandboxProvider({
      toolImage: this.#toolImage,
      repositoryImportNetwork: this.#repositoryImportNetwork,
      dockerCommand: this.#dockerCommand,
      dockerArgumentsPrefix: ["sandbox", "exec", "--interactive", vmName, "docker"],
      readyTimeoutMs: this.#operationTimeoutMs,
      cleanupTimeoutMs: this.#operationTimeoutMs,
    });
  }

  #owned(handle: SandboxHandle): MicrovmActivation {
    const activation = this.#activations.get(handle.activationId);
    if (activation === undefined) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
    this.#assertHandle(activation.manifest, handle);
    return activation;
  }

  #assertHandle(manifest: MicrovmManifest, handle: SandboxHandle): void {
    if (
      handle.providerApiVersion !== 1 ||
      handle.providerId !== this.providerId ||
      handle.activationId !== manifest.activationId ||
      handle.runtimeId !== manifest.outerHandle.runtimeId ||
      handle.runtimeName !== manifest.vmName ||
      handle.workspaceRoot !== "/workspace" ||
      !sameAssignment(handle.assignment, manifest.assignment)
    ) {
      throw new SandboxManagerError(
        "tool_sandbox_identity_mismatch",
        "Tool Sandbox handle identity did not match",
        false,
      );
    }
  }

  #assertRuntimeAssignment(
    manifest: MicrovmManifest,
    assignment: SupervisorRuntimeAssignment,
  ): void {
    if (
      assignment.containerId !== manifest.outerHandle.runtimeId ||
      assignment.containerName !== manifest.vmName ||
      !assignmentMatchesRuntime(manifest.assignment, assignment)
    ) {
      throw new SandboxManagerError(
        "microvm_assignment_identity_mismatch",
        "Docker Sandbox microVM assignment identity did not match",
        false,
      );
    }
  }

  async #wrapInspection(
    handle: SandboxHandle,
    vmName: string,
    inspected: SandboxInspection,
  ): Promise<SandboxInspection> {
    if (inspected.state === "absent") {
      return {
        providerApiVersion: 1,
        providerId: this.providerId,
        state: "absent",
        handle,
      };
    }
    const kernel = await this.#mustExecute(
      ["sandbox", "exec", vmName, "uname", "-r"],
      this.#operationTimeoutMs,
      "Docker Sandbox guest kernel could not be inspected",
      128 * 1_024,
    );
    const guestKernelRelease = bounded(kernel.stdout.trim(), "Guest kernel release", 256);
    return {
      providerApiVersion: 1,
      providerId: this.providerId,
      state: inspected.state,
      handle,
      effectiveIsolation: {
        ...inspected.effectiveIsolation,
        isolationBoundary: "microvm",
        outerNetworkPolicy: "deny_all",
        guestKernelRelease,
      },
    };
  }

  async #stopTracked(activation: MicrovmActivation): Promise<void> {
    this.#activations.delete(activation.manifest.activationId);
    const results = await Promise.allSettled([
      activation.innerProvider.stop(activation.manifest.innerHandle),
    ]);
    await activation.innerProvider.close().catch(() => undefined);
    await this.#removeVm(activation.manifest.vmName);
    await this.#removeState(activation.manifest.activationId, activation.manifest.stageDirectory);
    if (results.some((result) => result.status === "rejected")) {
      throw new SandboxManagerError(
        "microvm_inner_cleanup_failed",
        "Nested Tool Sandbox cleanup required microVM destruction",
        true,
      );
    }
  }

  async #initializeState(): Promise<void> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#stateDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SandboxManagerError(
        "microvm_state_invalid",
        "Docker microVM state directory is invalid",
        false,
      );
    }
    await chmod(this.#stateDirectory, 0o700);
    await Promise.all([
      mkdir(join(this.#stateDirectory, "images"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.#stateDirectory, "activations"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.#stateDirectory, "manifests"), { recursive: true, mode: 0o700 }),
    ]);
  }

  async #ensureImageArchive(): Promise<Readonly<{ imageId: string; path: string }>> {
    this.#imageArchive ??= (async () => {
      const inspected = await this.#mustExecute(
        ["image", "inspect", "--format", "{{.Id}}", this.#toolImage],
        this.#operationTimeoutMs,
        "Docker microVM Tool image is unavailable",
        128 * 1_024,
      );
      const imageId = inspected.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        throw new SandboxManagerError(
          "microvm_tool_image_invalid",
          "Docker microVM Tool image identity was invalid",
          false,
        );
      }
      const path = join(this.#stateDirectory, "images", `${imageId.slice(7)}.tar`);
      const existing = await stat(path).catch(() => undefined);
      if (existing?.isFile() && existing.size > 0) return { imageId, path };
      const temporary = `${path}.partial-${randomUUID()}`;
      const saved = await execute(
        this.#dockerCommand,
        ["image", "save", "--output", temporary, this.#toolImage],
        this.#createTimeoutMs,
        1 * 1_024 * 1_024,
      );
      if (saved.code !== 0) {
        await unlink(temporary).catch(() => undefined);
        throw new SandboxManagerError(
          "microvm_tool_image_export_failed",
          "Docker microVM Tool image could not be exported",
          true,
        );
      }
      await chmod(temporary, 0o400);
      await rename(temporary, path);
      return { imageId, path };
    })();
    return this.#imageArchive;
  }

  async #workspaceTarget(vmName: string, stageDirectory: string): Promise<string> {
    const result = await this.#mustExecute(
      ["sandbox", "exec", vmName, "findmnt", "-rn", "-t", "virtiofs", "-o", "TARGET"],
      this.#operationTimeoutMs,
      "Docker Sandbox workspace mount could not be inspected",
      128 * 1_024,
    );
    const expectedBase = basename(stageDirectory);
    const targets = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.startsWith("/") && basename(value) === expectedBase);
    if (targets.length !== 1) {
      throw new SandboxManagerError(
        "microvm_workspace_ambiguous",
        "Docker Sandbox workspace mount was ambiguous",
        false,
      );
    }
    return bounded(targets[0]!, "Docker Sandbox workspace target", 4_096);
  }

  async #vmNames(): Promise<ReadonlySet<string>> {
    const result = await this.#mustExecute(
      ["sandbox", "ls", "--json"],
      this.#operationTimeoutMs,
      "Docker Sandbox microVM inventory is unavailable",
      2 * 1_024 * 1_024,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new SandboxManagerError(
        "microvm_inventory_malformed",
        "Docker Sandbox microVM inventory was malformed",
        false,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new SandboxManagerError(
        "microvm_inventory_malformed",
        "Docker Sandbox microVM inventory was malformed",
        false,
      );
    }
    const candidate = parsed as { vms?: unknown; sandboxes?: unknown };
    const entries = Array.isArray(candidate.vms)
      ? candidate.vms
      : Array.isArray(candidate.sandboxes)
        ? candidate.sandboxes
        : undefined;
    if (entries === undefined || entries.length > 1_024) {
      throw new SandboxManagerError(
        "microvm_inventory_malformed",
        "Docker Sandbox microVM inventory was malformed",
        false,
      );
    }
    const names = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(name)) names.add(name);
    }
    return names;
  }

  async #vmExists(vmName: string): Promise<boolean> {
    return (await this.#vmNames()).has(vmName);
  }

  async #removeVm(vmName: string): Promise<void> {
    if (!(await this.#vmExists(vmName))) return;
    const removed = await execute(
      this.#dockerCommand,
      ["sandbox", "rm", vmName],
      this.#createTimeoutMs,
      2 * 1_024 * 1_024,
    );
    if (removed.code !== 0 && (await this.#vmExists(vmName))) {
      throw new SandboxManagerError(
        "microvm_cleanup_unverified",
        "Docker Sandbox microVM could not be removed",
        true,
      );
    }
    if (await this.#vmExists(vmName)) {
      throw new SandboxManagerError(
        "microvm_cleanup_unverified",
        "Docker Sandbox microVM removal could not be confirmed",
        true,
      );
    }
  }

  #stageDirectory(activationId: string): string {
    return join(this.#stateDirectory, "activations", activationId);
  }

  #manifestPath(activationId: string): string {
    return join(this.#stateDirectory, "manifests", `${activationId}.json`);
  }

  async #writeManifest(manifest: MicrovmManifest): Promise<void> {
    const path = this.#manifestPath(manifest.activationId);
    const temporary = `${path}.partial-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  }

  async #readManifest(activationId: string): Promise<MicrovmManifest | undefined> {
    const path = this.#manifestPath(activationId);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      },
    );
    if (handle === undefined) return undefined;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > 64 * 1_024) {
        throw new Error("invalid manifest file");
      }
      const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
      const manifest = parseManifest(parsed);
      if (
        manifest.activationId !== activationId ||
        resolve(manifest.stageDirectory) !== this.#stageDirectory(activationId)
      ) {
        throw new Error("manifest path mismatch");
      }
      return manifest;
    } catch {
      throw new SandboxManagerError(
        "microvm_manifest_invalid",
        "Docker Sandbox microVM manifest was invalid",
        false,
      );
    } finally {
      await handle.close();
    }
  }

  async #readManifests(): Promise<readonly MicrovmManifest[]> {
    const directory = join(this.#stateDirectory, "manifests");
    const names = (await readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
    if (names.length > 1_024) {
      throw new SandboxManagerError(
        "microvm_inventory_ambiguous",
        "Docker Sandbox microVM manifest inventory exceeded its limit",
        false,
      );
    }
    const manifests: MicrovmManifest[] = [];
    for (const name of names) {
      const manifest = await this.#readManifest(name.slice(0, -5));
      if (manifest !== undefined) manifests.push(manifest);
    }
    return manifests;
  }

  async #removeState(activationId: string, stageDirectory: string): Promise<void> {
    if (
      resolve(stageDirectory) !== this.#stageDirectory(activationId) ||
      dirname(resolve(stageDirectory)) !== join(this.#stateDirectory, "activations")
    ) {
      throw new SandboxManagerError(
        "microvm_state_invalid",
        "Docker microVM cleanup path was invalid",
        false,
      );
    }
    await unlink(this.#manifestPath(activationId)).catch((error: unknown) => {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    });
    await rm(stageDirectory, { recursive: true, force: true });
  }

  async #removeManifestsWithoutVms(): Promise<void> {
    const names = await this.#vmNames();
    for (const manifest of await this.#readManifests()) {
      if (!names.has(manifest.vmName)) {
        await this.#removeState(manifest.activationId, manifest.stageDirectory);
      }
    }
  }

  async #pathExists(path: string): Promise<boolean> {
    return (await lstat(path).catch(() => undefined)) !== undefined;
  }

  async #mustExecute(
    argumentsValue: readonly string[],
    timeoutMs: number,
    safeMessage: string,
    maximumBytes = MAX_COMMAND_OUTPUT_BYTES,
  ): Promise<CommandResult> {
    const result = await execute(this.#dockerCommand, argumentsValue, timeoutMs, maximumBytes);
    if (result.code !== 0) {
      throw new SandboxManagerError("microvm_command_failed", safeMessage, true);
    }
    return result;
  }
}
