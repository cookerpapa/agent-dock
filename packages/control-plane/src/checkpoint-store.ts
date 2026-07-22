import type { Database } from "@agent-dock/database";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import {
  MAX_PI_SESSION_SNAPSHOT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_WORKSPACE_PATCH_BYTES,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  parseEnvironmentValidationReport,
} from "@agent-dock/protocol";
import {
  PiRpcTurnError,
  validatePiSessionSnapshot,
  validateWorkspaceSnapshot,
  type CapturedEnvironmentSandboxCheckpoint,
  type CapturedToolOutput,
  type LoadedSandboxCheckpoint,
  type SandboxCheckpointStore,
  type SavedSandboxCheckpoint,
  type SavedToolOutputArtifact,
} from "@agent-dock/sandbox-supervisor";
import { createHash, randomUUID } from "node:crypto";
import { parseWorkspaceSnapshot } from "@agent-dock/workspace-runtime";
import { lstat, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";

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
};

type CheckpointMetadata = {
  piSession: ArtifactReference;
  workspace?: ArtifactReference;
  revision: string;
  workspaceRevision?: string;
};

export class SandboxCheckpointStoreError extends PiRpcTurnError {
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

function revisionFor(piSessionKey: string, workspaceKey?: string): string {
  return createHash("sha256")
    .update("agent-dock.checkpoint-revision.v1\0")
    .update(piSessionKey)
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
    if (
      metadata.size < 1 ||
      metadata.size > Math.max(MAX_PI_SESSION_SNAPSHOT_BYTES, MAX_WORKSPACE_SNAPSHOT_BYTES)
    ) {
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
    if (metadata === undefined) return undefined;

    const [piSession, workspace] = await Promise.all([
      this.#objectStore.get(metadata.piSession.objectKey),
      metadata.workspace === undefined
        ? Promise.resolve(undefined)
        : this.#objectStore.get(metadata.workspace.objectKey),
    ]);
    this.#verifyObject(piSession, metadata.piSession, MAX_PI_SESSION_SNAPSHOT_BYTES, "Pi session");
    if (workspace !== undefined && metadata.workspace !== undefined) {
      this.#verifyObject(workspace, metadata.workspace, MAX_WORKSPACE_SNAPSHOT_BYTES, "workspace");
    }
    validatePiSessionSnapshot(piSession);
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
      piSession,
      ...(workspace === undefined ? {} : { workspace }),
      ...(metadata.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: metadata.workspaceRevision }),
    };
  }

  async saveConversation(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    piSession: Uint8Array,
  ): Promise<SavedSandboxCheckpoint> {
    validatePiSessionSnapshot(piSession);
    const artifactId = this.#idGenerator();
    const prefix = [
      "checkpoints",
      command.payload.tenantId,
      command.payload.sessionId,
      command.payload.turnId,
    ].map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
    const reference: ArtifactReference = {
      objectKey: `${prefix.join("/")}/${artifactId}-pi-${sha256(piSession)}.jsonl`,
      sha256: sha256(piSession),
      sizeBytes: piSession.byteLength,
    };
    validateCheckpointObjectKey(reference.objectKey);
    await this.#objectStore.put(reference.objectKey, piSession);
    let saved: SavedSandboxCheckpoint | undefined;
    try {
      saved = await this.#database.transaction().execute(async (transaction) => {
        const now = validDate(this.#clock);
        const current = await this.#lockSession(transaction, command, now);
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
            kind: "pi_session_snapshot",
            object_key: reference.objectKey,
            sha256: reference.sha256,
            size_bytes: reference.sizeBytes,
            file_name: "pi-session.jsonl",
            media_type: "application/x-ndjson",
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
      await this.#objectStore.delete(reference.objectKey).catch(() => undefined);
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
      environment.specSha256 !== command.payload.environment.specSha256
    ) {
      throw new SandboxCheckpointStoreError(
        "environment_validation_mismatch",
        "Tool Sandbox environment evidence did not match the accepted Run",
        false,
      );
    }
    validatePiSessionSnapshot(checkpoint.piSession);
    validateWorkspaceSnapshot(checkpoint.workspace);
    const piArtifactId = this.#idGenerator();
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
    const piReference: ArtifactReference = {
      objectKey: `${prefix.join("/")}/${piArtifactId}-pi-${sha256(checkpoint.piSession)}.jsonl`,
      sha256: sha256(checkpoint.piSession),
      sizeBytes: checkpoint.piSession.byteLength,
    };
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

    await this.#objectStore.put(piReference.objectKey, checkpoint.piSession);
    try {
      await this.#objectStore.put(workspaceReference.objectKey, checkpoint.workspace);
    } catch (error: unknown) {
      await this.#objectStore.delete(piReference.objectKey).catch(() => undefined);
      throw error;
    }
    if (patchReference !== undefined && patchBytes !== undefined) {
      try {
        await this.#objectStore.put(patchReference.objectKey, patchBytes);
      } catch (error: unknown) {
        await Promise.allSettled([
          this.#objectStore.delete(piReference.objectKey),
          this.#objectStore.delete(workspaceReference.objectKey),
        ]);
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
            file_name: "pi-session.jsonl",
            media_type: "application/x-ndjson",
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
          .set({ state: "validated", validated_at: now, updated_at: now })
          .where("tenant_id", "=", command.payload.tenantId)
          .where("project_id", "=", command.payload.projectId)
          .where("id", "=", command.payload.environment.environmentVersionId)
          .where("profile_key", "=", environment.profileKey)
          .where("profile_version", "=", environment.profileVersion)
          .where("image_revision", "=", environment.imageRevision)
          .where("spec_sha256", "=", environment.specSha256)
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
          .where("session_id", "=", command.payload.sessionId)
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
            file_count: parseWorkspaceSnapshot(checkpoint.workspace).length,
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
        this.#objectStore.delete(piReference.objectKey),
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
  ): Promise<CheckpointMetadata | undefined> {
    const session = await this.#assertCurrentSession(transaction, command, now, false);
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
            .innerJoin("session_events as terminal", (join) =>
              join
                .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
                .onRef("terminal.session_id", "=", "artifact.session_id")
                .onRef("terminal.turn_id", "=", "artifact.turn_id"),
            )
            .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
            .where("artifact.tenant_id", "=", command.payload.tenantId)
            .where("artifact.session_id", "=", command.payload.sessionId)
            .where("artifact.kind", "=", "pi_session_snapshot")
            .where("artifact.object_key", "=", session.piSessionKey)
            .where("terminal.type", "=", "turn.completed")
            .executeTakeFirst();
    if (pi === undefined) {
      pi = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("session_events as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.turn_id", "=", "artifact.turn_id"),
        )
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where("artifact.kind", "=", "pi_session_snapshot")
        .where("terminal.type", "=", "turn.completed")
        .orderBy("terminal.seq", "desc")
        .executeTakeFirst();
    }
    if (pi === undefined) return undefined;

    let workspace:
      { object_key: string; sha256: string; size_bytes: string | number | bigint } | undefined;
    if (session.currentVersionId !== null) {
      workspace = await transaction
        .selectFrom("workspace_versions as version")
        .innerJoin("artifacts as artifact", "artifact.id", "version.workspace_artifact_id")
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("version.tenant_id", "=", command.payload.tenantId)
        .where("version.session_id", "=", command.payload.sessionId)
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
        .innerJoin("session_events as terminal", (join) =>
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
        .innerJoin("session_events as terminal", (join) =>
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
    return {
      piSession: {
        objectKey: pi.object_key,
        sha256: pi.sha256,
        sizeBytes: safeSize(pi.size_bytes, MAX_PI_SESSION_SNAPSHOT_BYTES, "Pi session checkpoint"),
      },
      ...(workspaceReference === undefined ? {} : { workspace: workspaceReference }),
      revision: revisionFor(pi.object_key, workspaceReference?.objectKey),
      ...(workspaceReference === undefined ? {} : { workspaceRevision: workspaceReference.sha256 }),
    };
  }

  async #lockSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
  ) {
    return this.#assertCurrentSession(transaction, command, now, true);
  }

  async #assertCurrentSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
    lock: boolean,
  ): Promise<{
    piSessionKey: string | null;
    workspaceKey: string | null;
    rowVersion: string;
    currentVersionId: string | null;
  }> {
    let query = transaction
      .selectFrom("sessions as session_row")
      .innerJoin("session_leases as lease", "lease.session_id", "session_row.id")
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
        "session_row.workspace_snapshot_key as workspaceKey",
        "session_row.row_version as rowVersion",
        "session_row.current_workspace_version_id as currentVersionId",
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
    if (lock) query = query.forUpdate("session_row");
    const row = await query.executeTakeFirst();
    if (
      row === undefined ||
      row.tenantId !== command.payload.tenantId ||
      row.projectId !== command.payload.projectId ||
      row.workspaceId !== command.payload.workspaceId ||
      row.leaseId !== command.payload.leaseId ||
      Number(row.fencingToken) !== command.payload.fencingToken ||
      Number(row.sessionFencingToken) !== command.payload.fencingToken ||
      row.sessionState !== "running" ||
      row.turnState !== "running" ||
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
        row.runState !== "checkpointing") ||
      (row.attemptState !== "provisioning" &&
        row.attemptState !== "restoring" &&
        row.attemptState !== "running" &&
        row.attemptState !== "checkpointing") ||
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
