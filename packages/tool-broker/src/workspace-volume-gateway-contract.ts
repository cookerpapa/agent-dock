import {
  MAX_WORKSPACE_PATCH_BYTES,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type WorkspacePatch,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const VOLUME_ID_PATTERN = /^pcw-[0-9a-f]{48}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,4096}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const VOLUME_GENERATION_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const VOLUME_METADATA_DIRECTORY = ".pi-cloud-runtime";
export const VOLUME_WORKSPACE_DIRECTORY = "workspace";
export const VOLUME_GENERATION_FILE = "generation";
export const VOLUME_GIT_DIRECTORY = "git";
export const MAXIMUM_REQUEST_BYTES = 32 * 1_024;
// A snapshot response carries the bounded persistent-volume reference metadata
// plus its bounded diff. Workspace file bytes never cross this interface.
export const MAXIMUM_RESPONSE_BYTES =
  MAX_WORKSPACE_SNAPSHOT_BYTES + 2 * MAX_WORKSPACE_PATCH_BYTES + MAXIMUM_REQUEST_BYTES;

export const WORKSPACE_VOLUME_GATEWAY_PREPARE_PATH = "/v1/workspaces/prepare";
export const WORKSPACE_VOLUME_GATEWAY_INITIALIZE_BASELINE_PATH =
  "/v1/workspaces/initialize-baseline";
export const WORKSPACE_VOLUME_GATEWAY_SNAPSHOT_PATH = "/v1/workspaces/snapshot";
export const WORKSPACE_VOLUME_GATEWAY_FORK_PATH = "/v1/workspaces/fork";
export const WORKSPACE_VOLUME_GATEWAY_MATERIALIZE_PATH = "/v1/workspaces/materialize";
export const WORKSPACE_VOLUME_GATEWAY_DELETE_PATH = "/v1/workspaces/delete";

export type WorkspaceVolumeGatewayVolumeIdentity = Readonly<{
  tenantId: string;
  workspaceId: string;
  volumeId: string;
}>;

export type WorkspaceVolumeGatewayIdentity = WorkspaceVolumeGatewayVolumeIdentity &
  Readonly<{
    sessionId: string;
  }>;

export type WorkspaceVolumeGatewayPrepareInput = WorkspaceVolumeGatewayIdentity;

export type WorkspaceVolumeGatewayInitializeBaselineInput = WorkspaceVolumeGatewayIdentity;

export type WorkspaceVolumeGatewaySnapshotInput = WorkspaceVolumeGatewayIdentity &
  Readonly<{
    activationId: string;
    fencingToken: number;
    bindingSha256: string;
  }>;

export type WorkspaceVolumeGatewayMaterializeInput = WorkspaceVolumeGatewayIdentity &
  Readonly<{
    path: string;
    expectedSha256: string;
    maximumBytes: number;
  }>;

export type WorkspaceVolumeGatewayForkInput = Readonly<{
  tenantId: string;
  sourceWorkspaceId: string;
  sourceSessionId: string;
  sourceVolumeId: string;
  expectedSourceRevision: string;
  targetWorkspaceId: string;
  targetSessionId: string;
  targetVolumeId: string;
}>;

export type WorkspaceVolumeGatewayDeleteInput = WorkspaceVolumeGatewayVolumeIdentity;

export interface WorkspaceVolumeGateway {
  checkHealth(): Promise<void>;
  prepare(input: WorkspaceVolumeGatewayPrepareInput): Promise<{ attached: boolean }>;
  initializeBaseline(
    input: WorkspaceVolumeGatewayInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }>;
  snapshot(input: WorkspaceVolumeGatewaySnapshotInput): Promise<{
    volumeRevision: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
    files: readonly import("@pi-cloud/workspace-runtime").WorkspaceSnapshotFileMetadata[];
  }>;
  fork(input: WorkspaceVolumeGatewayForkInput): Promise<{
    sourceRevision: string;
    volumeRevision: string;
    gitBaselineCommit: string;
    files: readonly import("@pi-cloud/workspace-runtime").WorkspaceSnapshotFileMetadata[];
  }>;
  materialize(
    input: WorkspaceVolumeGatewayMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }>;
  delete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ deleted: boolean }>;
  close(): Promise<void>;
}

export interface WorkspaceVolumeGatewayLock {
  withLock<T>(volumeId: string, run: () => Promise<T>): Promise<T>;
  withLocks?<T>(volumeIds: readonly string[], run: () => Promise<T>): Promise<T>;
}

export type PersistentVolumeWorkspaceVolumeGatewayOptions = Readonly<{
  workspaceRoot: string;
  lock?: WorkspaceVolumeGatewayLock;
}>;

export type VolumeState = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  workspaceId: string;
  volumeId: string;
  volumeGeneration: string;
  gitBaselineCommit: string;
  forkedFrom?: Readonly<{ workspaceId: string; volumeRevision: string }>;
}>;

export class WorkspaceVolumeGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "WorkspaceVolumeGatewayError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function boundedOpaque(value: string, name: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_data_identity_invalid",
      `${name} was invalid`,
      false,
    );
  }
  return value;
}

export function workspaceVolumeId(identity: { tenantId: string; workspaceId: string }): string {
  boundedOpaque(identity.tenantId, "tenantId");
  boundedOpaque(identity.workspaceId, "workspaceId");
  return `pcw-${createHash("sha256")
    .update("pi-cloud.workspace-volume.v1\0")
    .update(identity.tenantId)
    .update("\0")
    .update(identity.workspaceId)
    .digest("hex")
    .slice(0, 48)}`;
}

export function validatedIdentity(
  input: WorkspaceVolumeGatewayIdentity,
): WorkspaceVolumeGatewayIdentity {
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
    throw new WorkspaceVolumeGatewayError(
      "workspace_data_binding_invalid",
      "Workspace volume binding was invalid",
      false,
    );
  }
  return identity;
}

export function validatedVolumeIdentity(
  input: WorkspaceVolumeGatewayVolumeIdentity,
): WorkspaceVolumeGatewayVolumeIdentity {
  const identity = Object.freeze({
    tenantId: boundedOpaque(input.tenantId, "tenantId"),
    workspaceId: boundedOpaque(input.workspaceId, "workspaceId"),
    volumeId: input.volumeId,
  });
  if (
    !VOLUME_ID_PATTERN.test(identity.volumeId) ||
    workspaceVolumeId(identity) !== identity.volumeId
  ) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_data_binding_invalid",
      "Workspace volume binding was invalid",
      false,
    );
  }
  return identity;
}

export function validatedGitBaselineCommit(value: string): string {
  if (!GIT_COMMIT_PATTERN.test(value)) {
    throw new WorkspaceVolumeGatewayError(
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
    throw new WorkspaceVolumeGatewayError(
      "workspace_materialize_path_invalid",
      "Workspace materialize path was invalid",
      false,
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WorkspaceVolumeGatewayError(
      "workspace_materialize_path_invalid",
      "Workspace materialize path was invalid",
      false,
    );
  }
  return value;
}
