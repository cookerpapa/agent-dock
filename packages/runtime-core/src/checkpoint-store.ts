import type { Database } from "@agent-dock/database";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import {
  MAX_TOOL_OUTPUT_BYTES,
  MAX_WORKSPACE_PATCH_BYTES,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  parseConversationTurnTranscriptResource,
  parseEnvironmentValidationReport,
} from "@agent-dock/protocol";
import {
  validatePiSessionSnapshot,
  type CapturedEnvironmentSandboxCheckpoint,
  type CapturedToolOutput,
  type LoadedSandboxCheckpoint,
  type PiDurableRecoverySuffix,
  type SandboxCheckpointStore,
  type SavedSandboxCheckpoint,
  type SavedToolOutputArtifact,
} from "@agent-dock/sandbox-supervisor/sandbox-checkpoint";
import {
  PINNED_PI_CODING_AGENT_VERSION,
  PiTurnError,
} from "@agent-dock/sandbox-supervisor/pi-turn-runtime";
import { validateWorkspaceSnapshot } from "@agent-dock/sandbox-supervisor/workspace-snapshot";
import { createHash, randomUUID } from "node:crypto";
import { workspaceSnapshotFileCount } from "@agent-dock/workspace-runtime";
import { lstat, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  PI_SESSION_MANIFEST_MEDIA_TYPE,
  PI_SESSION_MANIFEST_MAX_BYTES,
  PiSessionManifestError,
  decodePiSessionManifest,
  preparePiSessionManifest,
  restorePiSessionManifest,
  type PiSessionManifest,
  type PiSessionSegmentDescriptor,
} from "./pi-session-manifest.ts";

// One object is either an 8 MiB Pi segment, a bounded manifest, or a compressed
// event archive whose uncompressed limit is 128 MiB. Keep the object-store
// guard comfortably above those payloads without permitting unbounded reads.
export const MAX_CHECKPOINT_OBJECT_BYTES = 136 * 1_024 * 1_024;
const PI_SEGMENT_UPLOAD_CONCURRENCY = 4;

export interface CheckpointObjectStore {
  put(objectKey: string, bytes: Uint8Array): Promise<void>;
  get(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}

export type FileCheckpointObjectStoreOptions = {
  rootDirectory: string;
  idGenerator?: () => string;
};

export type PostgresSandboxCheckpointStoreOptions = {
  database: Kysely<Database>;
  objectStore: CheckpointObjectStore;
  clock?: () => Date;
  idGenerator?: () => string;
};

type ArtifactReference = {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mediaType?: string;
};

type CheckpointMetadata = {
  piSession?: ArtifactReference;
  piSessionThroughSequence: number;
  workspace?: ArtifactReference;
  revision: string;
  workspaceRevision?: string;
};

type LoadedPiSessionState = {
  bytes: Uint8Array;
  manifest: PiSessionManifest;
  manifestSha256: string;
};

type LoadedPiSessionManifestState = Omit<LoadedPiSessionState, "bytes">;

type PreparedPiSessionArtifact = {
  artifactId: string;
  reference: ArtifactReference;
  fileName: string;
  mediaType: string;
};

export class SandboxCheckpointStoreError extends PiTurnError {
  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(code, safeMessage, retryable);
    this.name = "SandboxCheckpointStoreError";
  }
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("checkpoint store clock must return a valid Date");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeSize(value: string | number | bigint, maximum: number, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new SandboxCheckpointStoreError(
      "checkpoint_metadata_invalid",
      `${description} metadata is invalid`,
      false,
    );
  }
  return parsed;
}

function revisionFor(piSessionKey?: string, workspaceKey?: string): string {
  return createHash("sha256")
    .update("agent-dock.checkpoint-revision.v1\0")
    .update(piSessionKey ?? "pi-session-absent")
    .update("\0")
    .update(workspaceKey ?? "workspace-absent")
    .digest("hex");
}

export function validateCheckpointObjectKey(value: string): string {
  if (
    value.length < 1 ||
    value.length > 2_048 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new SandboxCheckpointStoreError(
      "checkpoint_object_key_invalid",
      "Checkpoint object key is invalid",
      false,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new SandboxCheckpointStoreError(
      "checkpoint_object_key_invalid",
      "Checkpoint object key is invalid",
      false,
    );
  }
  return value;
}

export class FileCheckpointObjectStore implements CheckpointObjectStore {
  readonly #rootDirectory: string;
  readonly #idGenerator: () => string;

  constructor(options: FileCheckpointObjectStoreOptions) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const target = this.#target(objectKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${this.#idGenerator()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, target);
      await rm(temporary, { force: true });
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const target = this.#target(objectKey);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_object_invalid",
        "Checkpoint object is not a regular file",
        false,
      );
    }
    if (metadata.size < 1 || metadata.size > MAX_CHECKPOINT_OBJECT_BYTES) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_object_invalid",
        "Checkpoint object is outside its byte limit",
        false,
      );
    }
    return readFile(target);
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.#target(objectKey), { force: true });
  }

  #target(objectKey: string): string {
    const target = resolve(this.#rootDirectory, validateCheckpointObjectKey(objectKey));
    if (target !== this.#rootDirectory && !target.startsWith(`${this.#rootDirectory}${sep}`)) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_object_key_invalid",
        "Checkpoint object key escaped its store",
        false,
      );
    }
    return target;
  }
}

export class PostgresSandboxCheckpointStore implements SandboxCheckpointStore {
  readonly #database: Kysely<Database>;
  readonly #objectStore: CheckpointObjectStore;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PostgresSandboxCheckpointStoreOptions) {
    this.#database = options.database;
    this.#objectStore = options.objectStore;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async load(command: ExecuteTurnCommandMessage): Promise<LoadedSandboxCheckpoint | undefined> {
    const metadata = await this.#database.transaction().execute(async (transaction) => {
      return this.#loadMetadata(transaction, command, validDate(this.#clock));
    });
    const recoverySuffix = await this.#loadRecoverySuffix(
      command,
      metadata?.piSessionThroughSequence ?? 0,
    );
    if (metadata === undefined) {
      return recoverySuffix === undefined ? undefined : { recoverySuffix };
    }

    const [piState, workspace] = await Promise.all([
      metadata.piSession === undefined
        ? Promise.resolve(undefined)
        : this.#loadPiSession(command, metadata.piSession),
      metadata.workspace === undefined
        ? Promise.resolve(undefined)
        : this.#objectStore.get(metadata.workspace.objectKey),
    ]);
    if (workspace !== undefined && metadata.workspace !== undefined) {
      this.#verifyObject(workspace, metadata.workspace, MAX_WORKSPACE_SNAPSHOT_BYTES, "workspace");
    }
    if (piState !== undefined) validatePiSessionSnapshot(piState.bytes);
    if (workspace !== undefined) validateWorkspaceSnapshot(workspace);

    await this.#database.transaction().execute(async (transaction) => {
      const current = await this.#loadMetadata(transaction, command, validDate(this.#clock));
      if (current?.revision !== metadata.revision) {
        throw new SandboxCheckpointStoreError(
          "checkpoint_changed",
          "Settled checkpoint changed while it was loading",
          true,
        );
      }
    });
    return {
      revision: metadata.revision,
      ...(piState === undefined ? {} : { piSession: piState.bytes }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(metadata.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: metadata.workspaceRevision }),
      ...(recoverySuffix === undefined ? {} : { recoverySuffix }),
    };
  }

  async #loadRecoverySuffix(
    command: ExecuteTurnCommandMessage,
    checkpointThroughSequence: number,
  ): Promise<PiDurableRecoverySuffix | undefined> {
    const rows = await this.#database
      .selectFrom("conversation_turn_projections as projection")
      .innerJoin("turns as turn_row", (join) =>
        join
          .onRef("turn_row.tenant_id", "=", "projection.tenant_id")
          .onRef("turn_row.session_id", "=", "projection.session_id")
          .onRef("turn_row.id", "=", "projection.turn_id"),
      )
      .select([
        "projection.turn_id as turnId",
        "projection.through_seq as throughSequence",
        "projection.transcript",
        "turn_row.input_text as input",
      ])
      .where("projection.tenant_id", "=", command.payload.tenantId)
      .where("projection.session_id", "=", command.payload.sessionId)
      .where("projection.through_seq", ">", String(checkpointThroughSequence))
      .where("turn_row.id", "!=", command.payload.turnId)
      .where("turn_row.state", "in", ["completed", "failed", "cancelled"])
      .orderBy("projection.through_seq", "asc")
      .limit(33)
      .execute();
    if (rows.length === 0) return undefined;
    if (rows.length > 32) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_recovery_overflow",
        "Too many terminal Turns exist beyond the Pi checkpoint",
        false,
      );
    }
    const turns = rows.map((row) => {
      if (row.input === null || row.input.length === 0) {
        throw new SandboxCheckpointStoreError(
          "checkpoint_recovery_invalid",
          "A recoverable Turn has no accepted prompt",
          false,
        );
      }
      return {
        turnId: row.turnId,
        input: row.input,
        transcript: parseConversationTurnTranscriptResource(row.transcript),
      };
    });
    const recoveredThroughSequence = Number(rows.at(-1)!.throughSequence);
    if (
      !Number.isSafeInteger(recoveredThroughSequence) ||
      recoveredThroughSequence <= checkpointThroughSequence
    ) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_recovery_invalid",
        "Pi recovery event sequence is invalid",
        false,
      );
    }
    return {
      checkpointThroughSequence,
      recoveredThroughSequence,
      turns,
    };
  }

  async saveConversation(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
  ): Promise<SavedSandboxCheckpoint> {
    return this.#saveConversationArtifact(
      command,
      baseRevision,
      piSession,
      "pi_session_snapshot",
      false,
    );
  }

  async saveInterruptedConversation(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
  ): Promise<SavedSandboxCheckpoint> {
    return this.#saveConversationArtifact(
      command,
      baseRevision,
      piSession,
      "pi_interrupted_session_snapshot",
      true,
    );
  }

  async #saveConversationArtifact(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
    kind: "pi_session_snapshot" | "pi_interrupted_session_snapshot",
    allowCancellation: boolean,
  ): Promise<SavedSandboxCheckpoint> {
    validatePiSessionSnapshot(piSession);
    const piArtifact = await this.#preparePiSessionArtifact(
      command,
      baseRevision,
      piSession,
      allowCancellation,
    );
    const { artifactId, reference } = piArtifact;
    let saved: SavedSandboxCheckpoint | undefined;
    try {
      saved = await this.#database.transaction().execute(async (transaction) => {
        const now = validDate(this.#clock);
        const current = await this.#assertCurrentSession(
          transaction,
          command,
          now,
          true,
          allowCancellation,
        );
        const settled = await this.#settledMetadata(transaction, command, current);
        if ((settled?.revision ?? null) !== baseRevision) {
          throw new SandboxCheckpointStoreError(
            "checkpoint_conflict",
            "Settled checkpoint base revision is stale",
            false,
          );
        }
        await transaction
          .insertInto("artifacts")
          .values({
            id: artifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind,
            object_key: reference.objectKey,
            sha256: reference.sha256,
            size_bytes: reference.sizeBytes,
            file_name: piArtifact.fileName,
            media_type: piArtifact.mediaType,
          })
          .executeTakeFirstOrThrow();
        const updated = await transaction
          .updateTable("sessions")
          .set({
            pi_session_snapshot_key: reference.objectKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("id", "=", command.payload.sessionId)
          .where("tenant_id", "=", command.payload.tenantId)
          .where("row_version", "=", current.rowVersion)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new SandboxCheckpointStoreError(
            "checkpoint_conflict",
            "Session changed before its conversation checkpoint commit",
            true,
          );
        }
        return {
          revision: revisionFor(reference.objectKey, settled?.workspace?.objectKey),
          ...(settled?.workspaceRevision === undefined
            ? {}
            : { workspaceRevision: settled.workspaceRevision }),
        };
      });
    } catch (error: unknown) {
      // Content-addressed Pi segments/manifests may already be referenced by a
      // committed checkpoint. A later orphan collector, not a failed writer,
      // decides when an unreferenced object is safe to remove.
      throw error;
    }
    return saved;
  }

  async saveToolOutput(
    command: ExecuteTurnCommandMessage,
    output: CapturedToolOutput,
  ): Promise<SavedToolOutputArtifact> {
    if (
      output.toolCallId.length < 1 ||
      output.toolCallId.length > 256 ||
      output.bytes.byteLength < 1 ||
      output.bytes.byteLength > MAX_TOOL_OUTPUT_BYTES
    ) {
      throw new SandboxCheckpointStoreError(
        "tool_output_invalid",
        "Tool output artifact is outside its identity or byte limit",
        false,
      );
    }
    const artifactId = this.#idGenerator();
    const digest = sha256(output.bytes);
    const safe = [
      "tool-outputs",
      command.payload.tenantId,
      command.payload.sessionId,
      command.payload.runId,
      command.payload.attemptId,
    ].map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
    const objectKey = `${safe.join("/")}/${artifactId}-${digest}.log`;
    validateCheckpointObjectKey(objectKey);
    await this.#objectStore.put(objectKey, output.bytes);
    try {
      await this.#database.transaction().execute(async (transaction) => {
        await this.#assertCurrentSession(transaction, command, validDate(this.#clock), true);
        await transaction
          .insertInto("artifacts")
          .values({
            id: artifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind: "tool_output",
            object_key: objectKey,
            sha256: digest,
            size_bytes: output.bytes.byteLength,
            file_name: `tool-output-${artifactId}.log`,
            media_type: "text/plain; charset=utf-8",
          })
          .executeTakeFirstOrThrow();
      });
    } catch (error: unknown) {
      await this.#objectStore.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return { artifactId, sha256: digest, sizeBytes: output.bytes.byteLength };
  }

  async save(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    checkpoint: CapturedEnvironmentSandboxCheckpoint,
  ): Promise<SavedSandboxCheckpoint> {
    const environment = parseEnvironmentValidationReport(checkpoint.environment);
    if (
      environment.profileKey !== command.payload.environment.profileKey ||
      environment.profileVersion !== command.payload.environment.profileVersion ||
      environment.imageRevision !== command.payload.environment.imageRevision ||
      environment.specSha256 !== command.payload.environment.specSha256 ||
      environment.recipeSha256 !== command.payload.environment.recipeSha256
    ) {
      throw new SandboxCheckpointStoreError(
        "environment_validation_mismatch",
        "Tool Sandbox environment evidence did not match the accepted Run",
        false,
      );
    }
    validatePiSessionSnapshot(checkpoint.piSession);
    validateWorkspaceSnapshot(checkpoint.workspace);
    const piArtifact = await this.#preparePiSessionArtifact(
      command,
      baseRevision,
      checkpoint.piSession,
    );
    const piArtifactId = piArtifact.artifactId;
    const workspaceArtifactId = this.#idGenerator();
    const rawPatchBytes =
      checkpoint.workspacePatch === undefined
        ? undefined
        : Buffer.from(checkpoint.workspacePatch.patch, "utf8");
    const patchBytes =
      rawPatchBytes === undefined || rawPatchBytes.byteLength === 0 ? undefined : rawPatchBytes;
    const patchArtifactId = patchBytes === undefined ? undefined : this.#idGenerator();
    const versionId = this.#idGenerator();
    const environmentValidationId = this.#idGenerator();
    const prefix = [
      "checkpoints",
      command.payload.tenantId,
      command.payload.sessionId,
      command.payload.turnId,
    ].map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
    const piReference = piArtifact.reference;
    const workspaceReference: ArtifactReference = {
      objectKey: `${prefix.join("/")}/${workspaceArtifactId}-workspace-${sha256(checkpoint.workspace)}.json`,
      sha256: sha256(checkpoint.workspace),
      sizeBytes: checkpoint.workspace.byteLength,
    };
    if (patchBytes !== undefined && patchBytes.byteLength > MAX_WORKSPACE_PATCH_BYTES) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_patch_invalid",
        "Workspace patch exceeds its byte limit",
        false,
      );
    }
    const patchReference =
      patchBytes === undefined || patchArtifactId === undefined
        ? undefined
        : {
            objectKey: `${prefix.join("/")}/${patchArtifactId}-patch-${sha256(patchBytes)}.diff`,
            sha256: sha256(patchBytes),
            sizeBytes: patchBytes.byteLength,
          };
    validateCheckpointObjectKey(piReference.objectKey);
    validateCheckpointObjectKey(workspaceReference.objectKey);
    if (patchReference !== undefined) validateCheckpointObjectKey(patchReference.objectKey);

    try {
      await this.#objectStore.put(workspaceReference.objectKey, checkpoint.workspace);
    } catch (error: unknown) {
      throw error;
    }
    if (patchReference !== undefined && patchBytes !== undefined) {
      try {
        await this.#objectStore.put(patchReference.objectKey, patchBytes);
      } catch (error: unknown) {
        await Promise.allSettled([this.#objectStore.delete(workspaceReference.objectKey)]);
        throw error;
      }
    }

    try {
      await this.#database.transaction().execute(async (transaction) => {
        const now = validDate(this.#clock);
        const current = await this.#lockSession(transaction, command, now);
        const settled = await this.#settledMetadata(transaction, command, current);
        const currentRevision = settled?.revision ?? null;
        if (currentRevision !== baseRevision) {
          throw new SandboxCheckpointStoreError(
            "checkpoint_conflict",
            "Settled checkpoint base revision is stale",
            false,
          );
        }
        const revision = revisionFor(piReference.objectKey, workspaceReference.objectKey);
        const artifacts = [
          {
            id: piArtifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind: "pi_session_snapshot" as const,
            object_key: piReference.objectKey,
            sha256: piReference.sha256,
            size_bytes: piReference.sizeBytes,
            file_name: piArtifact.fileName,
            media_type: piArtifact.mediaType,
          },
          {
            id: workspaceArtifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind: "workspace_snapshot" as const,
            object_key: workspaceReference.objectKey,
            sha256: workspaceReference.sha256,
            size_bytes: workspaceReference.sizeBytes,
            file_name: "workspace.json",
            media_type: "application/vnd.agent-dock.workspace+json",
          },
          ...(patchReference === undefined || patchArtifactId === undefined
            ? []
            : [
                {
                  id: patchArtifactId,
                  tenant_id: command.payload.tenantId,
                  session_id: command.payload.sessionId,
                  turn_id: command.payload.turnId,
                  run_id: command.payload.runId,
                  kind: "patch" as const,
                  object_key: patchReference.objectKey,
                  sha256: patchReference.sha256,
                  size_bytes: patchReference.sizeBytes,
                  file_name: "workspace.diff",
                  media_type: "text/x-diff; charset=utf-8",
                },
              ]),
        ];
        await transaction.insertInto("artifacts").values(artifacts).execute();
        await transaction
          .insertInto("environment_validations")
          .values({
            id: environmentValidationId,
            tenant_id: command.payload.tenantId,
            project_id: command.payload.projectId,
            environment_version_id: command.payload.environment.environmentVersionId,
            run_id: command.payload.runId,
            attempt_id: command.payload.attemptId,
            status: "validated",
            report: environment,
            failure_code: null,
            validated_at: now,
          })
          .executeTakeFirstOrThrow();
        const environmentUpdate = await transaction
          .updateTable("environment_versions")
          .set({
            state: "validated",
            failure_code: null,
            validated_at: now,
            updated_at: now,
          })
          .where("tenant_id", "=", command.payload.tenantId)
          .where("project_id", "=", command.payload.projectId)
          .where("id", "=", command.payload.environment.environmentVersionId)
          .where("profile_key", "=", environment.profileKey)
          .where("profile_version", "=", environment.profileVersion)
          .where("image_revision", "=", environment.imageRevision)
          .where("spec_sha256", "=", environment.specSha256)
          .where("recipe_sha256", "=", environment.recipeSha256)
          .executeTakeFirst();
        if (environmentUpdate.numUpdatedRows !== 1n) {
          throw new SandboxCheckpointStoreError(
            "environment_validation_mismatch",
            "Project environment changed before validation evidence was committed",
            false,
          );
        }
        const latestVersion = await transaction
          .selectFrom("workspace_versions")
          .select(["version_number"])
          .where("tenant_id", "=", command.payload.tenantId)
          .where("workspace_id", "=", command.payload.workspaceId)
          .orderBy("version_number", "desc")
          .limit(1)
          .executeTakeFirst();
        await transaction
          .insertInto("workspace_versions")
          .values({
            id: versionId,
            tenant_id: command.payload.tenantId,
            workspace_id: command.payload.workspaceId,
            session_id: command.payload.sessionId,
            version_number: (latestVersion?.version_number ?? 0) + 1,
            parent_version_id: current.currentVersionId,
            source_version_id: null,
            origin_kind: "checkpoint",
            run_id: command.payload.runId,
            attempt_id: command.payload.attemptId,
            turn_id: command.payload.turnId,
            pi_artifact_id: piArtifactId,
            workspace_artifact_id: workspaceArtifactId,
            patch_artifact_id: patchArtifactId ?? null,
            revision,
            file_count: workspaceSnapshotFileCount(checkpoint.workspace),
            state: "staged",
            settled_at: null,
          })
          .executeTakeFirstOrThrow();
        const updated = await transaction
          .updateTable("sessions")
          .set({
            pi_session_snapshot_key: piReference.objectKey,
            workspace_snapshot_key: workspaceReference.objectKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("id", "=", command.payload.sessionId)
          .where("tenant_id", "=", command.payload.tenantId)
          .where("row_version", "=", current.rowVersion)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new SandboxCheckpointStoreError(
            "checkpoint_conflict",
            "Session changed before its checkpoint commit",
            true,
          );
        }
      });
    } catch (error: unknown) {
      await Promise.allSettled([
        this.#objectStore.delete(workspaceReference.objectKey),
        ...(patchReference === undefined
          ? []
          : [this.#objectStore.delete(patchReference.objectKey)]),
      ]);
      throw error;
    }

    return {
      revision: revisionFor(piReference.objectKey, workspaceReference.objectKey),
      workspaceRevision: workspaceReference.sha256,
    };
  }

  async #loadMetadata(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
    allowCancellation = false,
  ): Promise<CheckpointMetadata | undefined> {
    const session = await this.#assertCurrentSession(
      transaction,
      command,
      now,
      false,
      allowCancellation,
    );
    return this.#settledMetadata(transaction, command, session);
  }

  async #settledMetadata(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    session: {
      piSessionKey: string | null;
      workspaceKey: string | null;
      rowVersion: string;
      currentVersionId: string | null;
    },
  ): Promise<CheckpointMetadata | undefined> {
    let pi =
      session.piSessionKey === null
        ? undefined
        : await transaction
            .selectFrom("artifacts as artifact")
            .innerJoin("turns as terminal", (join) =>
              join
                .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
                .onRef("terminal.session_id", "=", "artifact.session_id")
                .onRef("terminal.id", "=", "artifact.turn_id"),
            )
            .leftJoin("session_terminal_events as terminal_event", (join) =>
              join
                .onRef("terminal_event.tenant_id", "=", "artifact.tenant_id")
                .onRef("terminal_event.session_id", "=", "artifact.session_id")
                .onRef("terminal_event.turn_id", "=", "artifact.turn_id")
                .on("terminal_event.type", "in", [
                  "turn.completed",
                  "turn.failed",
                  "turn.cancelled",
                ]),
            )
            .select([
              "artifact.object_key",
              "artifact.sha256",
              "artifact.size_bytes",
              "artifact.media_type",
              "terminal_event.seq as terminal_seq",
            ])
            .where("artifact.tenant_id", "=", command.payload.tenantId)
            .where("artifact.session_id", "=", command.payload.sessionId)
            .where("artifact.object_key", "=", session.piSessionKey)
            .where((expression) =>
              expression.or([
                expression.and([
                  expression("artifact.kind", "=", "pi_session_snapshot"),
                  expression("terminal_event.type", "=", "turn.completed"),
                ]),
                expression.and([
                  expression("artifact.kind", "=", "pi_interrupted_session_snapshot"),
                  expression("terminal.state", "in", ["failed", "cancelled"]),
                  expression("terminal_event.type", "in", ["turn.failed", "turn.cancelled"]),
                ]),
              ]),
            )
            .executeTakeFirst();
    if (pi === undefined) {
      pi = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("turns as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.id", "=", "artifact.turn_id"),
        )
        .leftJoin("session_terminal_events as terminal_event", (join) =>
          join
            .onRef("terminal_event.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal_event.session_id", "=", "artifact.session_id")
            .onRef("terminal_event.turn_id", "=", "artifact.turn_id")
            .on("terminal_event.type", "in", ["turn.completed", "turn.failed", "turn.cancelled"]),
        )
        .select([
          "artifact.object_key",
          "artifact.sha256",
          "artifact.size_bytes",
          "artifact.media_type",
          "terminal_event.seq as terminal_seq",
        ])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where((expression) =>
          expression.or([
            expression.and([
              expression("artifact.kind", "=", "pi_session_snapshot"),
              expression("terminal_event.type", "=", "turn.completed"),
            ]),
            expression.and([
              expression("artifact.kind", "=", "pi_interrupted_session_snapshot"),
              expression("terminal.state", "in", ["failed", "cancelled"]),
              expression("terminal_event.type", "in", ["turn.failed", "turn.cancelled"]),
            ]),
          ]),
        )
        .orderBy(
          sql<Date>`coalesce(${sql.ref("terminal.settled_at")}, ${sql.ref("terminal_event.occurred_at")})`,
          "desc",
        )
        .orderBy("artifact.created_at", "desc")
        .executeTakeFirst();
    }
    let workspace:
      { object_key: string; sha256: string; size_bytes: string | number | bigint } | undefined;
    if (session.currentVersionId !== null) {
      workspace = await transaction
        .selectFrom("workspace_versions as version")
        .innerJoin("artifacts as artifact", "artifact.id", "version.workspace_artifact_id")
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("version.tenant_id", "=", command.payload.tenantId)
        .where("version.workspace_id", "=", command.payload.workspaceId)
        .where("version.id", "=", session.currentVersionId)
        .where("version.state", "=", "settled")
        .executeTakeFirst();
      if (workspace === undefined) {
        throw new SandboxCheckpointStoreError(
          "checkpoint_metadata_invalid",
          "Current Workspace version is missing",
          false,
        );
      }
    } else if (session.workspaceKey !== null) {
      workspace = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("session_terminal_events as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.turn_id", "=", "artifact.turn_id"),
        )
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where("artifact.kind", "=", "workspace_snapshot")
        .where("artifact.object_key", "=", session.workspaceKey)
        .where("terminal.type", "=", "turn.completed")
        .executeTakeFirst();
    }
    if (session.currentVersionId === null && workspace === undefined) {
      workspace = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("session_terminal_events as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.turn_id", "=", "artifact.turn_id"),
        )
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where("artifact.kind", "=", "workspace_snapshot")
        .where("terminal.type", "=", "turn.completed")
        .orderBy("terminal.seq", "desc")
        .executeTakeFirst();
    }

    const workspaceReference =
      workspace === undefined
        ? undefined
        : {
            objectKey: workspace.object_key,
            sha256: workspace.sha256,
            sizeBytes: safeSize(
              workspace.size_bytes,
              MAX_WORKSPACE_SNAPSHOT_BYTES,
              "Workspace checkpoint",
            ),
          };
    if (pi === undefined && workspaceReference === undefined) return undefined;
    return {
      ...(pi === undefined
        ? {}
        : {
            piSession: {
              objectKey: pi.object_key,
              sha256: pi.sha256,
              sizeBytes: safeSize(
                pi.size_bytes,
                PI_SESSION_MANIFEST_MAX_BYTES,
                "Pi session checkpoint",
              ),
              ...(pi.media_type === null ? {} : { mediaType: pi.media_type }),
            },
          }),
      ...(workspaceReference === undefined ? {} : { workspace: workspaceReference }),
      piSessionThroughSequence:
        pi === undefined
          ? 0
          : safeSize(pi.terminal_seq ?? 0, Number.MAX_SAFE_INTEGER, "Pi event cursor"),
      revision: revisionFor(pi?.object_key, workspaceReference?.objectKey),
      ...(workspaceReference === undefined ? {} : { workspaceRevision: workspaceReference.sha256 }),
    };
  }

  async #preparePiSessionArtifact(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
    allowCancellation = false,
  ): Promise<PreparedPiSessionArtifact> {
    let previous: LoadedPiSessionManifestState | undefined;
    if (baseRevision !== null) {
      const metadata = await this.#database
        .transaction()
        .execute(async (transaction) =>
          this.#loadMetadata(transaction, command, validDate(this.#clock), allowCancellation),
        );
      if (metadata?.revision !== baseRevision) {
        throw new SandboxCheckpointStoreError(
          "checkpoint_conflict",
          "Settled checkpoint base revision is stale",
          false,
        );
      }
      if (metadata.piSession !== undefined) {
        previous = await this.#loadPiSessionManifest(metadata.piSession);
      }
    }

    const prepared = preparePiSessionManifest(piSession, PINNED_PI_CODING_AGENT_VERSION, previous);
    for (
      let index = 0;
      index < prepared.newSegments.length;
      index += PI_SEGMENT_UPLOAD_CONCURRENCY
    ) {
      const batch = prepared.newSegments.slice(index, index + PI_SEGMENT_UPLOAD_CONCURRENCY);
      await Promise.all(
        batch.map(async (segment) => {
          const objectKey = this.#piSegmentObjectKey(command, segment.descriptor);
          await this.#putContentAddressed(objectKey, segment.bytes);
        }),
      );
    }
    const objectKey = this.#piManifestObjectKey(command, prepared.manifestSha256);
    await this.#putContentAddressed(objectKey, prepared.manifestBytes);
    return {
      artifactId: this.#idGenerator(),
      reference: {
        objectKey,
        sha256: prepared.manifestSha256,
        sizeBytes: prepared.manifestBytes.byteLength,
        mediaType: PI_SESSION_MANIFEST_MEDIA_TYPE,
      },
      fileName: "pi-session.manifest.json",
      mediaType: PI_SESSION_MANIFEST_MEDIA_TYPE,
    };
  }

  async #loadPiSession(
    command: ExecuteTurnCommandMessage,
    reference: ArtifactReference,
  ): Promise<LoadedPiSessionState> {
    const loaded = await this.#loadPiSessionManifest(reference);
    try {
      const bytes = await restorePiSessionManifest(loaded.manifest, async (descriptor) =>
        this.#objectStore.get(this.#piSegmentObjectKey(command, descriptor)),
      );
      return { bytes, ...loaded };
    } catch (error: unknown) {
      if (!(error instanceof PiSessionManifestError)) throw error;
      throw new SandboxCheckpointStoreError(
        "checkpoint_corrupt",
        "Pi session checkpoint failed integrity validation",
        false,
      );
    }
  }

  async #loadPiSessionManifest(
    reference: ArtifactReference,
  ): Promise<LoadedPiSessionManifestState> {
    const stored = await this.#objectStore.get(reference.objectKey);
    this.#verifyObject(stored, reference, PI_SESSION_MANIFEST_MAX_BYTES, "Pi session manifest");
    if (reference.mediaType !== PI_SESSION_MANIFEST_MEDIA_TYPE) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_incompatible",
        "Pi session checkpoint format is unsupported",
        false,
      );
    }
    try {
      const manifest = decodePiSessionManifest(stored);
      if (manifest.piVersion !== PINNED_PI_CODING_AGENT_VERSION) {
        throw new PiSessionManifestError("Pi session manifest version is incompatible");
      }
      return {
        manifest,
        manifestSha256: reference.sha256,
      };
    } catch (error: unknown) {
      if (!(error instanceof PiSessionManifestError)) throw error;
      throw new SandboxCheckpointStoreError(
        "checkpoint_corrupt",
        "Pi session checkpoint failed integrity validation",
        false,
      );
    }
  }

  async #putContentAddressed(objectKey: string, bytes: Uint8Array): Promise<void> {
    validateCheckpointObjectKey(objectKey);
    try {
      await this.#objectStore.put(objectKey, bytes);
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code !== "EEXIST" && code !== "checkpoint_object_exists") throw error;
    }
    const existing = await this.#objectStore.get(objectKey);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_corrupt",
        "Content-addressed checkpoint object did not match its key",
        false,
      );
    }
  }

  #piSegmentObjectKey(
    command: ExecuteTurnCommandMessage,
    descriptor: PiSessionSegmentDescriptor,
  ): string {
    return validateCheckpointObjectKey(
      [
        "pi-sessions",
        command.payload.tenantId,
        command.payload.sessionId,
        "segments",
        descriptor.encoding === "gzip"
          ? `${descriptor.sha256}.jsonl.gz`
          : `${descriptor.sha256}.jsonl`,
      ].join("/"),
    );
  }

  #piManifestObjectKey(command: ExecuteTurnCommandMessage, digest: string): string {
    return validateCheckpointObjectKey(
      [
        "pi-sessions",
        command.payload.tenantId,
        command.payload.sessionId,
        "manifests",
        `${digest}.json`,
      ].join("/"),
    );
  }

  async #lockSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
  ) {
    return this.#assertCurrentSession(transaction, command, now, true, false);
  }

  async #assertCurrentSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
    lock: boolean,
    allowCancellation = false,
  ): Promise<{
    piSessionKey: string | null;
    workspaceKey: string | null;
    rowVersion: string;
    currentVersionId: string | null;
  }> {
    let query = transaction
      .selectFrom("sessions as session_row")
      .innerJoin("session_leases as lease", "lease.session_id", "session_row.id")
      .innerJoin("workspaces as workspace_row", (join) =>
        join
          .onRef("workspace_row.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace_row.id", "=", "session_row.workspace_id"),
      )
      .leftJoin(
        "workspace_versions as workspace_head",
        "workspace_head.id",
        "workspace_row.current_workspace_version_id",
      )
      .leftJoin(
        "artifacts as workspace_head_artifact",
        "workspace_head_artifact.id",
        "workspace_head.workspace_artifact_id",
      )
      .leftJoin(
        "workspace_versions as session_head",
        "session_head.id",
        "session_row.current_workspace_version_id",
      )
      .leftJoin(
        "artifacts as session_head_artifact",
        "session_head_artifact.id",
        "session_head.workspace_artifact_id",
      )
      .innerJoin("turns as turn_row", (join) =>
        join
          .onRef("turn_row.tenant_id", "=", "session_row.tenant_id")
          .onRef("turn_row.session_id", "=", "session_row.id"),
      )
      .innerJoin("commands as command_row", (join) =>
        join
          .onRef("command_row.tenant_id", "=", "turn_row.tenant_id")
          .onRef("command_row.session_id", "=", "turn_row.session_id")
          .onRef("command_row.turn_id", "=", "turn_row.id"),
      )
      .innerJoin("runs as run_row", (join) =>
        join
          .onRef("run_row.tenant_id", "=", "command_row.tenant_id")
          .onRef("run_row.session_id", "=", "command_row.session_id")
          .onRef("run_row.turn_id", "=", "command_row.turn_id")
          .onRef("run_row.command_id", "=", "command_row.id"),
      )
      .innerJoin("run_attempts as attempt_row", (join) =>
        join
          .onRef("attempt_row.run_id", "=", "run_row.id")
          .onRef("attempt_row.id", "=", "run_row.current_attempt_id"),
      )
      .select([
        "session_row.tenant_id as tenantId",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.pi_session_snapshot_key as piSessionKey",
        "session_row.row_version as rowVersion",
        sql<string | null>`case
          when ${sql.ref("session_row.forked_from_session_id")} is null
            then ${sql.ref("workspace_head_artifact.object_key")}
          else ${sql.ref("session_head_artifact.object_key")}
        end`.as("workspaceKey"),
        sql<string | null>`case
          when ${sql.ref("session_row.forked_from_session_id")} is null
            then ${sql.ref("workspace_row.current_workspace_version_id")}
          else ${sql.ref("session_row.current_workspace_version_id")}
        end`.as("currentVersionId"),
        "session_row.last_fencing_token as sessionFencingToken",
        "session_row.state as sessionState",
        "turn_row.state as turnState",
        "command_row.kind as commandKind",
        "command_row.state as commandState",
        "run_row.id as runId",
        "run_row.state as runState",
        "run_row.current_attempt_id as currentAttemptId",
        "attempt_row.id as attemptId",
        "attempt_row.state as attemptState",
        "attempt_row.sandbox_id as attemptSandboxId",
        "attempt_row.lease_id as attemptLeaseId",
        "attempt_row.fencing_token as attemptFencingToken",
        "lease.lease_id as leaseId",
        "lease.sandbox_id as leaseSandboxId",
        "lease.fencing_token as fencingToken",
        "lease.valid_until as validUntil",
      ])
      .where("session_row.id", "=", command.payload.sessionId)
      .where("turn_row.id", "=", command.payload.turnId)
      .where("command_row.id", "=", command.payload.commandId)
      .where("run_row.id", "=", command.payload.runId)
      .where("attempt_row.id", "=", command.payload.attemptId);
    if (lock) query = query.forUpdate(["session_row", "workspace_row"]);
    const row = await query.executeTakeFirst();
    if (
      row === undefined ||
      row.tenantId !== command.payload.tenantId ||
      row.projectId !== command.payload.projectId ||
      row.workspaceId !== command.payload.workspaceId ||
      row.leaseId !== command.payload.leaseId ||
      Number(row.fencingToken) !== command.payload.fencingToken ||
      Number(row.sessionFencingToken) !== command.payload.fencingToken ||
      (row.sessionState !== "running" &&
        !(allowCancellation && row.sessionState === "cancelling")) ||
      (row.turnState !== "running" && !(allowCancellation && row.turnState === "cancelling")) ||
      row.commandKind !== "turn.execute" ||
      row.commandState !== "acknowledged" ||
      row.runId !== command.payload.runId ||
      row.currentAttemptId !== command.payload.attemptId ||
      row.attemptId !== command.payload.attemptId ||
      row.attemptLeaseId !== command.payload.leaseId ||
      row.attemptSandboxId !== row.leaseSandboxId ||
      Number(row.attemptFencingToken) !== command.payload.fencingToken ||
      (row.runState !== "provisioning" &&
        row.runState !== "restoring" &&
        row.runState !== "running" &&
        row.runState !== "checkpointing" &&
        !(allowCancellation && row.runState === "cancel_requested")) ||
      (row.attemptState !== "provisioning" &&
        row.attemptState !== "restoring" &&
        row.attemptState !== "running" &&
        row.attemptState !== "checkpointing" &&
        !(allowCancellation && row.attemptState === "cancel_requested")) ||
      new Date(row.validUntil).valueOf() <= now.valueOf()
    ) {
      throw new SandboxCheckpointStoreError(
        "stale_checkpoint_fence",
        "Checkpoint operation does not own the current session lease",
        false,
      );
    }
    return {
      piSessionKey: row.piSessionKey,
      workspaceKey: row.workspaceKey,
      rowVersion: row.rowVersion,
      currentVersionId: row.currentVersionId,
    };
  }

  #verifyObject(
    bytes: Uint8Array,
    reference: ArtifactReference,
    maxBytes: number,
    description: string,
  ): void {
    if (
      bytes.byteLength !== reference.sizeBytes ||
      bytes.byteLength > maxBytes ||
      sha256(bytes) !== reference.sha256
    ) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_corrupt",
        `${description} checkpoint failed integrity validation`,
        false,
      );
    }
  }
}
