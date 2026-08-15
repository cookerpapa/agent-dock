import {
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type ExecuteTurnCommandMessage,
  type EnvironmentValidationReport,
  type SandboxCheckpointBlob,
  type WorkspacePatch,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { PiTurnError } from "./pi-turn-runtime.ts";
import { validateWorkspaceSnapshot } from "./workspace-snapshot.ts";

export type LoadedSandboxCheckpoint = {
  revision?: string;
  workspace?: Uint8Array;
  workspaceRevision?: string;
};

export type CapturedSandboxCheckpoint = {
  workspace: Uint8Array;
  workspacePatch?: WorkspacePatch;
};

export type CapturedEnvironmentSandboxCheckpoint = CapturedSandboxCheckpoint & {
  environment: EnvironmentValidationReport;
};

export type SavedSandboxCheckpoint = {
  revision: string;
  workspaceRevision?: string;
};

export type CapturedToolOutput = {
  toolCallId: string;
  bytes: Uint8Array;
};

export type SavedToolOutputArtifact = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

export interface SandboxCheckpointStore {
  load(command: ExecuteTurnCommandMessage): Promise<LoadedSandboxCheckpoint | undefined>;
  save(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    checkpoint: CapturedEnvironmentSandboxCheckpoint,
  ): Promise<SavedSandboxCheckpoint>;
  saveToolOutput?(
    command: ExecuteTurnCommandMessage,
    output: CapturedToolOutput,
  ): Promise<SavedToolOutputArtifact>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointError(message: string): PiTurnError {
  return new PiTurnError("invalid_checkpoint", message, false);
}

function assertNonEmptyBounded(value: Uint8Array, maxBytes: number, description: string): void {
  if (value.byteLength < 1 || value.byteLength > maxBytes) {
    throw checkpointError(`${description} is outside its byte limit`);
  }
}

function encodeBlob(
  bytes: Uint8Array,
  maxBytes: number,
  description: string,
): SandboxCheckpointBlob {
  assertNonEmptyBounded(bytes, maxBytes, description);
  return {
    encoding: "base64",
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    data: Buffer.from(bytes).toString("base64"),
  };
}

function decodeBlob(
  blob: SandboxCheckpointBlob,
  maxBytes: number,
  description: string,
): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.data)) {
    throw checkpointError(`${description} is not canonical base64`);
  }
  const bytes = Buffer.from(blob.data, "base64");
  if (bytes.toString("base64") !== blob.data) {
    throw checkpointError(`${description} is not canonical base64`);
  }
  assertNonEmptyBounded(bytes, maxBytes, description);
  if (bytes.byteLength !== blob.sizeBytes) {
    throw checkpointError(`${description} length does not match its envelope`);
  }
  if (sha256(bytes) !== blob.sha256) {
    throw checkpointError(`${description} hash does not match its envelope`);
  }
  return bytes;
}

export function encodeWorkspaceSnapshot(snapshot: Uint8Array): SandboxCheckpointBlob {
  validateWorkspaceSnapshot(snapshot);
  return encodeBlob(snapshot, MAX_WORKSPACE_SNAPSHOT_BYTES, "Workspace snapshot");
}

export function decodeWorkspaceSnapshot(blob: SandboxCheckpointBlob): Uint8Array {
  const snapshot = decodeBlob(blob, MAX_WORKSPACE_SNAPSHOT_BYTES, "Workspace snapshot");
  validateWorkspaceSnapshot(snapshot);
  return snapshot;
}

export function validateLoadedCheckpoint(
  checkpoint: LoadedSandboxCheckpoint | undefined,
): LoadedSandboxCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  if (
    checkpoint.revision !== undefined &&
    (checkpoint.revision.length < 1 || checkpoint.revision.length > 256)
  ) {
    throw checkpointError("Checkpoint revision is invalid");
  }
  if (
    checkpoint.revision === undefined &&
    (checkpoint.workspace !== undefined || checkpoint.workspaceRevision !== undefined)
  ) {
    throw checkpointError("Checkpoint revision is missing");
  }
  if (checkpoint.workspace !== undefined) validateWorkspaceSnapshot(checkpoint.workspace);
  if (
    checkpoint.workspaceRevision !== undefined &&
    !/^[0-9a-f]{64}$/.test(checkpoint.workspaceRevision)
  ) {
    throw checkpointError("Workspace checkpoint revision is invalid");
  }
  if (checkpoint.workspace === undefined && checkpoint.workspaceRevision !== undefined) {
    throw checkpointError("Workspace checkpoint metadata is incomplete");
  }
  if (checkpoint.workspace !== undefined && checkpoint.workspaceRevision === undefined) {
    return {
      ...checkpoint,
      workspaceRevision: sha256(checkpoint.workspace),
    };
  }
  return checkpoint;
}
