import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const MAX_WORKSPACE_INDEX_FILES = 100_000;
export const MAX_WORKSPACE_INDEX_FILE_BYTES = 1 * 1_024 * 1_024 * 1_024;
export const MAX_WORKSPACE_INDEX_TOTAL_BYTES = 1 * 1_024 * 1_024 * 1_024;

const MAX_PATH_BYTES = 512;
const MAX_SYMLINK_TARGET_BYTES = 4 * 1_024;
const SYMLINK_DIGEST_DOMAIN = Buffer.from("pi-cloud.workspace-symlink.v1\0", "utf8");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type WorkspaceSnapshotFileMetadata = Readonly<{
  path: string;
  executable: boolean;
  sizeBytes: number;
  sha256: string;
}>;

export type WorkspaceIndex = Readonly<{
  files: readonly WorkspaceSnapshotFileMetadata[];
  portable: boolean;
}>;

function snapshotError(message: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    segments[0] !== ".git"
  );
}

function validFileMetadata(
  value: unknown,
  paths: Set<string>,
): value is WorkspaceSnapshotFileMetadata {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["path", "executable", "sizeBytes", "sha256"]) ||
    typeof value.path !== "string" ||
    !validRelativePath(value.path) ||
    typeof value.executable !== "boolean" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sizeBytes as number) > MAX_WORKSPACE_INDEX_FILE_BYTES ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    paths.has(value.path)
  ) {
    return false;
  }
  paths.add(value.path);
  return true;
}

export function validateWorkspaceFileList(
  value: unknown,
): readonly WorkspaceSnapshotFileMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_INDEX_FILES) {
    throw snapshotError("Workspace checkpoint file index is invalid");
  }
  const paths = new Set<string>();
  const files: WorkspaceSnapshotFileMetadata[] = [];
  let totalSizeBytes = 0;
  for (const candidate of value) {
    if (!validFileMetadata(candidate, paths)) {
      throw snapshotError("Workspace checkpoint file entry is invalid");
    }
    const file = candidate as WorkspaceSnapshotFileMetadata;
    totalSizeBytes += file.sizeBytes;
    if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes > MAX_WORKSPACE_INDEX_TOTAL_BYTES) {
      throw snapshotError("Workspace checkpoint exceeds its Workspace byte limit");
    }
    files.push(Object.freeze({ ...file }));
  }
  files.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < files.length - 1; index += 1) {
    const current = files[index];
    const next = files[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw snapshotError("Workspace checkpoint contains a file/directory collision");
    }
  }
  return Object.freeze(files);
}

async function hashOpenFile(absolutePath: string): Promise<{ metadata: Stats; sha256: string }> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_WORKSPACE_INDEX_FILE_BYTES) {
      throw snapshotError("Workspace file is outside its byte limit");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 * 1_024 * 1_024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead < 1) {
        throw snapshotError("Workspace file changed while its checkpoint index was captured");
      }
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    ) {
      throw snapshotError("Workspace file changed while its checkpoint index was captured");
    }
    return { metadata: after, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function hashSymbolicLink(
  absolutePath: string,
): Promise<{ metadata: Stats; sizeBytes: number; sha256: string }> {
  try {
    const before = await lstat(absolutePath);
    if (!before.isSymbolicLink() || before.size > MAX_SYMLINK_TARGET_BYTES) {
      throw snapshotError("Workspace symbolic link is outside its byte limit");
    }
    const target = await readlink(absolutePath, { encoding: "buffer" });
    const after = await lstat(absolutePath);
    if (
      !after.isSymbolicLink() ||
      target.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    ) {
      throw snapshotError("Workspace symbolic link changed during checkpoint capture");
    }
    return {
      metadata: after,
      sizeBytes: target.byteLength,
      // Domain separation makes a regular file containing the same target text
      // observably different from a symbolic link without exposing or following
      // the link outside the Workspace.
      sha256: createHash("sha256").update(SYMLINK_DIGEST_DOMAIN).update(target).digest("hex"),
    };
  } catch (error: unknown) {
    if (error instanceof WorkspaceRuntimeError) throw error;
    throw snapshotError("Workspace symbolic link could not be captured safely");
  }
}

async function collectMetadata(
  root: string,
  relativeDirectory: string,
  output: WorkspaceSnapshotFileMetadata[],
  state: { totalSizeBytes: number; portable: boolean },
): Promise<void> {
  const directory = relativeDirectory.length === 0 ? root : resolve(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (relativeDirectory.length === 0 && entry.name === ".git") {
      continue;
    }
    if (!validRelativePath(relativePath)) {
      throw snapshotError("Workspace contains an unsupported path");
    }
    if (entry.isDirectory()) {
      await collectMetadata(root, relativePath, output, state);
      continue;
    }
    if (output.length >= MAX_WORKSPACE_INDEX_FILES) {
      throw snapshotError("Workspace contains too many files for its checkpoint index");
    }
    if (entry.isSymbolicLink()) {
      const link = await hashSymbolicLink(resolve(root, relativePath));
      state.totalSizeBytes += link.sizeBytes;
      state.portable = false;
      if (
        !Number.isSafeInteger(state.totalSizeBytes) ||
        state.totalSizeBytes > MAX_WORKSPACE_INDEX_TOTAL_BYTES
      ) {
        throw snapshotError("Workspace exceeds the checkpoint byte limit");
      }
      output.push(
        Object.freeze({
          path: relativePath,
          executable: false,
          sizeBytes: link.sizeBytes,
          sha256: link.sha256,
        }),
      );
      continue;
    }
    if (!entry.isFile()) {
      throw snapshotError("Workspace contains a special file");
    }
    const { metadata, sha256 } = await hashOpenFile(resolve(root, relativePath));
    state.totalSizeBytes += metadata.size;
    if (
      !Number.isSafeInteger(state.totalSizeBytes) ||
      state.totalSizeBytes > MAX_WORKSPACE_INDEX_TOTAL_BYTES
    ) {
      throw snapshotError("Workspace exceeds the checkpoint byte limit");
    }
    output.push(
      Object.freeze({
        path: relativePath,
        executable: (metadata.mode & 0o111) !== 0,
        sizeBytes: metadata.size,
        sha256,
      }),
    );
  }
}

export async function captureWorkspaceIndex(workspaceDirectory: string): Promise<WorkspaceIndex> {
  const files: WorkspaceSnapshotFileMetadata[] = [];
  const state = { totalSizeBytes: 0, portable: true };
  await collectMetadata(workspaceDirectory, "", files, state);
  return Object.freeze({
    files: Object.freeze(files),
    portable: state.portable,
  });
}
