import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@agent-dock/protocol";
import {
  collectExternalGitWorkspacePatch,
  initializeExternalGitWorkspaceBaseline,
  inspectExternalGitWorkspaceBaseline,
} from "@agent-dock/workspace-runtime";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { fetch } from "undici";

const executeFile = promisify(execFile);
const VOLUME_ID_PATTERN = /^adw-[0-9a-f]{48}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,4096}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VOLUME_GENERATION_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VOLUME_METADATA_DIRECTORY = ".agent-dock-runtime";
const VOLUME_WORKSPACE_DIRECTORY = "workspace";
const VOLUME_GENERATION_FILE = "generation";
const VOLUME_GIT_DIRECTORY = "git";
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_REQUEST_BYTES = 32 * 1_024;
const MAXIMUM_RESPONSE_BYTES = MAXIMUM_REQUEST_BYTES + 2 * MAX_WORKSPACE_PATCH_BYTES;

const WORKSPACE_DATA_MOVER_PREPARE_PATH = "/v1/workspaces/prepare";
const WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH = "/v1/workspaces/initialize-baseline";
const WORKSPACE_DATA_MOVER_SNAPSHOT_PATH = "/v1/workspaces/snapshot";
const WORKSPACE_DATA_MOVER_MATERIALIZE_PATH = "/v1/workspaces/materialize";

export type WorkspaceDataMoverIdentity = Readonly<{
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  volumeId: string;
}>;

export type WorkspaceDataMoverPrepareInput = WorkspaceDataMoverIdentity &
  Readonly<{ snapshotId?: string; gitBaselineCommit?: string }>;

export type WorkspaceDataMoverInitializeBaselineInput = WorkspaceDataMoverIdentity;

export type WorkspaceDataMoverSnapshotInput = WorkspaceDataMoverIdentity &
  Readonly<{
    activationId: string;
    fencingToken: number;
    bindingSha256: string;
  }>;

export type WorkspaceDataMoverMaterializeInput = WorkspaceDataMoverIdentity &
  Readonly<{
    snapshotId: string;
    path: string;
    expectedSha256: string;
    maximumBytes: number;
  }>;

export interface WorkspaceDataMover {
  checkHealth(): Promise<void>;
  prepare(input: WorkspaceDataMoverPrepareInput): Promise<{ restored: boolean }>;
  initializeBaseline(
    input: WorkspaceDataMoverInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }>;
  snapshot(input: WorkspaceDataMoverSnapshotInput): Promise<{
    snapshotId: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
  }>;
  materialize(
    input: WorkspaceDataMoverMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }>;
  close(): Promise<void>;
}

export type KopiaWorkspaceDataMoverOptions = Readonly<{
  workspaceRoot: string;
  stateRoot: string;
  kopiaBinary?: string;
  kopiaConfigPath: string;
  kopiaCacheDirectory: string;
  repositoryPassword: string;
  s3: Readonly<{
    bucket: string;
    endpoint: string;
    region: string;
    prefix: string;
    accessKey: string;
    secretAccessKey: string;
    disableTls: boolean;
  }>;
  commandTimeoutMs?: number;
}>;

type VolumeState = Readonly<{
  schemaVersion: 4;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  volumeId: string;
  snapshotId: string;
  volumeGeneration: string;
  gitBaselineCommit: string;
}>;

export class WorkspaceDataMoverError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "WorkspaceDataMoverError";
    this.code = code;
    this.retryable = retryable;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function boundedOpaque(value: string, name: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new WorkspaceDataMoverError(
      "workspace_data_identity_invalid",
      `${name} was invalid`,
      false,
    );
  }
  return value;
}

export function workspaceVolumeId(identity: {
  tenantId: string;
  workspaceId: string;
  sessionId: string;
}): string {
  boundedOpaque(identity.tenantId, "tenantId");
  boundedOpaque(identity.workspaceId, "workspaceId");
  boundedOpaque(identity.sessionId, "sessionId");
  return `adw-${createHash("sha256")
    .update("agent-dock.workspace-volume.v1\0")
    .update(identity.tenantId)
    .update("\0")
    .update(identity.workspaceId)
    .update("\0")
    .update(identity.sessionId)
    .digest("hex")
    .slice(0, 48)}`;
}

function validatedIdentity(input: WorkspaceDataMoverIdentity): WorkspaceDataMoverIdentity {
  const identity = Object.freeze({
    tenantId: boundedOpaque(input.tenantId, "tenantId"),
    workspaceId: boundedOpaque(input.workspaceId, "workspaceId"),
    sessionId: boundedOpaque(input.sessionId, "sessionId"),
    volumeId: input.volumeId,
  });
  if (
    !VOLUME_ID_PATTERN.test(identity.volumeId) ||
    workspaceVolumeId(identity) !== identity.volumeId
  ) {
    throw new WorkspaceDataMoverError(
      "workspace_data_binding_invalid",
      "Workspace volume binding was invalid",
      false,
    );
  }
  return identity;
}

function validatedSnapshotId(value: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(value)) {
    throw new WorkspaceDataMoverError(
      "workspace_snapshot_identity_invalid",
      "Workspace snapshot identity was invalid",
      false,
    );
  }
  return value;
}

function validatedGitBaselineCommit(value: string): string {
  if (!GIT_COMMIT_PATTERN.test(value)) {
    throw new WorkspaceDataMoverError(
      "workspace_git_baseline_invalid",
      "Workspace Git baseline was invalid",
      false,
    );
  }
  return value;
}

function validatedAbsoluteDirectory(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativeFile(value: string): string {
  if (
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new WorkspaceDataMoverError(
      "workspace_materialize_path_invalid",
      "Workspace materialize path was invalid",
      false,
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WorkspaceDataMoverError(
      "workspace_materialize_path_invalid",
      "Workspace materialize path was invalid",
      false,
    );
  }
  return value;
}

function commandOutput(error: unknown): string {
  if (!isRecord(error)) return "";
  const stderr = error.stderr;
  return typeof stderr === "string" ? stderr.slice(0, 2_048) : "";
}

export class KopiaWorkspaceDataMover implements WorkspaceDataMover {
  readonly #workspaceRoot: string;
  readonly #stateRoot: string;
  readonly #kopiaBinary: string;
  readonly #kopiaConfigPath: string;
  readonly #kopiaCacheDirectory: string;
  readonly #kopiaLogDirectory = "/tmp/agent-dock-kopia-logs";
  readonly #repositoryPassword: string;
  readonly #s3: KopiaWorkspaceDataMoverOptions["s3"];
  readonly #commandTimeoutMs: number;
  readonly #locks = new Map<string, Promise<void>>();
  #ready: Promise<void> | undefined;

  constructor(options: KopiaWorkspaceDataMoverOptions) {
    this.#workspaceRoot = validatedAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    this.#stateRoot = validatedAbsoluteDirectory(options.stateRoot, "stateRoot");
    this.#kopiaBinary = options.kopiaBinary ?? "/usr/local/bin/kopia";
    if (!isAbsolute(this.#kopiaBinary) || this.#kopiaBinary.includes("\0")) {
      throw new TypeError("kopiaBinary must be an absolute path");
    }
    this.#kopiaConfigPath = validatedAbsoluteDirectory(options.kopiaConfigPath, "kopiaConfigPath");
    this.#kopiaCacheDirectory = validatedAbsoluteDirectory(
      options.kopiaCacheDirectory,
      "kopiaCacheDirectory",
    );
    if (
      options.repositoryPassword.length < 32 ||
      options.repositoryPassword.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(options.repositoryPassword)
    ) {
      throw new TypeError("Kopia repository password was invalid");
    }
    for (const [name, value] of Object.entries(options.s3)) {
      if (
        typeof value === "string" &&
        (value.length < 1 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value))
      ) {
        throw new TypeError(`Kopia S3 ${name} was invalid`);
      }
    }
    this.#repositoryPassword = options.repositoryPassword;
    this.#s3 = Object.freeze({ ...options.s3 });
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
    if (
      !Number.isSafeInteger(this.#commandTimeoutMs) ||
      this.#commandTimeoutMs < 1_000 ||
      this.#commandTimeoutMs > 60 * 60_000
    ) {
      throw new TypeError("Kopia command timeout was invalid");
    }
  }

  async checkHealth(): Promise<void> {
    await this.#ensureReady();
    await this.#kopia(["repository", "status", "--json"], 60_000);
  }

  async prepare(input: WorkspaceDataMoverPrepareInput): Promise<{ restored: boolean }> {
    const identity = validatedIdentity(input);
    const snapshotId =
      input.snapshotId === undefined ? undefined : validatedSnapshotId(input.snapshotId);
    const gitBaselineCommit =
      input.gitBaselineCommit === undefined
        ? undefined
        : validatedGitBaselineCommit(input.gitBaselineCommit);
    if ((snapshotId === undefined) !== (gitBaselineCommit === undefined)) {
      throw new WorkspaceDataMoverError(
        "workspace_restore_identity_invalid",
        "Workspace restore snapshot and Git baseline must be supplied together",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.#ensureReady();
      const directory = await this.#ensureVolumeDirectory(identity.volumeId);
      if (snapshotId === undefined) {
        await this.#emptyDirectory(directory);
        await this.#removeState(identity.volumeId);
        await this.#createWorkspaceDirectory(directory);
        await this.#createVolumeGeneration(directory);
        return { restored: false };
      }
      if (gitBaselineCommit === undefined) {
        throw new WorkspaceDataMoverError(
          "workspace_restore_identity_invalid",
          "Workspace restore Git baseline was missing",
          false,
        );
      }
      // Reuse requires both the trusted sidecar and the generation marker
      // carried by the live POSIX volume. The sidecar alone cannot distinguish
      // a healthy warm Workspace from a volume whose contents were lost while
      // its host directory survived.
      const state = await this.#readState(identity.volumeId);
      const volumeGeneration = await this.#readVolumeGeneration(directory);
      const workspaceValid = await this.#hasValidWorkspaceDirectory(directory);
      if (
        state !== undefined &&
        state.tenantId === identity.tenantId &&
        state.workspaceId === identity.workspaceId &&
        state.sessionId === identity.sessionId &&
        state.volumeId === identity.volumeId &&
        state.snapshotId === snapshotId &&
        volumeGeneration === state.volumeGeneration &&
        state.gitBaselineCommit === gitBaselineCommit &&
        (await this.#readGitBaseline(directory)) === gitBaselineCommit &&
        workspaceValid
      ) {
        return { restored: false };
      }
      await this.#emptyDirectory(directory);
      try {
        await this.#kopia([
          "snapshot",
          "restore",
          "--write-files-atomically",
          "--flush-files",
          "--skip-owners",
          snapshotId,
          directory,
        ]);
        const restoredGeneration = await this.#readVolumeGeneration(directory);
        if (
          restoredGeneration === undefined ||
          !(await this.#hasValidWorkspaceDirectory(directory)) ||
          (await this.#readGitBaseline(directory)) !== gitBaselineCommit
        ) {
          throw new WorkspaceDataMoverError(
            "workspace_restore_generation_invalid",
            "Committed Workspace snapshot did not contain a valid Volume envelope and Git baseline",
            false,
          );
        }
        await this.#writeState({
          schemaVersion: 4,
          ...identity,
          snapshotId,
          volumeGeneration: restoredGeneration,
          gitBaselineCommit,
        });
        return { restored: true };
      } catch (error: unknown) {
        await this.#emptyDirectory(directory).catch(() => undefined);
        await this.#removeState(identity.volumeId).catch(() => undefined);
        throw new WorkspaceDataMoverError(
          "workspace_restore_failed",
          "Committed Workspace snapshot could not be restored",
          true,
        );
      }
    });
  }

  async initializeBaseline(
    input: WorkspaceDataMoverInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.#ensureReady();
      const directory = await this.#ensureVolumeDirectory(identity.volumeId);
      if (
        (await this.#readVolumeGeneration(directory)) === undefined ||
        !(await this.#hasValidWorkspaceDirectory(directory))
      ) {
        throw new WorkspaceDataMoverError(
          "workspace_volume_generation_invalid",
          "Workspace Volume envelope was invalid",
          false,
        );
      }
      const existing = await this.#readGitBaseline(directory);
      if (existing !== undefined) return { gitBaselineCommit: existing };
      const gitDirectory = join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GIT_DIRECTORY);
      await rm(gitDirectory, { recursive: true, force: true });
      try {
        const gitBaselineCommit = validatedGitBaselineCommit(
          await initializeExternalGitWorkspaceBaseline(this.#externalGitWorkspace(directory)),
        );
        return { gitBaselineCommit };
      } catch {
        await rm(gitDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw new WorkspaceDataMoverError(
          "workspace_git_baseline_initialization_failed",
          "Workspace Git baseline could not be initialized",
          true,
        );
      }
    });
  }

  async snapshot(input: WorkspaceDataMoverSnapshotInput): Promise<{
    snapshotId: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
  }> {
    const identity = validatedIdentity(input);
    if (
      !UUID_PATTERN.test(input.activationId) ||
      !Number.isSafeInteger(input.fencingToken) ||
      input.fencingToken < 1 ||
      !SHA256_PATTERN.test(input.bindingSha256)
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_snapshot_fence_invalid",
        "Workspace snapshot fence was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.#ensureReady();
      const directory = await this.#ensureVolumeDirectory(identity.volumeId);
      const volumeGeneration = await this.#readVolumeGeneration(directory);
      if (volumeGeneration === undefined || !(await this.#hasValidWorkspaceDirectory(directory))) {
        throw new WorkspaceDataMoverError(
          "workspace_volume_generation_invalid",
          "Workspace Volume envelope was invalid",
          false,
        );
      }
      const gitBaselineCommit = await this.#readGitBaseline(directory);
      if (gitBaselineCommit === undefined) {
        throw new WorkspaceDataMoverError(
          "workspace_git_baseline_invalid",
          "Workspace Git baseline was missing or invalid",
          false,
        );
      }
      let workspacePatch: WorkspacePatch;
      try {
        workspacePatch = await collectExternalGitWorkspacePatch(
          this.#externalGitWorkspace(directory),
        );
      } catch {
        throw new WorkspaceDataMoverError(
          "workspace_git_patch_failed",
          "Workspace Patch could not be generated",
          true,
        );
      }
      const output = await this.#kopia([
        "snapshot",
        "create",
        "--json",
        `--description=agent-dock:${input.activationId}:${String(input.fencingToken)}`,
        directory,
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(output.stdout) as unknown;
      } catch {
        throw new WorkspaceDataMoverError(
          "workspace_snapshot_response_invalid",
          "Kopia returned invalid snapshot metadata",
          false,
        );
      }
      if (!isRecord(parsed) || typeof parsed.id !== "string") {
        throw new WorkspaceDataMoverError(
          "workspace_snapshot_response_invalid",
          "Kopia returned invalid snapshot metadata",
          false,
        );
      }
      const snapshotId = validatedSnapshotId(parsed.id);
      await this.#writeState({
        schemaVersion: 4,
        ...identity,
        snapshotId,
        volumeGeneration,
        gitBaselineCommit,
      });
      return { snapshotId, gitBaselineCommit, workspacePatch };
    });
  }

  async materialize(
    input: WorkspaceDataMoverMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const identity = validatedIdentity(input);
    const snapshotId = validatedSnapshotId(input.snapshotId);
    const path = safeRelativeFile(input.path);
    if (
      !SHA256_PATTERN.test(input.expectedSha256) ||
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 8 * 1_024 * 1_024
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_materialize_request_invalid",
        "Workspace materialize request was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.#ensureReady();
      const materializeRoot = join(this.#stateRoot, "materialize");
      await mkdir(materializeRoot, { recursive: true, mode: 0o700 });
      const target = join(
        materializeRoot,
        `${identity.volumeId}-${createHash("sha256").update(path).digest("hex")}`,
      );
      await rm(target, { force: true });
      try {
        await this.#kopia([
          "snapshot",
          "restore",
          "--write-files-atomically",
          "--flush-files",
          "--skip-owners",
          `${snapshotId}/${VOLUME_WORKSPACE_DIRECTORY}/${path}`,
          target,
        ]);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > input.maximumBytes) {
            throw new WorkspaceDataMoverError(
              "workspace_materialize_file_invalid",
              "Workspace materialized file was invalid",
              false,
            );
          }
          const bytes = await handle.readFile();
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== input.expectedSha256) {
            throw new WorkspaceDataMoverError(
              "workspace_materialize_hash_mismatch",
              "Workspace materialized file did not match its committed hash",
              false,
            );
          }
          return { bytes, sha256: actual };
        } finally {
          await handle.close();
        }
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {}

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#initialize().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.#kopiaConfigPath), { recursive: true, mode: 0o700 });
    await mkdir(this.#kopiaCacheDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.#kopiaLogDirectory, { recursive: true, mode: 0o700 });
    try {
      await this.#kopia(["repository", "status", "--json"], 60_000);
      return;
    } catch {
      // A fresh container has no local config. First try connecting to an
      // existing repository so service replacement never initializes a second
      // authority.
    }
    const storage = [
      "--bucket",
      this.#s3.bucket,
      "--endpoint",
      this.#s3.endpoint,
      "--region",
      this.#s3.region,
      "--prefix",
      this.#s3.prefix,
      ...(this.#s3.disableTls ? ["--disable-tls"] : []),
      "--no-persist-credentials",
    ];
    try {
      await this.#kopia(["repository", "connect", "s3", ...storage], 120_000);
      return;
    } catch {
      // Repository creation is idempotent at the backend. If another replica
      // won the race, create fails and the final connect below adopts it.
    }
    try {
      await this.#kopia(["repository", "create", "s3", ...storage], 120_000);
    } catch {
      await this.#kopia(["repository", "connect", "s3", ...storage], 120_000);
    }
  }

  async #kopia(
    args: readonly string[],
    timeout = this.#commandTimeoutMs,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await executeFile(this.#kopiaBinary, args, {
        encoding: "utf8",
        maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
        timeout,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: this.#stateRoot,
          KOPIA_PASSWORD: this.#repositoryPassword,
          KOPIA_CONFIG_PATH: this.#kopiaConfigPath,
          KOPIA_CACHE_DIRECTORY: this.#kopiaCacheDirectory,
          KOPIA_CHECK_FOR_UPDATES: "false",
          // Kopia maintains `latest.log` symlinks. Disposable process logs
          // stay off the backed-up state tree so the backup walker can keep
          // rejecting every symlink without weakening that boundary.
          KOPIA_LOG_DIR: this.#kopiaLogDirectory,
          AWS_ACCESS_KEY_ID: this.#s3.accessKey,
          AWS_SECRET_ACCESS_KEY: this.#s3.secretAccessKey,
          AWS_REGION: this.#s3.region,
        },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error: unknown) {
      throw new WorkspaceDataMoverError(
        "kopia_command_failed",
        `Kopia command failed${commandOutput(error).length === 0 ? "" : " (see trusted logs)"}`,
        true,
      );
    }
  }

  async #ensureVolumeDirectory(volumeId: string): Promise<string> {
    const directory = resolve(this.#workspaceRoot, `agentdock-posix-${volumeId}`);
    if (!directory.startsWith(`${this.#workspaceRoot}${sep}`)) {
      throw new WorkspaceDataMoverError(
        "workspace_volume_path_invalid",
        "Workspace volume path was invalid",
        false,
      );
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceDataMoverError(
        "workspace_volume_path_invalid",
        "Workspace volume path was invalid",
        false,
      );
    }
    await chmod(directory, 0o700);
    return directory;
  }

  async #emptyDirectory(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      await rm(join(directory, entry), { recursive: true, force: true });
    }
  }

  async #createWorkspaceDirectory(directory: string): Promise<void> {
    const workspaceDirectory = join(directory, VOLUME_WORKSPACE_DIRECTORY);
    await mkdir(workspaceDirectory, { mode: 0o700 });
    const metadata = await lstat(workspaceDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceDataMoverError(
        "workspace_volume_path_invalid",
        "Workspace Volume data path was invalid",
        false,
      );
    }
  }

  async #hasValidWorkspaceDirectory(directory: string): Promise<boolean> {
    try {
      const workspaceDirectory = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      const metadata = await lstat(workspaceDirectory);
      return metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }

  #externalGitWorkspace(directory: string): { workTree: string; gitDirectory: string } {
    return {
      workTree: join(directory, VOLUME_WORKSPACE_DIRECTORY),
      gitDirectory: join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GIT_DIRECTORY),
    };
  }

  async #readGitBaseline(directory: string): Promise<string | undefined> {
    try {
      const gitDirectory = join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GIT_DIRECTORY);
      const metadata = await lstat(gitDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
      return validatedGitBaselineCommit(
        await inspectExternalGitWorkspaceBaseline(this.#externalGitWorkspace(directory)),
      );
    } catch {
      return undefined;
    }
  }

  async #createVolumeGeneration(directory: string): Promise<string> {
    const metadataDirectory = join(directory, VOLUME_METADATA_DIRECTORY);
    await mkdir(metadataDirectory, { mode: 0o700 });
    const generation = randomBytes(32).toString("hex");
    await writeFile(join(metadataDirectory, VOLUME_GENERATION_FILE), `${generation}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    return generation;
  }

  async #readVolumeGeneration(directory: string): Promise<string | undefined> {
    const metadataDirectory = join(directory, VOLUME_METADATA_DIRECTORY);
    const generationPath = join(metadataDirectory, VOLUME_GENERATION_FILE);
    try {
      const [directoryMetadata, generationMetadata, generation] = await Promise.all([
        lstat(metadataDirectory),
        lstat(generationPath),
        readFile(generationPath, "utf8"),
      ]);
      const normalized = generation.trim();
      if (
        !directoryMetadata.isDirectory() ||
        directoryMetadata.isSymbolicLink() ||
        !generationMetadata.isFile() ||
        generationMetadata.isSymbolicLink() ||
        generationMetadata.size !== 65 ||
        !VOLUME_GENERATION_PATTERN.test(normalized)
      ) {
        return undefined;
      }
      return normalized;
    } catch {
      return undefined;
    }
  }

  #statePath(volumeId: string): string {
    return join(this.#stateRoot, "volumes", `${volumeId}.json`);
  }

  async #writeState(state: VolumeState): Promise<void> {
    const path = this.#statePath(state.volumeId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #readState(volumeId: string): Promise<VolumeState | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#statePath(volumeId), "utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join("\0") !==
        [
          "gitBaselineCommit",
          "schemaVersion",
          "sessionId",
          "snapshotId",
          "tenantId",
          "volumeGeneration",
          "volumeId",
          "workspaceId",
        ]
          .sort()
          .join("\0") ||
      value.schemaVersion !== 4 ||
      typeof value.tenantId !== "string" ||
      typeof value.workspaceId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.volumeId !== "string" ||
      typeof value.snapshotId !== "string" ||
      typeof value.volumeGeneration !== "string" ||
      !VOLUME_GENERATION_PATTERN.test(value.volumeGeneration) ||
      typeof value.gitBaselineCommit !== "string" ||
      !GIT_COMMIT_PATTERN.test(value.gitBaselineCommit)
    ) {
      return undefined;
    }
    try {
      const identity = validatedIdentity({
        tenantId: value.tenantId,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        volumeId: value.volumeId,
      });
      return {
        schemaVersion: 4,
        ...identity,
        snapshotId: validatedSnapshotId(value.snapshotId),
        volumeGeneration: value.volumeGeneration,
        gitBaselineCommit: value.gitBaselineCommit,
      };
    } catch {
      return undefined;
    }
  }

  async #removeState(volumeId: string): Promise<void> {
    await rm(this.#statePath(volumeId), { force: true });
  }

  async #withVolumeLock<T>(volumeId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(volumeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.then(() => current);
    this.#locks.set(volumeId, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.#locks.get(volumeId) === queued) this.#locks.delete(volumeId);
    }
  }
}

export type WorkspaceDataMoverServerOptions = Readonly<{
  host: string;
  port: number;
  serviceToken: string;
  mover: WorkspaceDataMover;
}>;

export class WorkspaceDataMoverServer {
  readonly #server: FastifyInstance;
  readonly #host: string;
  readonly #port: number;
  readonly #tokenDigest: Buffer;
  readonly #mover: WorkspaceDataMover;
  #address: string | undefined;

  constructor(options: WorkspaceDataMoverServerOptions) {
    if (!TOKEN_PATTERN.test(options.serviceToken)) {
      throw new TypeError("Workspace Data Mover service token was invalid");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#tokenDigest = digest(options.serviceToken);
    this.#mover = options.mover;
    this.#server = Fastify({
      logger: false,
      bodyLimit: MAXIMUM_REQUEST_BYTES,
      requestTimeout: 11 * 60_000,
    });
    this.#routes();
  }

  async listen(): Promise<string> {
    await this.#mover.checkHealth();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    return this.#address;
  }

  async close(): Promise<void> {
    await this.#mover.close();
    if (this.#address !== undefined) await this.#server.close();
    this.#address = undefined;
  }

  #authorized(value: string | undefined): boolean {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value ?? "");
    const token = match?.[1];
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return match !== null && timingSafeEqual(candidate, this.#tokenDigest);
  }

  #routes(): void {
    this.#server.get("/health/live", async () => ({ status: "ok" }));
    this.#server.get("/health/ready", async (_request, reply) => {
      try {
        await this.#mover.checkHealth();
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "not_ready" });
      }
    });
    this.#server.addHook("preHandler", async (request, reply) => {
      if (request.url.startsWith("/health/")) return;
      if (!this.#authorized(request.headers.authorization)) {
        return reply.code(401).send({ error: { code: "unauthorized", retryable: false } });
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_PREPARE_PATH, async (request, reply) => {
      try {
        return await this.#mover.prepare(request.body as WorkspaceDataMoverPrepareInput);
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH, async (request, reply) => {
      try {
        return await this.#mover.initializeBaseline(
          request.body as WorkspaceDataMoverInitializeBaselineInput,
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_SNAPSHOT_PATH, async (request, reply) => {
      try {
        return await this.#mover.snapshot(request.body as WorkspaceDataMoverSnapshotInput);
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_MATERIALIZE_PATH, async (request, reply) => {
      try {
        const result = await this.#mover.materialize(
          request.body as WorkspaceDataMoverMaterializeInput,
        );
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-length", result.bytes.byteLength)
          .send(Buffer.from(result.bytes));
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
  }

  #failure(reply: FastifyReply, error: unknown): unknown {
    const failure =
      error instanceof WorkspaceDataMoverError
        ? error
        : new WorkspaceDataMoverError(
            "workspace_data_mover_failed",
            "Workspace Data Mover operation failed",
            true,
          );
    return reply.code(failure.retryable ? 503 : 409).send({
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    });
  }
}

export type HttpWorkspaceDataMoverOptions = Readonly<{
  baseUrl: string;
  serviceToken: string;
  requestTimeoutMs?: number;
}>;

export class HttpWorkspaceDataMover implements WorkspaceDataMover {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpWorkspaceDataMoverOptions) {
    const url = new URL(options.baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== "" ||
      !TOKEN_PATTERN.test(options.serviceToken)
    ) {
      throw new TypeError("Workspace Data Mover client configuration was invalid");
    }
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#serviceToken = options.serviceToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 11 * 60_000;
  }

  async checkHealth(): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/health/ready`, {
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_unavailable",
        "Workspace Data Mover was unavailable",
        true,
      );
    }
  }

  prepare(input: WorkspaceDataMoverPrepareInput): Promise<{ restored: boolean }> {
    return this.#request(WORKSPACE_DATA_MOVER_PREPARE_PATH, input) as Promise<{
      restored: boolean;
    }>;
  }

  async initializeBaseline(
    input: WorkspaceDataMoverInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }> {
    const response = await this.#request(WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).length !== 1 ||
      typeof response.gitBaselineCommit !== "string"
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return { gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit) };
  }

  async snapshot(input: WorkspaceDataMoverSnapshotInput): Promise<{
    snapshotId: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
  }> {
    const response = await this.#request(WORKSPACE_DATA_MOVER_SNAPSHOT_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join("\0") !==
        ["gitBaselineCommit", "snapshotId", "workspacePatch"].sort().join("\0") ||
      typeof response.snapshotId !== "string" ||
      typeof response.gitBaselineCommit !== "string" ||
      !isRecord(response.workspacePatch) ||
      Object.keys(response.workspacePatch).sort().join("\0") !==
        ["format", "patch", "truncated"].sort().join("\0") ||
      response.workspacePatch.format !== "unified_diff" ||
      typeof response.workspacePatch.patch !== "string" ||
      Buffer.byteLength(response.workspacePatch.patch, "utf8") > MAX_WORKSPACE_PATCH_BYTES ||
      typeof response.workspacePatch.truncated !== "boolean"
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return {
      snapshotId: validatedSnapshotId(response.snapshotId),
      gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit),
      workspacePatch: {
        format: "unified_diff",
        patch: response.workspacePatch.patch,
        truncated: response.workspacePatch.truncated,
      },
    };
  }

  async materialize(
    input: WorkspaceDataMoverMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const response = await fetch(`${this.#baseUrl}${WORKSPACE_DATA_MOVER_MATERIALIZE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_request_failed",
        "Workspace Data Mover request failed",
        response.status >= 500,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > input.maximumBytes)
    ) {
      await response.body?.cancel();
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > input.maximumBytes) {
          await reader.cancel();
          throw new WorkspaceDataMoverError(
            "workspace_data_mover_response_invalid",
            "Workspace Data Mover response was invalid",
            false,
          );
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return { bytes, sha256 };
  }

  async close(): Promise<void> {}

  async #request(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_request_failed",
        "Workspace Data Mover request failed",
        response.status >= 500,
      );
    }
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return JSON.parse(text) as unknown;
  }
}
