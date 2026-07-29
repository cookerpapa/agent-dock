import {
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type EnvironmentRecipeCommandResult,
} from "@agent-dock/protocol";
import { TextDecoder } from "node:util";
import {
  MAX_WORKSPACE_INDEX_TOTAL_BYTES,
  validateWorkspaceFileList,
  type WorkspaceSnapshotFileMetadata,
} from "./workspace-index.ts";
import { WorkspaceRuntimeError } from "./workspace-error.ts";

export const KOPIA_WORKSPACE_CHECKPOINT_FORMAT = "agent-dock.workspace-kopia-snapshot.v3";
const KOPIA_WORKSPACE_CHECKPOINT_FORMAT_PREFIX = "agent-dock.workspace-kopia-snapshot.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VOLUME_ID_PATTERN = /^adw-[0-9a-f]{48}$/;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export type KopiaWorkspaceCheckpoint = Readonly<{
  format: typeof KOPIA_WORKSPACE_CHECKPOINT_FORMAT;
  providerId: "cubesandbox";
  snapshotId: string;
  volumeId: string;
  activationId: string;
  tenantId: string;
  workspaceId: string;
  sourceSessionId: string;
  bindingSha256: string;
  fencingToken: number;
  imageRevision: string;
  environmentSpecSha256: string;
  totalSizeBytes: number;
  files: readonly WorkspaceSnapshotFileMetadata[];
  recipeCommands: readonly EnvironmentRecipeCommandResult[];
}>;

export type CreateKopiaWorkspaceCheckpointInput = Omit<
  KopiaWorkspaceCheckpoint,
  "format" | "providerId" | "files" | "totalSizeBytes" | "recipeCommands"
> & {
  files: readonly WorkspaceSnapshotFileMetadata[];
  recipeCommands: readonly EnvironmentRecipeCommandResult[];
};

function checkpointError(message: string): WorkspaceRuntimeError {
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

function validateRecipeCommands(value: unknown): readonly EnvironmentRecipeCommandResult[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw checkpointError("Kopia Workspace checkpoint recipe evidence is invalid");
  }
  const ids = new Set<string>();
  const commands: EnvironmentRecipeCommandResult[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !["id", "phase", "exitCode", "durationMs", "outputSha256"].every((key) =>
        Object.hasOwn(candidate, key),
      ) ||
      Object.keys(candidate).some(
        (key) =>
          !["id", "phase", "exitCode", "durationMs", "outputSha256", "outputSummary"].includes(key),
      ) ||
      typeof candidate.id !== "string" ||
      !COMMAND_ID_PATTERN.test(candidate.id) ||
      candidate.id.length > 64 ||
      ids.has(candidate.id) ||
      (candidate.phase !== "setup" && candidate.phase !== "verification") ||
      !Number.isSafeInteger(candidate.exitCode) ||
      (candidate.exitCode as number) < 0 ||
      (candidate.exitCode as number) > 255 ||
      !Number.isSafeInteger(candidate.durationMs) ||
      (candidate.durationMs as number) < 0 ||
      typeof candidate.outputSha256 !== "string" ||
      !SHA256_PATTERN.test(candidate.outputSha256) ||
      (candidate.outputSummary !== undefined &&
        (typeof candidate.outputSummary !== "string" ||
          candidate.outputSummary.length > 512 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.outputSummary)))
    ) {
      throw checkpointError("Kopia Workspace checkpoint recipe entry is invalid");
    }
    ids.add(candidate.id);
    commands.push(
      Object.freeze({
        id: candidate.id,
        phase: candidate.phase,
        exitCode: candidate.exitCode as number,
        durationMs: candidate.durationMs as number,
        outputSha256: candidate.outputSha256,
        ...(candidate.outputSummary === undefined
          ? {}
          : { outputSummary: candidate.outputSummary }),
      }),
    );
  }
  return Object.freeze(commands);
}

function parseCheckpointRecord(value: Record<string, unknown>): KopiaWorkspaceCheckpoint {
  if (
    !exactKeys(value, [
      "format",
      "providerId",
      "snapshotId",
      "volumeId",
      "activationId",
      "tenantId",
      "workspaceId",
      "sourceSessionId",
      "bindingSha256",
      "fencingToken",
      "imageRevision",
      "environmentSpecSha256",
      "totalSizeBytes",
      "files",
      "recipeCommands",
    ]) ||
    value.format !== KOPIA_WORKSPACE_CHECKPOINT_FORMAT ||
    value.providerId !== "cubesandbox" ||
    typeof value.snapshotId !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(value.snapshotId) ||
    typeof value.volumeId !== "string" ||
    !VOLUME_ID_PATTERN.test(value.volumeId) ||
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
    value.imageRevision.length < 1 ||
    value.imageRevision.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value.imageRevision) ||
    typeof value.environmentSpecSha256 !== "string" ||
    !SHA256_PATTERN.test(value.environmentSpecSha256) ||
    !Number.isSafeInteger(value.totalSizeBytes) ||
    (value.totalSizeBytes as number) < 0 ||
    (value.totalSizeBytes as number) > MAX_WORKSPACE_INDEX_TOTAL_BYTES
  ) {
    throw checkpointError("Kopia Workspace checkpoint shape is invalid");
  }
  const files = validateWorkspaceFileList(value.files);
  const totalSizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalSizeBytes !== value.totalSizeBytes) {
    throw checkpointError("Kopia Workspace checkpoint byte total is inconsistent");
  }
  return Object.freeze({
    format: KOPIA_WORKSPACE_CHECKPOINT_FORMAT,
    providerId: "cubesandbox",
    snapshotId: value.snapshotId,
    volumeId: value.volumeId,
    activationId: value.activationId,
    tenantId: value.tenantId,
    workspaceId: value.workspaceId,
    sourceSessionId: value.sourceSessionId,
    bindingSha256: value.bindingSha256,
    fencingToken: value.fencingToken as number,
    imageRevision: value.imageRevision,
    environmentSpecSha256: value.environmentSpecSha256,
    totalSizeBytes,
    files,
    recipeCommands: validateRecipeCommands(value.recipeCommands),
  });
}

export function parseKopiaWorkspaceCheckpoint(
  snapshot: Uint8Array,
): KopiaWorkspaceCheckpoint | undefined {
  if (snapshot.byteLength < 1 || snapshot.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw checkpointError("Workspace checkpoint is outside its byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot)) as unknown;
  } catch {
    throw checkpointError("Workspace checkpoint is not valid UTF-8 JSON");
  }
  if (!isRecord(parsed)) return undefined;
  if (
    typeof parsed.format === "string" &&
    parsed.format.startsWith(KOPIA_WORKSPACE_CHECKPOINT_FORMAT_PREFIX) &&
    parsed.format !== KOPIA_WORKSPACE_CHECKPOINT_FORMAT
  ) {
    throw checkpointError("Kopia Workspace checkpoint format is unsupported");
  }
  if (parsed.format !== KOPIA_WORKSPACE_CHECKPOINT_FORMAT) return undefined;
  return parseCheckpointRecord(parsed);
}

export function createKopiaWorkspaceCheckpoint(
  input: CreateKopiaWorkspaceCheckpointInput,
): Uint8Array {
  const files = validateWorkspaceFileList(input.files);
  const recipeCommands = validateRecipeCommands(input.recipeCommands);
  const encoded = Buffer.from(
    `${JSON.stringify({
      format: KOPIA_WORKSPACE_CHECKPOINT_FORMAT,
      providerId: "cubesandbox",
      snapshotId: input.snapshotId,
      volumeId: input.volumeId,
      activationId: input.activationId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      sourceSessionId: input.sourceSessionId,
      bindingSha256: input.bindingSha256,
      fencingToken: input.fencingToken,
      imageRevision: input.imageRevision,
      environmentSpecSha256: input.environmentSpecSha256,
      totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      files,
      recipeCommands,
    })}\n`,
    "utf8",
  );
  if (encoded.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw checkpointError("Kopia Workspace checkpoint index is outside its byte limit");
  }
  parseKopiaWorkspaceCheckpoint(encoded);
  return encoded;
}
