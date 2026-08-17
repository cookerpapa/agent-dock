import {
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type EnvironmentRecipeCommandResult,
} from "@pi-cloud/protocol";
import { TextDecoder } from "node:util";
import {
  MAX_WORKSPACE_INDEX_TOTAL_BYTES,
  validateWorkspaceFileList,
  type WorkspaceSnapshotFileMetadata,
} from "./workspace-index.ts";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const PERSISTENT_VOLUME_REFERENCE_FORMAT = "pi-cloud.workspace-volume-reference.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VOLUME_ID_PATTERN = /^pcw-[0-9a-f]{48}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export type PersistentVolumeReference = Readonly<{
  format: typeof PERSISTENT_VOLUME_REFERENCE_FORMAT;
  providerId: "cubesandbox";
  volumeId: string;
  volumeRevision: string;
  activationId: string;
  tenantId: string;
  workspaceId: string;
  sourceSessionId: string;
  bindingSha256: string;
  fencingToken: number;
  imageRevision: string;
  environmentSpecSha256: string;
  gitBaselineCommit: string;
  totalSizeBytes: number;
  files: readonly WorkspaceSnapshotFileMetadata[];
  recipeCommands: readonly EnvironmentRecipeCommandResult[];
}>;

export type CreatePersistentVolumeReferenceInput = Omit<
  PersistentVolumeReference,
  "format" | "providerId" | "files" | "totalSizeBytes" | "recipeCommands"
> & {
  files: readonly WorkspaceSnapshotFileMetadata[];
  recipeCommands: readonly EnvironmentRecipeCommandResult[];
};

function fail(): never {
  throw new WorkspaceRuntimeError("Persistent Workspace Volume reference is invalid");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function recipeCommands(value: unknown): readonly EnvironmentRecipeCommandResult[] {
  if (!Array.isArray(value) || value.length > 20) fail();
  return Object.freeze(
    value.map((candidate) => {
      const command = record(candidate);
      if (
        typeof command.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(command.id) ||
        (command.phase !== "setup" && command.phase !== "verification") ||
        !Number.isSafeInteger(command.exitCode) ||
        !Number.isSafeInteger(command.durationMs) ||
        typeof command.outputSha256 !== "string" ||
        !SHA256_PATTERN.test(command.outputSha256) ||
        (command.outputSummary !== undefined && typeof command.outputSummary !== "string")
      )
        fail();
      return Object.freeze({
        id: command.id,
        phase: command.phase,
        exitCode: command.exitCode as number,
        durationMs: command.durationMs as number,
        outputSha256: command.outputSha256,
        ...(command.outputSummary === undefined
          ? {}
          : { outputSummary: command.outputSummary as string }),
      });
    }),
  );
}

export function createPersistentVolumeReference(
  input: CreatePersistentVolumeReferenceInput,
): Uint8Array {
  const files = validateWorkspaceFileList(input.files);
  const value: PersistentVolumeReference = Object.freeze({
    ...input,
    format: PERSISTENT_VOLUME_REFERENCE_FORMAT,
    providerId: "cubesandbox",
    files,
    totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    recipeCommands: recipeCommands(input.recipeCommands),
  });
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) fail();
  parsePersistentVolumeReference(encoded);
  return encoded;
}

export function parsePersistentVolumeReference(
  bytes: Uint8Array,
): PersistentVolumeReference | undefined {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) return undefined;
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return undefined;
  }
  try {
    const expectedKeys = [
      "activationId",
      "bindingSha256",
      "environmentSpecSha256",
      "fencingToken",
      "files",
      "format",
      "gitBaselineCommit",
      "imageRevision",
      "providerId",
      "recipeCommands",
      "sourceSessionId",
      "tenantId",
      "totalSizeBytes",
      "volumeId",
      "volumeRevision",
      "workspaceId",
    ];
    if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")) return undefined;
    if (
      value.format !== PERSISTENT_VOLUME_REFERENCE_FORMAT ||
      value.providerId !== "cubesandbox" ||
      typeof value.volumeId !== "string" ||
      !VOLUME_ID_PATTERN.test(value.volumeId) ||
      typeof value.volumeRevision !== "string" ||
      !SHA256_PATTERN.test(value.volumeRevision) ||
      typeof value.activationId !== "string" ||
      !UUID_PATTERN.test(value.activationId) ||
      typeof value.tenantId !== "string" ||
      !OPAQUE_ID_PATTERN.test(value.tenantId) ||
      typeof value.workspaceId !== "string" ||
      !OPAQUE_ID_PATTERN.test(value.workspaceId) ||
      typeof value.sourceSessionId !== "string" ||
      !OPAQUE_ID_PATTERN.test(value.sourceSessionId) ||
      typeof value.bindingSha256 !== "string" ||
      !SHA256_PATTERN.test(value.bindingSha256) ||
      !Number.isSafeInteger(value.fencingToken) ||
      (value.fencingToken as number) < 1 ||
      typeof value.imageRevision !== "string" ||
      typeof value.environmentSpecSha256 !== "string" ||
      !SHA256_PATTERN.test(value.environmentSpecSha256) ||
      typeof value.gitBaselineCommit !== "string" ||
      !GIT_COMMIT_PATTERN.test(value.gitBaselineCommit) ||
      !Number.isSafeInteger(value.totalSizeBytes) ||
      (value.totalSizeBytes as number) < 0 ||
      (value.totalSizeBytes as number) > MAX_WORKSPACE_INDEX_TOTAL_BYTES
    )
      return undefined;
    const files = validateWorkspaceFileList(value.files);
    if (files.reduce((sum, file) => sum + file.sizeBytes, 0) !== value.totalSizeBytes) {
      return undefined;
    }
    return Object.freeze({
      ...(value as unknown as PersistentVolumeReference),
      files,
      recipeCommands: recipeCommands(value.recipeCommands),
    });
  } catch {
    return undefined;
  }
}
