import {
  captureWorkspaceIndex,
  collectExternalGitWorkspacePatch,
  initializeExternalGitWorkspaceBaseline,
  inspectExternalGitWorkspaceBaseline,
} from "@pi-cloud/workspace-runtime";
import type { WorkspacePatch } from "@pi-cloud/protocol";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  GIT_COMMIT_PATTERN,
  SHA256_PATTERN,
  UUID_PATTERN,
  VOLUME_GENERATION_FILE,
  VOLUME_GENERATION_PATTERN,
  VOLUME_GIT_DIRECTORY,
  VOLUME_METADATA_DIRECTORY,
  VOLUME_WORKSPACE_DIRECTORY,
  WorkspaceVolumeGatewayError,
  isRecord,
  safeRelativeFile,
  validatedAbsoluteDirectory,
  validatedGitBaselineCommit,
  validatedIdentity,
  validatedVolumeIdentity,
  type PersistentVolumeWorkspaceVolumeGatewayOptions,
  type VolumeState,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayLock,
  type WorkspaceVolumeGatewayInitializeBaselineInput,
  type WorkspaceVolumeGatewayMaterializeInput,
  type WorkspaceVolumeGatewayDeleteInput,
  type WorkspaceVolumeGatewayForkInput,
  type WorkspaceVolumeGatewayPrepareInput,
  type WorkspaceVolumeGatewaySnapshotInput,
} from "./workspace-volume-gateway-contract.ts";

/** Trusted direct access to Cube's durable POSIX Workspace volumes. */
export class PersistentVolumeWorkspaceVolumeGateway implements WorkspaceVolumeGateway {
  readonly #workspaceRoot: string;
  readonly #distributedLock: WorkspaceVolumeGatewayLock | undefined;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: PersistentVolumeWorkspaceVolumeGatewayOptions) {
    this.#workspaceRoot = validatedAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    this.#distributedLock = options.lock;
  }

  async checkHealth(): Promise<void> {
    await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#workspaceRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_root_invalid",
        "Persistent Workspace Volume root was invalid",
        false,
      );
    }
  }

  async prepare(input: WorkspaceVolumeGatewayPrepareInput): Promise<{ attached: boolean }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      await this.checkHealth();
      const directory = await this.#ensureVolumeDirectory(identity.volumeId);
      const state = await this.#readState(directory);
      const generation = await this.#readVolumeGeneration(directory);
      const workspaceValid = await this.#hasValidWorkspaceDirectory(directory);
      const entries = await readdir(directory);
      const pristinePluginWorkspace =
        state === undefined &&
        generation === undefined &&
        workspaceValid &&
        entries.length === 1 &&
        entries[0] === VOLUME_WORKSPACE_DIRECTORY &&
        (await readdir(join(directory, VOLUME_WORKSPACE_DIRECTORY))).length === 0;
      if (
        !pristinePluginWorkspace &&
        (state !== undefined || generation !== undefined || workspaceValid)
      ) {
        if (
          state === undefined ||
          generation === undefined ||
          !workspaceValid ||
          state.tenantId !== identity.tenantId ||
          state.workspaceId !== identity.workspaceId ||
          state.volumeId !== identity.volumeId ||
          state.volumeGeneration !== generation
        ) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_volume_binding_invalid",
            "Persistent Workspace Volume identity was invalid",
            false,
          );
        }
        return { attached: true };
      }
      if (!pristinePluginWorkspace && entries.length !== 0) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_contents_invalid",
          "Uninitialized Workspace Volume was not empty",
          false,
        );
      }
      const workspaceDirectory = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      if (!workspaceValid) await mkdir(workspaceDirectory, { mode: 0o700 });
      const metadataDirectory = join(directory, VOLUME_METADATA_DIRECTORY);
      await mkdir(metadataDirectory, { mode: 0o700 });
      const volumeGeneration = randomBytes(32).toString("hex");
      await writeFile(join(metadataDirectory, VOLUME_GENERATION_FILE), `${volumeGeneration}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      await this.#writeState(directory, {
        schemaVersion: 1,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        volumeId: identity.volumeId,
        volumeGeneration,
        gitBaselineCommit: "0".repeat(40),
      });
      return { attached: false };
    });
  }

  async initializeBaseline(
    input: WorkspaceVolumeGatewayInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }> {
    const identity = validatedIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const existing = await this.#readGitBaseline(directory);
      if (existing !== undefined) return { gitBaselineCommit: existing };
      const gitDirectory = join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GIT_DIRECTORY);
      await rm(gitDirectory, { recursive: true, force: true });
      const gitBaselineCommit = validatedGitBaselineCommit(
        await initializeExternalGitWorkspaceBaseline(this.#externalGitWorkspace(directory)),
      );
      const state = (await this.#readState(directory))!;
      await this.#writeState(directory, { ...state, gitBaselineCommit });
      return { gitBaselineCommit };
    });
  }

  async snapshot(input: WorkspaceVolumeGatewaySnapshotInput): Promise<{
    volumeRevision: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
    files: Awaited<ReturnType<typeof captureWorkspaceIndex>>["files"];
  }> {
    const identity = validatedIdentity(input);
    if (
      !UUID_PATTERN.test(input.activationId) ||
      !Number.isSafeInteger(input.fencingToken) ||
      input.fencingToken < 1 ||
      !SHA256_PATTERN.test(input.bindingSha256)
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_capture_fence_invalid",
        "Workspace capture fence was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const state = (await this.#readState(directory))!;
      if (!GIT_COMMIT_PATTERN.test(state.gitBaselineCommit)) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_git_baseline_invalid",
          "Workspace Git baseline was missing",
          false,
        );
      }
      const [index, workspacePatch] = await Promise.all([
        captureWorkspaceIndex(join(directory, VOLUME_WORKSPACE_DIRECTORY)),
        collectExternalGitWorkspacePatch(this.#externalGitWorkspace(directory)),
      ]);
      const volumeRevision = this.#volumeRevision(state.volumeGeneration, index.files);
      return {
        volumeRevision,
        gitBaselineCommit: state.gitBaselineCommit,
        workspacePatch,
        files: index.files,
      };
    });
  }

  async fork(input: WorkspaceVolumeGatewayForkInput): Promise<{
    sourceRevision: string;
    volumeRevision: string;
    gitBaselineCommit: string;
    files: Awaited<ReturnType<typeof captureWorkspaceIndex>>["files"];
  }> {
    if (!SHA256_PATTERN.test(input.expectedSourceRevision)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_fork_revision_invalid",
        "Workspace fork source revision was invalid",
        false,
      );
    }
    const source = validatedIdentity({
      tenantId: input.tenantId,
      workspaceId: input.sourceWorkspaceId,
      sessionId: input.sourceSessionId,
      volumeId: input.sourceVolumeId,
    });
    const target = validatedIdentity({
      tenantId: input.tenantId,
      workspaceId: input.targetWorkspaceId,
      sessionId: input.targetSessionId,
      volumeId: input.targetVolumeId,
    });
    if (source.workspaceId === target.workspaceId || source.volumeId === target.volumeId) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_fork_identity_invalid",
        "Workspace fork target must be independent",
        false,
      );
    }
    return this.#withVolumeLocks([source.volumeId, target.volumeId], async () => {
      await this.checkHealth();
      const sourceDirectory = await this.#validatedVolume(source);
      const sourceState = (await this.#readState(sourceDirectory))!;
      const targetDirectory = await this.#ensureVolumeDirectory(target.volumeId);
      const existingState = await this.#readState(targetDirectory);
      const existingGeneration = await this.#readVolumeGeneration(targetDirectory);
      if (existingState !== undefined || existingGeneration !== undefined) {
        if (
          existingState === undefined ||
          existingGeneration === undefined ||
          existingState.tenantId !== target.tenantId ||
          existingState.workspaceId !== target.workspaceId ||
          existingState.volumeId !== target.volumeId ||
          existingState.volumeGeneration !== existingGeneration ||
          existingState.forkedFrom?.workspaceId !== source.workspaceId
        ) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_target_conflict",
            "Workspace fork target was already bound to another source",
            false,
          );
        }
        const existingIndex = await captureWorkspaceIndex(
          join(targetDirectory, VOLUME_WORKSPACE_DIRECTORY),
        );
        return {
          sourceRevision: existingState.forkedFrom.volumeRevision,
          volumeRevision: this.#volumeRevision(existingGeneration, existingIndex.files),
          gitBaselineCommit: existingState.gitBaselineCommit,
          files: existingIndex.files,
        };
      }
      const sourceIndex = await captureWorkspaceIndex(
        join(sourceDirectory, VOLUME_WORKSPACE_DIRECTORY),
      );
      const sourceRevision = this.#volumeRevision(sourceState.volumeGeneration, sourceIndex.files);
      if (sourceRevision !== input.expectedSourceRevision) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_fork_source_changed",
          "Workspace changed before the isolated fork was captured",
          true,
        );
      }
      const targetEntries = await readdir(targetDirectory);
      const pristine =
        targetEntries.length === 0 ||
        (targetEntries.length === 1 &&
          targetEntries[0] === VOLUME_WORKSPACE_DIRECTORY &&
          (await readdir(join(targetDirectory, VOLUME_WORKSPACE_DIRECTORY))).length === 0);
      if (!pristine) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_fork_target_conflict",
          "Workspace fork target was not pristine",
          false,
        );
      }

      const temporary = `${targetDirectory}.fork-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        await cp(sourceDirectory, temporary, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
        const volumeGeneration = randomBytes(32).toString("hex");
        const generationPath = join(temporary, VOLUME_METADATA_DIRECTORY, VOLUME_GENERATION_FILE);
        await rm(generationPath, { force: true });
        await writeFile(generationPath, `${volumeGeneration}\n`, { mode: 0o400, flag: "wx" });
        await this.#writeState(temporary, {
          schemaVersion: 1,
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          volumeId: target.volumeId,
          volumeGeneration,
          gitBaselineCommit: sourceState.gitBaselineCommit,
          forkedFrom: { workspaceId: source.workspaceId, volumeRevision: sourceRevision },
        });
        const copiedIndex = await captureWorkspaceIndex(
          join(temporary, VOLUME_WORKSPACE_DIRECTORY),
        );
        if (JSON.stringify(copiedIndex.files) !== JSON.stringify(sourceIndex.files)) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_fork_copy_invalid",
            "Isolated Workspace copy did not match its source revision",
            false,
          );
        }
        await rm(targetDirectory, { recursive: true, force: true });
        await rename(temporary, targetDirectory);
        return {
          sourceRevision,
          volumeRevision: this.#volumeRevision(volumeGeneration, copiedIndex.files),
          gitBaselineCommit: sourceState.gitBaselineCommit,
          files: copiedIndex.files,
        };
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async materialize(
    input: WorkspaceVolumeGatewayMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const identity = validatedIdentity(input);
    const path = safeRelativeFile(input.path);
    if (
      !SHA256_PATTERN.test(input.expectedSha256) ||
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 8 * 1_024 * 1_024
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_materialize_request_invalid",
        "Workspace materialize request was invalid",
        false,
      );
    }
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = await this.#validatedVolume(identity);
      const root = resolve(directory, VOLUME_WORKSPACE_DIRECTORY);
      const target = resolve(root, path);
      if (!target.startsWith(`${root}${sep}`)) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_materialize_path_invalid",
          "Workspace materialize path escaped its volume",
          false,
        );
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > input.maximumBytes) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_materialize_file_invalid",
            "Workspace materialized file was invalid",
            false,
          );
        }
        const bytes = await handle.readFile();
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== input.expectedSha256) {
          throw new WorkspaceVolumeGatewayError(
            "workspace_revision_changed",
            "Workspace changed after the selected revision; refresh and retry",
            true,
          );
        }
        return { bytes, sha256 };
      } finally {
        await handle.close();
      }
    });
  }

  async delete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ deleted: boolean }> {
    const identity = validatedVolumeIdentity(input);
    return this.#withVolumeLock(identity.volumeId, async () => {
      const directory = this.#volumeDirectory(identity.volumeId);
      let metadata;
      try {
        metadata = await lstat(directory);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { deleted: false };
        }
        throw error;
      }
      const state = await this.#readState(directory);
      const generation = await this.#readVolumeGeneration(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        state === undefined ||
        generation === undefined ||
        state.tenantId !== identity.tenantId ||
        state.workspaceId !== identity.workspaceId ||
        state.volumeId !== identity.volumeId ||
        state.volumeGeneration !== generation ||
        !(await this.#hasValidWorkspaceDirectory(directory))
      ) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_binding_invalid",
          "Persistent Workspace Volume identity was invalid",
          false,
        );
      }
      await rm(directory, { recursive: true, force: false });
      return { deleted: true };
    });
  }

  async close(): Promise<void> {}

  async #validatedVolume(identity: ReturnType<typeof validatedIdentity>): Promise<string> {
    const directory = await this.#ensureVolumeDirectory(identity.volumeId);
    const state = await this.#readState(directory);
    const generation = await this.#readVolumeGeneration(directory);
    if (
      state === undefined ||
      generation === undefined ||
      state.tenantId !== identity.tenantId ||
      state.workspaceId !== identity.workspaceId ||
      state.volumeId !== identity.volumeId ||
      state.volumeGeneration !== generation ||
      !(await this.#hasValidWorkspaceDirectory(directory))
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_binding_invalid",
        "Persistent Workspace Volume identity was invalid",
        false,
      );
    }
    return directory;
  }

  async #ensureVolumeDirectory(volumeId: string): Promise<string> {
    const directory = this.#volumeDirectory(volumeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_path_invalid",
        "Workspace Volume path was invalid",
        false,
      );
    }
    await chmod(directory, 0o700);
    return directory;
  }

  #volumeDirectory(volumeId: string): string {
    const directory = resolve(this.#workspaceRoot, `picloud-posix-${volumeId}`);
    if (!directory.startsWith(`${this.#workspaceRoot}${sep}`)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_path_invalid",
        "Workspace Volume path was invalid",
        false,
      );
    }
    return directory;
  }

  async #hasValidWorkspaceDirectory(directory: string): Promise<boolean> {
    try {
      const metadata = await lstat(join(directory, VOLUME_WORKSPACE_DIRECTORY));
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
      return validatedGitBaselineCommit(
        await inspectExternalGitWorkspaceBaseline(this.#externalGitWorkspace(directory)),
      );
    } catch {
      return undefined;
    }
  }

  async #readVolumeGeneration(directory: string): Promise<string | undefined> {
    try {
      const value = (
        await readFile(join(directory, VOLUME_METADATA_DIRECTORY, VOLUME_GENERATION_FILE), "utf8")
      ).trim();
      return VOLUME_GENERATION_PATTERN.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  #statePath(directory: string): string {
    return join(directory, VOLUME_METADATA_DIRECTORY, "volume-state.json");
  }

  async #writeState(directory: string, state: VolumeState): Promise<void> {
    const target = this.#statePath(directory);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #readState(directory: string): Promise<VolumeState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.#statePath(directory), "utf8")) as unknown;
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.tenantId !== "string" ||
        typeof value.workspaceId !== "string" ||
        typeof value.volumeId !== "string" ||
        typeof value.volumeGeneration !== "string" ||
        !VOLUME_GENERATION_PATTERN.test(value.volumeGeneration) ||
        typeof value.gitBaselineCommit !== "string" ||
        !/^(?:[0-9a-f]{40})$/.test(value.gitBaselineCommit)
      )
        return undefined;
      if (
        value.forkedFrom !== undefined &&
        (!isRecord(value.forkedFrom) ||
          typeof value.forkedFrom.workspaceId !== "string" ||
          typeof value.forkedFrom.volumeRevision !== "string" ||
          !SHA256_PATTERN.test(value.forkedFrom.volumeRevision))
      )
        return undefined;
      return value as unknown as VolumeState;
    } catch {
      return undefined;
    }
  }

  async #withVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const run = () => this.#withLocalVolumeLock(volumeId, operation);
    return this.#distributedLock === undefined
      ? run()
      : this.#distributedLock.withLock(volumeId, run);
  }

  async #withVolumeLocks<T>(volumeIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(volumeIds)].sort();
    const acquireLocal = (index: number): Promise<T> => {
      const volumeId = ordered[index];
      return volumeId === undefined
        ? operation()
        : this.#withLocalVolumeLock(volumeId, () => acquireLocal(index + 1));
    };
    if (this.#distributedLock?.withLocks !== undefined) {
      return this.#distributedLock.withLocks(ordered, () => acquireLocal(0));
    }
    const acquire = (index: number): Promise<T> => {
      const volumeId = ordered[index];
      return volumeId === undefined
        ? operation()
        : this.#withVolumeLock(volumeId, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async #withLocalVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(volumeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.#locks.set(volumeId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(volumeId) === tail) this.#locks.delete(volumeId);
    }
  }

  #volumeRevision(
    volumeGeneration: string,
    files: readonly import("@pi-cloud/workspace-runtime").WorkspaceSnapshotFileMetadata[],
  ): string {
    return createHash("sha256")
      .update("pi-cloud.workspace-volume-revision.v1\0")
      .update(volumeGeneration)
      .update("\0")
      .update(JSON.stringify(files))
      .digest("hex");
  }
}
