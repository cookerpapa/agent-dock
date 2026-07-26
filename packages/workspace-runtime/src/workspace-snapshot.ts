import { MAX_WORKSPACE_SNAPSHOT_BYTES, type SandboxCheckpointBlob } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  parseCubeWorkspaceCheckpoint,
  type WorkspaceSnapshotFileMetadata,
} from "./cube-workspace-checkpoint.ts";
import { parseKopiaWorkspaceCheckpoint } from "./kopia-workspace-checkpoint.ts";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const MAX_WORKSPACE_SNAPSHOT_FILES = 512;
export const MAX_WORKSPACE_SNAPSHOT_FILE_BYTES = 512 * 1_024;
export const MAX_WORKSPACE_SNAPSHOT_PATH_BYTES = 512;
export const MAX_PORTABLE_WORKSPACE_MANIFEST_BYTES = 2 * 1_024 * 1_024;

type WorkspaceSnapshotFile = {
  path: string;
  executable: boolean;
  sizeBytes: number;
  sha256: string;
  content: string;
};

type WorkspaceSnapshotManifest = {
  format: "agent-dock.workspace-manifest.v1";
  files: WorkspaceSnapshotFile[];
};

export type WorkspaceSnapshotFileContent = {
  path: string;
  executable: boolean;
  content: Buffer;
};

export type WorkspaceSnapshotMetadata = WorkspaceSnapshotFileMetadata & {
  content?: Buffer;
};

function snapshotError(message: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(message);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
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
    Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_SNAPSHOT_PATH_BYTES ||
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

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw snapshotError("Workspace file content is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw snapshotError("Workspace file content is not canonical base64");
  }
  return decoded;
}

async function collectFiles(
  root: string,
  relativeDirectory = "",
): Promise<WorkspaceSnapshotFile[]> {
  const directory = relativeDirectory.length === 0 ? root : resolve(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: WorkspaceSnapshotFile[] = [];
  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (relativeDirectory.length === 0 && entry.name === ".git") continue;
    if (!validRelativePath(relativePath)) {
      throw snapshotError("Workspace contains an unsupported path");
    }
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw snapshotError("Workspace contains a link or special file");
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relativePath)));
      if (files.length > MAX_WORKSPACE_SNAPSHOT_FILES) {
        throw snapshotError("Workspace contains too many files for this checkpoint format");
      }
      continue;
    }
    const absolutePath = resolve(root, relativePath);
    let metadata: Stats;
    let content: Buffer;
    try {
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_WORKSPACE_SNAPSHOT_FILE_BYTES) {
          throw snapshotError("Workspace file is outside its byte limit");
        }
        content = await handle.readFile();
        if (content.byteLength > MAX_WORKSPACE_SNAPSHOT_FILE_BYTES) {
          throw snapshotError("Workspace file is outside its byte limit");
        }
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw snapshotError("Workspace file could not be captured safely");
    }
    files.push({
      path: relativePath,
      executable: (metadata.mode & 0o111) !== 0,
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      content: content.toString("base64"),
    });
    if (files.length > MAX_WORKSPACE_SNAPSHOT_FILES) {
      throw snapshotError("Workspace contains too many files for this checkpoint format");
    }
  }
  return files;
}

export async function captureWorkspaceSnapshot(workspaceDirectory: string): Promise<Uint8Array> {
  const files = (await collectFiles(workspaceDirectory)).sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  const manifest: WorkspaceSnapshotManifest = {
    format: "agent-dock.workspace-manifest.v1",
    files,
  };
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (encoded.byteLength > MAX_PORTABLE_WORKSPACE_MANIFEST_BYTES) {
    throw snapshotError("Workspace manifest is outside its byte limit");
  }
  return encoded;
}

export function parseWorkspaceSnapshot(snapshot: Uint8Array): WorkspaceSnapshotFileContent[] {
  if (
    parseCubeWorkspaceCheckpoint(snapshot) !== undefined ||
    parseKopiaWorkspaceCheckpoint(snapshot) !== undefined
  ) {
    throw snapshotError("Provider Workspace checkpoint does not contain portable file bytes");
  }
  if (snapshot.byteLength < 1 || snapshot.byteLength > MAX_PORTABLE_WORKSPACE_MANIFEST_BYTES) {
    throw snapshotError("Workspace manifest is outside its byte limit");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw snapshotError("Workspace manifest is not valid UTF-8 JSON");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["format", "files"]) ||
    parsed.format !== "agent-dock.workspace-manifest.v1" ||
    !Array.isArray(parsed.files) ||
    parsed.files.length > MAX_WORKSPACE_SNAPSHOT_FILES
  ) {
    throw snapshotError("Workspace manifest shape is invalid");
  }

  const restored: WorkspaceSnapshotFileContent[] = [];
  const paths = new Set<string>();
  for (const candidate of parsed.files) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["path", "executable", "sizeBytes", "sha256", "content"]) ||
      typeof candidate.path !== "string" ||
      !validRelativePath(candidate.path) ||
      typeof candidate.executable !== "boolean" ||
      !Number.isSafeInteger(candidate.sizeBytes) ||
      (candidate.sizeBytes as number) < 0 ||
      (candidate.sizeBytes as number) > MAX_WORKSPACE_SNAPSHOT_FILE_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
      typeof candidate.content !== "string" ||
      paths.has(candidate.path)
    ) {
      throw snapshotError("Workspace file entry is invalid");
    }
    const content = decodeCanonicalBase64(candidate.content);
    if (content.byteLength !== candidate.sizeBytes || sha256(content) !== candidate.sha256) {
      throw snapshotError("Workspace file content does not match its metadata");
    }
    paths.add(candidate.path);
    restored.push({ path: candidate.path, executable: candidate.executable, content });
  }
  restored.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < restored.length - 1; index += 1) {
    const current = restored[index];
    const next = restored[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw snapshotError("Workspace manifest contains a file/directory collision");
    }
  }
  return restored;
}

export function createWorkspaceSnapshot(
  files: readonly {
    path: string;
    executable: boolean;
    content: Uint8Array;
  }[],
): Uint8Array {
  if (files.length > MAX_WORKSPACE_SNAPSHOT_FILES) {
    throw snapshotError("Workspace contains too many files for this checkpoint format");
  }
  const paths = new Set<string>();
  const entries: WorkspaceSnapshotFile[] = files.map((file) => {
    if (
      !validRelativePath(file.path) ||
      typeof file.executable !== "boolean" ||
      file.content.byteLength > MAX_WORKSPACE_SNAPSHOT_FILE_BYTES ||
      paths.has(file.path)
    ) {
      throw snapshotError("Workspace file entry is invalid");
    }
    paths.add(file.path);
    const content = Buffer.from(file.content);
    return {
      path: file.path,
      executable: file.executable,
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      content: content.toString("base64"),
    };
  });
  entries.sort((left, right) => comparePaths(left.path, right.path));
  for (let index = 0; index < entries.length - 1; index += 1) {
    const current = entries[index];
    const next = entries[index + 1];
    if (current && next?.path.startsWith(`${current.path}/`)) {
      throw snapshotError("Workspace manifest contains a file/directory collision");
    }
  }
  const encoded = Buffer.from(
    `${JSON.stringify({ format: "agent-dock.workspace-manifest.v1", files: entries })}\n`,
    "utf8",
  );
  if (encoded.byteLength > MAX_PORTABLE_WORKSPACE_MANIFEST_BYTES) {
    throw snapshotError("Workspace manifest is outside its byte limit");
  }
  validateWorkspaceSnapshot(encoded);
  return encoded;
}

export function mergeWorkspaceSnapshots(
  sources: readonly { root: string; snapshot: Uint8Array }[],
): Uint8Array {
  if (sources.length < 1 || sources.length > 8) {
    throw snapshotError("Workspace source set is outside its repository limit");
  }
  const roots = new Set<string>();
  const files: WorkspaceSnapshotFileContent[] = [];
  for (const source of sources) {
    if (
      (source.root !== "." && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(source.root)) ||
      (sources.length > 1 && source.root === ".") ||
      roots.has(source.root)
    ) {
      throw snapshotError("Workspace source root is invalid or repeated");
    }
    roots.add(source.root);
    for (const file of parseWorkspaceSnapshot(source.snapshot)) {
      files.push({
        path: source.root === "." ? file.path : `${source.root}/${file.path}`,
        executable: file.executable,
        content: file.content,
      });
    }
  }
  return createWorkspaceSnapshot(files);
}

export async function restoreWorkspaceSnapshot(
  workspaceDirectory: string,
  snapshot: Uint8Array,
): Promise<void> {
  const restored = parseWorkspaceSnapshot(snapshot);
  for (const entry of await readdir(workspaceDirectory)) {
    if (entry === ".git") continue;
    await rm(resolve(workspaceDirectory, entry), { recursive: true, force: true });
  }
  for (const file of restored) {
    const target = resolve(workspaceDirectory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
    await chmod(target, file.executable ? 0o755 : 0o644);
  }
}

export function validateWorkspaceSnapshot(snapshot: Uint8Array): void {
  if (parseCubeWorkspaceCheckpoint(snapshot) !== undefined) return;
  if (parseKopiaWorkspaceCheckpoint(snapshot) !== undefined) return;
  parseWorkspaceSnapshot(snapshot);
}

export function workspaceSnapshotMetadata(snapshot: Uint8Array): WorkspaceSnapshotMetadata[] {
  const cube = parseCubeWorkspaceCheckpoint(snapshot);
  if (cube !== undefined) return cube.files.map((file) => ({ ...file }));
  const kopia = parseKopiaWorkspaceCheckpoint(snapshot);
  if (kopia !== undefined) return kopia.files.map((file) => ({ ...file }));
  return parseWorkspaceSnapshot(snapshot).map((file) => ({
    path: file.path,
    executable: file.executable,
    sizeBytes: file.content.byteLength,
    sha256: sha256(file.content),
    content: file.content,
  }));
}

export function workspaceSnapshotFileCount(snapshot: Uint8Array): number {
  return workspaceSnapshotMetadata(snapshot).length;
}

export function encodeWorkspaceSnapshotBlob(snapshot: Uint8Array): SandboxCheckpointBlob {
  validateWorkspaceSnapshot(snapshot);
  return {
    encoding: "base64",
    sha256: sha256(snapshot),
    sizeBytes: snapshot.byteLength,
    data: Buffer.from(snapshot).toString("base64"),
  };
}

export function decodeWorkspaceSnapshotBlob(blob: SandboxCheckpointBlob): Uint8Array {
  const bytes = decodeCanonicalBase64(blob.data);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES ||
    bytes.byteLength !== blob.sizeBytes ||
    sha256(bytes) !== blob.sha256
  ) {
    throw snapshotError("Workspace snapshot blob does not match its envelope");
  }
  validateWorkspaceSnapshot(bytes);
  return bytes;
}
