import {
  MAX_PI_SESSION_SNAPSHOT_BYTES,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type ExecuteTurnCommandMessage,
  type EnvironmentValidationReport,
  type SandboxCheckpointBlob,
  type SandboxSettledCheckpoint,
  type WorkspacePatch,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { PiRpcTurnError } from "./pi-rpc-turn-runner.ts";
import { validateWorkspaceSnapshot } from "./workspace-snapshot.ts";

export type LoadedSandboxCheckpoint = {
  revision: string;
  piSession: Uint8Array;
  workspace?: Uint8Array;
  workspaceRevision?: string;
};

export type CapturedSandboxCheckpoint = {
  piSession: Uint8Array;
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
  saveConversation(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
  ): Promise<SavedSandboxCheckpoint>;
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

function checkpointError(message: string): PiRpcTurnError {
  return new PiRpcTurnError("invalid_checkpoint", message, false);
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

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePiSessionSnapshot(bytes: Uint8Array): void {
  assertNonEmptyBounded(bytes, MAX_PI_SESSION_SNAPSHOT_BYTES, "Pi session snapshot");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw checkpointError("Pi session snapshot is not valid UTF-8");
  }
  if (text.includes("\0")) throw checkpointError("Pi session snapshot contains a NUL byte");
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length < 2) throw checkpointError("Pi session snapshot is not settled");
  let hasAssistant = false;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw checkpointError("Pi session snapshot contains malformed JSONL");
    }
    if (!jsonRecord(parsed)) throw checkpointError("Pi session JSONL entry is not an object");
    if (index === 0) {
      if (
        parsed.type !== "session" ||
        typeof parsed.id !== "string" ||
        parsed.id.length === 0 ||
        parsed.cwd !== "/workspace"
      ) {
        throw checkpointError("Pi session header does not belong to the sandbox workspace");
      }
      continue;
    }
    if (
      parsed.type === "message" &&
      jsonRecord(parsed.message) &&
      parsed.message.role === "assistant"
    ) {
      hasAssistant = true;
    }
  }
  if (!hasAssistant) throw checkpointError("Pi session snapshot has no settled assistant message");
}

export function encodeSettledCheckpoint(
  checkpoint: CapturedSandboxCheckpoint,
): SandboxSettledCheckpoint {
  validatePiSessionSnapshot(checkpoint.piSession);
  validateWorkspaceSnapshot(checkpoint.workspace);
  return {
    format: "agent-dock.settled-checkpoint.v1",
    piSession: encodeBlob(
      checkpoint.piSession,
      MAX_PI_SESSION_SNAPSHOT_BYTES,
      "Pi session snapshot",
    ),
    workspace: encodeBlob(checkpoint.workspace, MAX_WORKSPACE_SNAPSHOT_BYTES, "Workspace snapshot"),
    ...(checkpoint.workspacePatch === undefined
      ? {}
      : { workspacePatch: checkpoint.workspacePatch }),
  };
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

export function decodeSettledCheckpoint(
  checkpoint: SandboxSettledCheckpoint,
): CapturedSandboxCheckpoint {
  if (checkpoint.format !== "agent-dock.settled-checkpoint.v1") {
    throw checkpointError("Checkpoint format is unsupported");
  }
  const piSession = decodeBlob(
    checkpoint.piSession,
    MAX_PI_SESSION_SNAPSHOT_BYTES,
    "Pi session snapshot",
  );
  const workspace = decodeBlob(
    checkpoint.workspace,
    MAX_WORKSPACE_SNAPSHOT_BYTES,
    "Workspace snapshot",
  );
  validatePiSessionSnapshot(piSession);
  validateWorkspaceSnapshot(workspace);
  return {
    piSession,
    workspace,
    ...(checkpoint.workspacePatch === undefined
      ? {}
      : { workspacePatch: checkpoint.workspacePatch }),
  };
}

export function validateLoadedCheckpoint(
  checkpoint: LoadedSandboxCheckpoint | undefined,
): LoadedSandboxCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  if (checkpoint.revision.length < 1 || checkpoint.revision.length > 256) {
    throw checkpointError("Checkpoint revision is invalid");
  }
  validatePiSessionSnapshot(checkpoint.piSession);
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
    return { ...checkpoint, workspaceRevision: sha256(checkpoint.workspace) };
  }
  return checkpoint;
}
