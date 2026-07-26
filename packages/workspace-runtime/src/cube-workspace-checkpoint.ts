import { MAX_WORKSPACE_SNAPSHOT_BYTES } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const CUBE_WORKSPACE_CHECKPOINT_FORMAT = "agent-dock.workspace-cube-snapshot.v1";
export const MAX_CUBE_WORKSPACE_CHECKPOINT_FILES = 100_000;
export const MAX_CUBE_WORKSPACE_FILE_BYTES = 1 * 1_024 * 1_024 * 1_024;
export const MAX_CUBE_WORKSPACE_TOTAL_BYTES = 1 * 1_024 * 1_024 * 1_024;

const MAX_PATH_BYTES = 512;
const MAX_SYMLINK_TARGET_BYTES = 4 * 1_024;
const SYMLINK_DIGEST_DOMAIN = Buffer.from("agent-dock.workspace-symlink.v1\0", "utf8");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CUBE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type WorkspaceSnapshotFileMetadata = Readonly<{
  path: string;
  executable: boolean;
  sizeBytes: number;
  sha256: string;
}>;

export type CubeWorkspaceIndex = Readonly<{
  files: readonly WorkspaceSnapshotFileMetadata[];
  portable: boolean;
}>;

export type CubeWorkspaceCheckpointAuthority = Readonly<{
  keyVersion: 1;
  nonce: string;
  ciphertext: string;
  authTag: string;
}>;

export type CubeWorkspaceCheckpoint = Readonly<{
  format: typeof CUBE_WORKSPACE_CHECKPOINT_FORMAT;
  providerId: "cubesandbox";
  snapshotId: string;
  sourceSandboxId: string;
  activationId: string;
  tenantId: string;
  workspaceId: string;
  bindingSha256: string;
  fencingToken: number;
  imageRevision: string;
  environmentSpecSha256: string;
  totalSizeBytes: number;
  files: readonly WorkspaceSnapshotFileMetadata[];
  authority: CubeWorkspaceCheckpointAuthority;
}>;

export type CreateCubeWorkspaceCheckpointInput = Omit<
  CubeWorkspaceCheckpoint,
  "format" | "providerId" | "files" | "totalSizeBytes"
> & {
  files: readonly WorkspaceSnapshotFileMetadata[];
};

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
    (value.sizeBytes as number) > MAX_CUBE_WORKSPACE_FILE_BYTES ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    paths.has(value.path)
  ) {
    return false;
  }
  paths.add(value.path);
  return true;
}

function validateFileList(value: unknown): readonly WorkspaceSnapshotFileMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_CUBE_WORKSPACE_CHECKPOINT_FILES) {
    throw snapshotError("Cube Workspace checkpoint file index is invalid");
  }
  const paths = new Set<string>();
  const files: WorkspaceSnapshotFileMetadata[] = [];
  let totalSizeBytes = 0;
  for (const candidate of value) {
    if (!validFileMetadata(candidate, paths)) {
      throw snapshotError("Cube Workspace checkpoint file entry is invalid");
    }
    const file = candidate as WorkspaceSnapshotFileMetadata;
    totalSizeBytes += file.sizeBytes;
    if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes > MAX_CUBE_WORKSPACE_TOTAL_BYTES) {
      throw snapshotError("Cube Workspace checkpoint exceeds its Workspace byte limit");
    }
    files.push(Object.freeze({ ...file }));
  }
  files.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < files.length - 1; index += 1) {
    const current = files[index];
    const next = files[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw snapshotError("Cube Workspace checkpoint contains a file/directory collision");
    }
  }
  return Object.freeze(files);
}

function parseAuthority(value: unknown): CubeWorkspaceCheckpointAuthority {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["keyVersion", "nonce", "ciphertext", "authTag"]) ||
    value.keyVersion !== 1 ||
    typeof value.nonce !== "string" ||
    value.nonce.length !== 16 ||
    !BASE64URL_PATTERN.test(value.nonce) ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length < 64 ||
    value.ciphertext.length > 256 ||
    !BASE64URL_PATTERN.test(value.ciphertext) ||
    typeof value.authTag !== "string" ||
    value.authTag.length !== 22 ||
    !BASE64URL_PATTERN.test(value.authTag)
  ) {
    throw snapshotError("Cube Workspace checkpoint recovery authority is invalid");
  }
  return Object.freeze({
    keyVersion: 1,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
  });
}

function parseCheckpointRecord(value: Record<string, unknown>): CubeWorkspaceCheckpoint {
  if (
    !exactKeys(value, [
      "format",
      "providerId",
      "snapshotId",
      "sourceSandboxId",
      "activationId",
      "tenantId",
      "workspaceId",
      "bindingSha256",
      "fencingToken",
      "imageRevision",
      "environmentSpecSha256",
      "totalSizeBytes",
      "files",
      "authority",
    ]) ||
    value.format !== CUBE_WORKSPACE_CHECKPOINT_FORMAT ||
    value.providerId !== "cubesandbox" ||
    typeof value.snapshotId !== "string" ||
    !CUBE_ID_PATTERN.test(value.snapshotId) ||
    typeof value.sourceSandboxId !== "string" ||
    !CUBE_ID_PATTERN.test(value.sourceSandboxId) ||
    typeof value.activationId !== "string" ||
    !UUID_PATTERN.test(value.activationId) ||
    typeof value.tenantId !== "string" ||
    !OPAQUE_ID_PATTERN.test(value.tenantId) ||
    typeof value.workspaceId !== "string" ||
    !OPAQUE_ID_PATTERN.test(value.workspaceId) ||
    typeof value.bindingSha256 !== "string" ||
    !SHA256_PATTERN.test(value.bindingSha256) ||
    !Number.isSafeInteger(value.fencingToken) ||
    (value.fencingToken as number) < 1 ||
    typeof value.imageRevision !== "string" ||
    value.imageRevision.length < 1 ||
    value.imageRevision.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value.imageRevision) ||
    typeof value.environmentSpecSha256 !== "string" ||
    !SHA256_PATTERN.test(value.environmentSpecSha256) ||
    !Number.isSafeInteger(value.totalSizeBytes) ||
    (value.totalSizeBytes as number) < 0 ||
    (value.totalSizeBytes as number) > MAX_CUBE_WORKSPACE_TOTAL_BYTES
  ) {
    throw snapshotError("Cube Workspace checkpoint shape is invalid");
  }
  const files = validateFileList(value.files);
  const totalSizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalSizeBytes !== value.totalSizeBytes) {
    throw snapshotError("Cube Workspace checkpoint byte total is inconsistent");
  }
  return Object.freeze({
    format: CUBE_WORKSPACE_CHECKPOINT_FORMAT,
    providerId: "cubesandbox",
    snapshotId: value.snapshotId,
    sourceSandboxId: value.sourceSandboxId,
    activationId: value.activationId,
    tenantId: value.tenantId,
    workspaceId: value.workspaceId,
    bindingSha256: value.bindingSha256,
    fencingToken: value.fencingToken as number,
    imageRevision: value.imageRevision,
    environmentSpecSha256: value.environmentSpecSha256,
    totalSizeBytes,
    files,
    authority: parseAuthority(value.authority),
  });
}

export function parseCubeWorkspaceCheckpoint(
  snapshot: Uint8Array,
): CubeWorkspaceCheckpoint | undefined {
  if (snapshot.byteLength < 1 || snapshot.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw snapshotError("Workspace checkpoint is outside its byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot)) as unknown;
  } catch {
    throw snapshotError("Workspace checkpoint is not valid UTF-8 JSON");
  }
  if (!isRecord(parsed) || parsed.format !== CUBE_WORKSPACE_CHECKPOINT_FORMAT) return undefined;
  return parseCheckpointRecord(parsed);
}

export function createCubeWorkspaceCheckpoint(
  input: CreateCubeWorkspaceCheckpointInput,
): Uint8Array {
  const files = validateFileList(input.files);
  const value = {
    format: CUBE_WORKSPACE_CHECKPOINT_FORMAT,
    providerId: "cubesandbox",
    snapshotId: input.snapshotId,
    sourceSandboxId: input.sourceSandboxId,
    activationId: input.activationId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    bindingSha256: input.bindingSha256,
    fencingToken: input.fencingToken,
    imageRevision: input.imageRevision,
    environmentSpecSha256: input.environmentSpecSha256,
    totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
    authority: input.authority,
  };
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw snapshotError("Cube Workspace checkpoint index is outside its byte limit");
  }
  parseCubeWorkspaceCheckpoint(encoded);
  return encoded;
}

export function cubeWorkspaceCheckpointAad(
  checkpoint: Pick<
    CubeWorkspaceCheckpoint,
    | "snapshotId"
    | "sourceSandboxId"
    | "activationId"
    | "tenantId"
    | "workspaceId"
    | "bindingSha256"
    | "fencingToken"
    | "imageRevision"
    | "environmentSpecSha256"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: CUBE_WORKSPACE_CHECKPOINT_FORMAT,
      snapshotId: checkpoint.snapshotId,
      sourceSandboxId: checkpoint.sourceSandboxId,
      activationId: checkpoint.activationId,
      tenantId: checkpoint.tenantId,
      workspaceId: checkpoint.workspaceId,
      bindingSha256: checkpoint.bindingSha256,
      fencingToken: checkpoint.fencingToken,
      imageRevision: checkpoint.imageRevision,
      environmentSpecSha256: checkpoint.environmentSpecSha256,
    }),
    "utf8",
  );
}

async function hashOpenFile(absolutePath: string): Promise<{ metadata: Stats; sha256: string }> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_CUBE_WORKSPACE_FILE_BYTES) {
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
    if (relativeDirectory.length === 0 && entry.name === ".git") continue;
    if (!validRelativePath(relativePath)) {
      throw snapshotError("Workspace contains an unsupported path");
    }
    if (entry.isDirectory()) {
      await collectMetadata(root, relativePath, output, state);
      continue;
    }
    if (output.length >= MAX_CUBE_WORKSPACE_CHECKPOINT_FILES) {
      throw snapshotError("Workspace contains too many files for a Cube checkpoint");
    }
    if (entry.isSymbolicLink()) {
      const link = await hashSymbolicLink(resolve(root, relativePath));
      state.totalSizeBytes += link.sizeBytes;
      state.portable = false;
      if (
        !Number.isSafeInteger(state.totalSizeBytes) ||
        state.totalSizeBytes > MAX_CUBE_WORKSPACE_TOTAL_BYTES
      ) {
        throw snapshotError("Workspace exceeds the Cube checkpoint byte limit");
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
      state.totalSizeBytes > MAX_CUBE_WORKSPACE_TOTAL_BYTES
    ) {
      throw snapshotError("Workspace exceeds the Cube checkpoint byte limit");
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

export async function captureCubeWorkspaceIndex(
  workspaceDirectory: string,
): Promise<CubeWorkspaceIndex> {
  const files: WorkspaceSnapshotFileMetadata[] = [];
  const state = { totalSizeBytes: 0, portable: true };
  await collectMetadata(workspaceDirectory, "", files, state);
  return Object.freeze({
    files: Object.freeze(files),
    portable: state.portable,
  });
}
