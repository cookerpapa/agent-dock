import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const VOLUME_ID_PATTERN = /^adw-[0-9a-f]{48}$/;
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,4096}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const VOLUME_GENERATION_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const VOLUME_METADATA_DIRECTORY = ".agent-dock-runtime";
export const VOLUME_WORKSPACE_DIRECTORY = "workspace";
export const VOLUME_GENERATION_FILE = "generation";
export const VOLUME_GIT_DIRECTORY = "git";
export const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
export const MAXIMUM_REQUEST_BYTES = 32 * 1_024;
export const MAXIMUM_RESPONSE_BYTES = MAXIMUM_REQUEST_BYTES + 2 * MAX_WORKSPACE_PATCH_BYTES;

export const WORKSPACE_DATA_MOVER_PREPARE_PATH = "/v1/workspaces/prepare";
export const WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH = "/v1/workspaces/initialize-baseline";
export const WORKSPACE_DATA_MOVER_SNAPSHOT_PATH = "/v1/workspaces/snapshot";
export const WORKSPACE_DATA_MOVER_MATERIALIZE_PATH = "/v1/workspaces/materialize";

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

export type VolumeState = Readonly<{
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

export function digest(value: string): Buffer {
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

export function validatedIdentity(input: WorkspaceDataMoverIdentity): WorkspaceDataMoverIdentity {
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

export function validatedSnapshotId(value: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(value)) {
    throw new WorkspaceDataMoverError(
      "workspace_snapshot_identity_invalid",
      "Workspace snapshot identity was invalid",
      false,
    );
  }
  return value;
}

export function validatedGitBaselineCommit(value: string): string {
  if (!GIT_COMMIT_PATTERN.test(value)) {
    throw new WorkspaceDataMoverError(
      "workspace_git_baseline_invalid",
      "Workspace Git baseline was invalid",
      false,
    );
  }
  return value;
}

export function validatedAbsoluteDirectory(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeRelativeFile(value: string): string {
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

export function commandOutput(error: unknown): string {
  if (!isRecord(error)) return "";
  const stderr = error.stderr;
  return typeof stderr === "string" ? stderr.slice(0, 2_048) : "";
}
