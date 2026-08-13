import {
  captureWorkspaceIndex,
  collectExternalGitWorkspacePatch,
  initializeExternalGitWorkspaceBaseline,
  inspectExternalGitWorkspaceBaseline,
} from "@agent-dock/workspace-runtime";
import type { WorkspacePatch } from "@agent-dock/protocol";
import { createHash, randomBytes } from "node:crypto";
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
  type PersistentVolumeWorkspaceVolumeGatewayOptions,
  type VolumeState,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayLock,
  type WorkspaceVolumeGatewayInitializeBaselineInput,
  type WorkspaceVolumeGatewayMaterializeInput,
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
      if (state !== undefined || generation !== undefined || workspaceValid) {
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
      if ((await readdir(directory)).length !== 0) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_contents_invalid",
          "Uninitialized Workspace Volume was not empty",
          false,
        );
      }
      const workspaceDirectory = join(directory, VOLUME_WORKSPACE_DIRECTORY);
      await mkdir(workspaceDirectory, { mode: 0o700 });
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
      const volumeRevision = createHash("sha256")
        .update("agent-dock.workspace-volume-revision.v1\0")
        .update(state.volumeGeneration)
        .update("\0")
        .update(JSON.stringify(index.files))
        .digest("hex");
      return {
        volumeRevision,
        gitBaselineCommit: state.gitBaselineCommit,
        workspacePatch,
        files: index.files,
      };
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
    const directory = resolve(this.#workspaceRoot, `agentdock-posix-${volumeId}`);
    if (!directory.startsWith(`${this.#workspaceRoot}${sep}`)) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_path_invalid",
        "Workspace Volume path was invalid",
        false,
      );
    }
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
      return value as unknown as VolumeState;
    } catch {
      return undefined;
    }
  }

  async #withVolumeLock<T>(volumeId: string, operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
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
    };
    return this.#distributedLock === undefined
      ? run()
      : this.#distributedLock.withLock(volumeId, run);
  }
}
