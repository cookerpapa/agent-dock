import type { Database } from "@agent-dock/database";
import type {
  ArchiveSessionRequest,
  ForkSessionRequest,
  RollbackWorkspaceRequest,
  WorkspaceArtifactResource,
  WorkspaceFileListResource,
  WorkspaceOperationResource,
  WorkspaceVersionCompareResource,
  WorkspaceVersionListResource,
  WorkspaceVersionResource,
} from "@agent-dock/protocol";
import { workspaceSnapshotMetadata } from "@agent-dock/workspace-runtime";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

const MAX_VERSIONS = 100;

export interface TrustedArtifactReader {
  get(objectKey: string): Promise<Uint8Array>;
}

export interface TrustedProviderSnapshotReader {
  read(input: {
    tenantId: string;
    workspaceId: string;
    snapshot: Uint8Array;
    path: string;
  }): Promise<{ bytes: Uint8Array; sha256: string; executable: boolean }>;
}

export type WorkspaceVersionServiceOptions = {
  database: Kysely<Database>;
  artifactReader?: TrustedArtifactReader;
  providerSnapshotReader?: TrustedProviderSnapshotReader;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type WorkspaceVersionErrorCode =
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "artifact_unavailable"
  | "artifact_corrupt"
  | "tenant_quota_exceeded";

export class WorkspaceVersionError extends Error {
  readonly code: WorkspaceVersionErrorCode;

  constructor(code: WorkspaceVersionErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceVersionError";
    this.code = code;
  }
}

type VersionRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  versionNumber: number;
  parentVersionId: string | null;
  sourceVersionId: string | null;
  originKind: "checkpoint" | "fork" | "migration";
  runId: string | null;
  attemptId: string | null;
  turnId: string | null;
  revision: string;
  fileCount: number;
  createdAt: Date | string;
  settledAt: Date | string | null;
  piArtifactId: string;
  piArtifactKind: "pi_session_snapshot";
  piFileName: string | null;
  piMediaType: string | null;
  piSha256: string;
  piSizeBytes: string;
  piCreatedAt: Date | string;
  workspaceArtifactId: string;
  workspaceArtifactKind: "workspace_snapshot";
  workspaceObjectKey: string;
  workspaceFileName: string | null;
  workspaceMediaType: string | null;
  workspaceSha256: string;
  workspaceSizeBytes: string;
  workspaceCreatedAt: Date | string;
  patchArtifactId: string | null;
  patchArtifactKind: "patch" | null;
  patchFileName: string | null;
  patchMediaType: string | null;
  patchSha256: string | null;
  patchSizeBytes: string | null;
  patchCreatedAt: Date | string | null;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Workspace version clock returned an invalid Date");
  }
  return value;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new WorkspaceVersionError("artifact_corrupt", "Stored timestamp is invalid");
  }
  return parsed.toISOString();
}

function safeInteger(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkspaceVersionError("artifact_corrupt", `${description} is invalid`);
  }
  return parsed;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactResource(input: {
  id: string;
  kind: WorkspaceArtifactResource["kind"];
  fileName: string | null;
  mediaType: string | null;
  sha256: string;
  sizeBytes: string;
  createdAt: Date | string;
}): WorkspaceArtifactResource {
  return {
    artifactId: input.id,
    kind: input.kind,
    ...(input.fileName === null ? {} : { fileName: input.fileName }),
    ...(input.mediaType === null ? {} : { mediaType: input.mediaType }),
    sha256: input.sha256,
    sizeBytes: safeInteger(input.sizeBytes, "Artifact size"),
    createdAt: iso(input.createdAt),
  };
}

function versionResource(row: VersionRow): WorkspaceVersionResource {
  if (row.settledAt === null) {
    throw new WorkspaceVersionError("artifact_corrupt", "Settled Workspace version is invalid");
  }
  const artifacts: WorkspaceArtifactResource[] = [
    artifactResource({
      id: row.piArtifactId,
      kind: row.piArtifactKind,
      fileName: row.piFileName,
      mediaType: row.piMediaType,
      sha256: row.piSha256,
      sizeBytes: row.piSizeBytes,
      createdAt: row.piCreatedAt,
    }),
    artifactResource({
      id: row.workspaceArtifactId,
      kind: row.workspaceArtifactKind,
      fileName: row.workspaceFileName,
      mediaType: row.workspaceMediaType,
      sha256: row.workspaceSha256,
      sizeBytes: row.workspaceSizeBytes,
      createdAt: row.workspaceCreatedAt,
    }),
  ];
  if (
    row.patchArtifactId !== null &&
    row.patchArtifactKind === "patch" &&
    row.patchSha256 !== null &&
    row.patchSizeBytes !== null &&
    row.patchCreatedAt !== null
  ) {
    artifacts.push(
      artifactResource({
        id: row.patchArtifactId,
        kind: row.patchArtifactKind,
        fileName: row.patchFileName,
        mediaType: row.patchMediaType,
        sha256: row.patchSha256,
        sizeBytes: row.patchSizeBytes,
        createdAt: row.patchCreatedAt,
      }),
    );
  }
  return {
    versionId: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    versionNumber: row.versionNumber,
    ...(row.parentVersionId === null ? {} : { parentVersionId: row.parentVersionId }),
    ...(row.sourceVersionId === null ? {} : { sourceVersionId: row.sourceVersionId }),
    origin: row.originKind,
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
    ...(row.turnId === null ? {} : { turnId: row.turnId }),
    revision: row.revision,
    fileCount: row.fileCount,
    createdAt: iso(row.createdAt),
    settledAt: iso(row.settledAt),
    artifacts,
  };
}

export class WorkspaceVersionService {
  readonly #database: Kysely<Database>;
  readonly #artifactReader: TrustedArtifactReader | undefined;
  readonly #providerSnapshotReader: TrustedProviderSnapshotReader | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: WorkspaceVersionServiceOptions) {
    this.#database = options.database;
    this.#artifactReader = options.artifactReader;
    this.#providerSnapshotReader = options.providerSnapshotReader;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async list(tenantId: string, sessionId: string): Promise<WorkspaceVersionListResource> {
    const session = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .select([
        "session_row.workspace_id as workspaceId",
        "session_row.archived_at as archivedAt",
        "session_row.forked_from_session_id as forkedFromSessionId",
        sql<string | null>`case
          when ${sql.ref("session_row.forked_from_session_id")} is null
            then ${sql.ref("workspace.current_workspace_version_id")}
          else ${sql.ref("session_row.current_workspace_version_id")}
        end`.as("currentVersionId"),
      ])
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", sessionId)
      .executeTakeFirst();
    if (session === undefined)
      throw new WorkspaceVersionError("not_found", "Session was not found");
    let versionQuery = this.#versionQuery(tenantId).where("version.state", "=", "settled");
    versionQuery =
      session.forkedFromSessionId === null
        ? versionQuery.where("version.workspace_id", "=", session.workspaceId).where(
            sql<boolean>`exists (
                select 1
                from sessions as origin_session
                where origin_session.tenant_id = ${sql.ref("version.tenant_id")}
                  and origin_session.id = ${sql.ref("version.session_id")}
                  and origin_session.forked_from_session_id is null
              )`,
          )
        : versionQuery.where("version.session_id", "=", sessionId);
    const rows = await versionQuery
      .orderBy("version.created_at", "desc")
      .orderBy("version.id", "desc")
      .limit(MAX_VERSIONS + 1)
      .execute();
    return {
      sessionId,
      ...(session.currentVersionId === null ? {} : { currentVersionId: session.currentVersionId }),
      archived: session.archivedAt !== null,
      versions: rows.slice(0, MAX_VERSIONS).map(versionResource),
      truncated: rows.length > MAX_VERSIONS,
    };
  }

  async get(tenantId: string, versionId: string): Promise<WorkspaceVersionResource> {
    return versionResource(await this.#getVersionRow(tenantId, versionId));
  }

  async files(tenantId: string, versionId: string): Promise<WorkspaceFileListResource> {
    const loaded = await this.#loadWorkspace(tenantId, versionId);
    return {
      versionId,
      files: loaded.files.map((file) => ({
        path: file.path,
        executable: file.executable,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      })),
    };
  }

  async file(
    tenantId: string,
    versionId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; sha256: string; executable: boolean }> {
    if (path.length < 1 || path.length > 512 || path.startsWith("/") || path.includes("\\")) {
      throw new WorkspaceVersionError("not_found", "Workspace file was not found");
    }
    const loaded = await this.#loadWorkspace(tenantId, versionId);
    const file = loaded.files.find((candidate) => candidate.path === path);
    if (file === undefined)
      throw new WorkspaceVersionError("not_found", "Workspace file was not found");
    if (file.content === undefined) {
      if (this.#providerSnapshotReader === undefined) {
        throw new WorkspaceVersionError(
          "artifact_unavailable",
          "Workspace file content requires a live Provider snapshot reader",
        );
      }
      let materialized: Awaited<ReturnType<TrustedProviderSnapshotReader["read"]>>;
      try {
        materialized = await this.#providerSnapshotReader.read({
          tenantId,
          workspaceId: loaded.version.workspaceId,
          snapshot: loaded.snapshot,
          path,
        });
      } catch {
        throw new WorkspaceVersionError(
          "artifact_unavailable",
          "Workspace file content could not be materialized",
        );
      }
      if (
        materialized.bytes.byteLength !== file.sizeBytes ||
        materialized.sha256 !== file.sha256 ||
        sha256(materialized.bytes) !== file.sha256 ||
        materialized.executable !== file.executable
      ) {
        throw new WorkspaceVersionError(
          "artifact_corrupt",
          "Materialized Workspace file did not match its immutable version",
        );
      }
      return {
        bytes: materialized.bytes,
        sha256: file.sha256,
        executable: file.executable,
      };
    }
    return { bytes: file.content, sha256: file.sha256, executable: file.executable };
  }

  async compare(
    tenantId: string,
    baseVersionId: string,
    targetVersionId: string,
  ): Promise<WorkspaceVersionCompareResource> {
    const [base, target] = await Promise.all([
      this.#loadWorkspace(tenantId, baseVersionId),
      this.#loadWorkspace(tenantId, targetVersionId),
    ]);
    if (base.version.workspaceId !== target.version.workspaceId) {
      throw new WorkspaceVersionError("conflict", "Workspace versions do not share a workspace");
    }
    const baseFiles = new Map(base.files.map((file) => [file.path, file]));
    const targetFiles = new Map(target.files.map((file) => [file.path, file]));
    const paths = [...new Set([...baseFiles.keys(), ...targetFiles.keys()])].sort();
    const files: WorkspaceVersionCompareResource["files"] = [];
    let added = 0;
    let modified = 0;
    let deleted = 0;
    let modeChanged = 0;
    for (const path of paths) {
      const left = baseFiles.get(path);
      const right = targetFiles.get(path);
      if (left === undefined && right !== undefined) {
        added += 1;
        files.push({ path, change: "added", targetSha256: right.sha256 });
      } else if (left !== undefined && right === undefined) {
        deleted += 1;
        files.push({ path, change: "deleted", baseSha256: left.sha256 });
      } else if (left !== undefined && right !== undefined) {
        const leftHash = left.sha256;
        const rightHash = right.sha256;
        if (leftHash !== rightHash) {
          modified += 1;
          files.push({
            path,
            change: "modified",
            baseSha256: leftHash,
            targetSha256: rightHash,
          });
        } else if (left.executable !== right.executable) {
          modeChanged += 1;
          files.push({
            path,
            change: "mode_changed",
            baseSha256: leftHash,
            targetSha256: rightHash,
          });
        }
      }
    }
    return {
      baseVersionId,
      targetVersionId,
      summary: { added, modified, deleted, modeChanged },
      files,
    };
  }

  async artifact(
    tenantId: string,
    artifactId: string,
  ): Promise<{
    resource: WorkspaceArtifactResource;
    bytes: Uint8Array;
  }> {
    const row = await this.#database
      .selectFrom("artifacts")
      .select([
        "id",
        "kind",
        "file_name",
        "media_type",
        "object_key",
        "sha256",
        "size_bytes",
        "created_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", artifactId)
      .executeTakeFirst();
    if (row === undefined) throw new WorkspaceVersionError("not_found", "Artifact was not found");
    const bytes = await this.#readArtifact(row.object_key, row.sha256, row.size_bytes);
    return {
      resource: artifactResource({
        id: row.id,
        kind: row.kind,
        fileName: row.file_name,
        mediaType: row.media_type,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
      }),
      bytes,
    };
  }

  async fork(
    tenantId: string,
    idempotencyKey: string,
    sourceSessionId: string,
    request: ForkSessionRequest,
  ): Promise<WorkspaceOperationResource> {
    const now = validDate(this.#clock);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await this.#operationReplay(
          transaction,
          tenantId,
          sourceSessionId,
          idempotencyKey,
          "fork",
        );
        if (replay !== undefined) return replay;
        const source = await transaction
          .selectFrom("sessions")
          .select(["project_id", "workspace_id", "desired_model_profile_id"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sourceSessionId)
          .forUpdate()
          .executeTakeFirst();
        if (source === undefined)
          throw new WorkspaceVersionError("not_found", "Session was not found");
        const version = await transaction
          .selectFrom("workspace_versions as version")
          .innerJoin("artifacts as pi", "pi.id", "version.pi_artifact_id")
          .innerJoin("artifacts as workspace", "workspace.id", "version.workspace_artifact_id")
          .select([
            "version.id",
            "version.revision",
            "version.file_count",
            "version.pi_artifact_id",
            "version.workspace_artifact_id",
            "pi.object_key as piKey",
            "workspace.object_key as workspaceKey",
          ])
          .where("version.tenant_id", "=", tenantId)
          .where("version.session_id", "=", sourceSessionId)
          .where("version.id", "=", request.versionId)
          .where("version.state", "=", "settled")
          .executeTakeFirst();
        if (version === undefined)
          throw new WorkspaceVersionError("not_found", "Workspace version was not found");
        const policy = await transaction
          .selectFrom("tenant_runtime_policies")
          .select("maximum_sessions")
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const count = await transaction
          .selectFrom("sessions")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", tenantId)
          .executeTakeFirstOrThrow();
        if (safeInteger(count.count, "Session count") >= policy.maximum_sessions) {
          throw new WorkspaceVersionError(
            "tenant_quota_exceeded",
            "Tenant session quota has been reached",
          );
        }
        const sessionId = this.#idGenerator();
        const versionId = this.#idGenerator();
        const operationId = this.#idGenerator();
        await transaction
          .insertInto("sessions")
          .values({
            id: sessionId,
            tenant_id: tenantId,
            project_id: source.project_id,
            workspace_id: source.workspace_id,
            desired_model_profile_id: source.desired_model_profile_id,
            state: "cold",
            pi_session_snapshot_key: version.piKey,
            workspace_snapshot_key: version.workspaceKey,
            current_workspace_version_id: null,
            forked_from_session_id: sourceSessionId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("session_event_cursors")
          .values({ session_id: sessionId })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("workspace_versions")
          .values({
            id: versionId,
            tenant_id: tenantId,
            workspace_id: source.workspace_id,
            session_id: sessionId,
            version_number: 1,
            parent_version_id: null,
            source_version_id: version.id,
            origin_kind: "fork",
            run_id: null,
            attempt_id: null,
            turn_id: null,
            pi_artifact_id: version.pi_artifact_id,
            workspace_artifact_id: version.workspace_artifact_id,
            patch_artifact_id: null,
            revision: version.revision,
            file_count: version.file_count,
            state: "settled",
            settled_at: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("sessions")
          .set({ current_workspace_version_id: versionId, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("workspace_operations")
          .values({
            id: operationId,
            tenant_id: tenantId,
            session_id: sourceSessionId,
            kind: "fork",
            idempotency_key: idempotencyKey,
            from_version_id: version.id,
            to_version_id: versionId,
            source_session_id: sourceSessionId,
          })
          .executeTakeFirstOrThrow();
        return {
          operationId,
          kind: "fork",
          sessionId: sourceSessionId,
          versionId,
          forkedSessionId: sessionId,
          replayed: false,
          createdAt: now.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (this.#isUnique(error, "workspace_operations_session_key_unique")) {
        return this.#loadOperation(tenantId, sourceSessionId, idempotencyKey, "fork", true);
      }
      throw error;
    }
  }

  async rollback(
    tenantId: string,
    idempotencyKey: string,
    sessionId: string,
    request: RollbackWorkspaceRequest,
  ): Promise<WorkspaceOperationResource> {
    const now = validDate(this.#clock);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await this.#operationReplay(
          transaction,
          tenantId,
          sessionId,
          idempotencyKey,
          "rollback",
        );
        if (replay !== undefined) return replay;
        const session = await transaction
          .selectFrom("sessions as session_row")
          .innerJoin("workspaces as workspace", (join) =>
            join
              .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
              .onRef("workspace.id", "=", "session_row.workspace_id"),
          )
          .select([
            "session_row.state",
            "session_row.workspace_id as workspaceId",
            "session_row.current_workspace_version_id as sessionCurrentVersionId",
            "session_row.forked_from_session_id as forkedFromSessionId",
            "session_row.archived_at as archivedAt",
            "workspace.current_workspace_version_id as workspaceCurrentVersionId",
          ])
          .where("session_row.tenant_id", "=", tenantId)
          .where("session_row.id", "=", sessionId)
          .forUpdate(["session_row", "workspace"])
          .executeTakeFirst();
        if (session === undefined)
          throw new WorkspaceVersionError("not_found", "Session was not found");
        if (session.state !== "cold" && session.state !== "idle") {
          throw new WorkspaceVersionError("conflict", "Active Session cannot be rolled back");
        }
        if (session.archivedAt !== null) {
          throw new WorkspaceVersionError("conflict", "Archived Session cannot be rolled back");
        }
        const currentVersionId =
          session.forkedFromSessionId === null
            ? session.workspaceCurrentVersionId
            : session.sessionCurrentVersionId;
        if (currentVersionId !== request.expectedCurrentVersionId) {
          throw new WorkspaceVersionError("conflict", "Current Workspace version changed");
        }
        if (session.forkedFromSessionId === null) {
          const activeWorkspaceTurn = await transaction
            .selectFrom("turns as turn")
            .innerJoin("sessions as active_session", (join) =>
              join
                .onRef("active_session.tenant_id", "=", "turn.tenant_id")
                .onRef("active_session.id", "=", "turn.session_id"),
            )
            .select("turn.id")
            .where("turn.tenant_id", "=", tenantId)
            .where("active_session.workspace_id", "=", session.workspaceId)
            .where("active_session.forked_from_session_id", "is", null)
            .where("turn.state", "in", [
              "queued",
              "dispatching",
              "running",
              "waiting_approval",
              "cancelling",
            ])
            .executeTakeFirst();
          if (activeWorkspaceTurn !== undefined) {
            throw new WorkspaceVersionError(
              "conflict",
              "Workspace has unsettled work and cannot be rolled back",
            );
          }
        } else {
          await this.#assertNoUnsettledTurns(transaction, tenantId, sessionId);
        }
        let targetQuery = transaction
          .selectFrom("workspace_versions as version")
          .innerJoin("artifacts as pi", "pi.id", "version.pi_artifact_id")
          .innerJoin("artifacts as workspace", "workspace.id", "version.workspace_artifact_id")
          .select(["version.id", "pi.object_key as piKey", "workspace.object_key as workspaceKey"])
          .where("version.tenant_id", "=", tenantId)
          .where("version.id", "=", request.versionId)
          .where("version.state", "=", "settled");
        targetQuery =
          session.forkedFromSessionId === null
            ? targetQuery.where("version.workspace_id", "=", session.workspaceId).where(
                sql<boolean>`exists (
                    select 1 from sessions as origin_session
                    where origin_session.tenant_id = ${sql.ref("version.tenant_id")}
                      and origin_session.id = ${sql.ref("version.session_id")}
                      and origin_session.forked_from_session_id is null
                  )`,
              )
            : targetQuery.where("version.session_id", "=", sessionId);
        const target = await targetQuery.executeTakeFirst();
        if (target === undefined)
          throw new WorkspaceVersionError("not_found", "Workspace version was not found");
        if (session.forkedFromSessionId === null) {
          const workspaceUpdated = await transaction
            .updateTable("workspaces")
            .set({
              current_workspace_version_id: target.id,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "=", session.workspaceId)
            .where("current_workspace_version_id", "=", request.expectedCurrentVersionId)
            .executeTakeFirst();
          if (workspaceUpdated.numUpdatedRows !== 1n) {
            throw new WorkspaceVersionError("conflict", "Current Workspace version changed");
          }
          await transaction
            .updateTable("sessions")
            .set({
              current_workspace_version_id: target.id,
              workspace_snapshot_key: target.workspaceKey,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
            })
            .where("tenant_id", "=", tenantId)
            .where("workspace_id", "=", session.workspaceId)
            .where("forked_from_session_id", "is", null)
            .execute();
        } else {
          const updated = await transaction
            .updateTable("sessions")
            .set({
              current_workspace_version_id: target.id,
              pi_session_snapshot_key: target.piKey,
              workspace_snapshot_key: target.workspaceKey,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
              last_active_at: now,
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "=", sessionId)
            .where("current_workspace_version_id", "=", request.expectedCurrentVersionId)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) {
            throw new WorkspaceVersionError("conflict", "Current Workspace version changed");
          }
        }
        const operationId = this.#idGenerator();
        await transaction
          .insertInto("workspace_operations")
          .values({
            id: operationId,
            tenant_id: tenantId,
            session_id: sessionId,
            kind: "rollback",
            idempotency_key: idempotencyKey,
            from_version_id: request.expectedCurrentVersionId,
            to_version_id: target.id,
            source_session_id: null,
          })
          .executeTakeFirstOrThrow();
        return {
          operationId,
          kind: "rollback",
          sessionId,
          versionId: target.id,
          replayed: false,
          createdAt: now.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (this.#isUnique(error, "workspace_operations_session_key_unique")) {
        return this.#loadOperation(tenantId, sessionId, idempotencyKey, "rollback", true);
      }
      throw error;
    }
  }

  async archive(
    tenantId: string,
    idempotencyKey: string,
    sessionId: string,
    request: ArchiveSessionRequest,
  ): Promise<WorkspaceOperationResource> {
    const kind = request.archived ? "archive" : "unarchive";
    const now = validDate(this.#clock);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await this.#operationReplay(
          transaction,
          tenantId,
          sessionId,
          idempotencyKey,
          kind,
        );
        if (replay !== undefined) return replay;
        const session = await transaction
          .selectFrom("sessions")
          .select(["state", "archived_at", "current_workspace_version_id"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (session === undefined)
          throw new WorkspaceVersionError("not_found", "Session was not found");
        if (session.state !== "cold" && session.state !== "idle") {
          throw new WorkspaceVersionError("conflict", "Active Session cannot be archived");
        }
        if ((session.archived_at !== null) === request.archived) {
          throw new WorkspaceVersionError("conflict", "Session archive state already matches");
        }
        await this.#assertNoUnsettledTurns(transaction, tenantId, sessionId);
        await transaction
          .updateTable("sessions")
          .set({
            archived_at: request.archived ? now : null,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        const operationId = this.#idGenerator();
        await transaction
          .insertInto("workspace_operations")
          .values({
            id: operationId,
            tenant_id: tenantId,
            session_id: sessionId,
            kind,
            idempotency_key: idempotencyKey,
            from_version_id: session.current_workspace_version_id,
            to_version_id: session.current_workspace_version_id,
            source_session_id: null,
          })
          .executeTakeFirstOrThrow();
        return {
          operationId,
          kind,
          sessionId,
          ...(session.current_workspace_version_id === null
            ? {}
            : { versionId: session.current_workspace_version_id }),
          replayed: false,
          createdAt: now.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (this.#isUnique(error, "workspace_operations_session_key_unique")) {
        return this.#loadOperation(tenantId, sessionId, idempotencyKey, kind, true);
      }
      throw error;
    }
  }

  async #loadWorkspace(tenantId: string, versionId: string) {
    const version = await this.#getVersionRow(tenantId, versionId);
    const bytes = await this.#readArtifact(
      version.workspaceObjectKey,
      version.workspaceSha256,
      version.workspaceSizeBytes,
    );
    const files = workspaceSnapshotMetadata(bytes);
    if (files.length !== version.fileCount && version.originKind !== "migration") {
      throw new WorkspaceVersionError("artifact_corrupt", "Workspace file count is inconsistent");
    }
    return { version, files, snapshot: bytes };
  }

  async #readArtifact(
    objectKey: string,
    expectedSha256: string,
    expectedSize: string,
  ): Promise<Uint8Array> {
    if (this.#artifactReader === undefined) {
      throw new WorkspaceVersionError(
        "artifact_unavailable",
        "Trusted artifact reader is not configured",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.#artifactReader.get(objectKey);
    } catch {
      throw new WorkspaceVersionError("artifact_unavailable", "Artifact bytes are unavailable");
    }
    if (
      bytes.byteLength !== safeInteger(expectedSize, "Artifact size") ||
      sha256(bytes) !== expectedSha256
    ) {
      throw new WorkspaceVersionError("artifact_corrupt", "Artifact integrity validation failed");
    }
    return bytes;
  }

  #versionQuery(tenantId: string) {
    return this.#database
      .selectFrom("workspace_versions as version")
      .innerJoin("artifacts as pi", "pi.id", "version.pi_artifact_id")
      .innerJoin("artifacts as workspace", "workspace.id", "version.workspace_artifact_id")
      .leftJoin("artifacts as patch", "patch.id", "version.patch_artifact_id")
      .select([
        "version.id",
        "version.workspace_id as workspaceId",
        "version.session_id as sessionId",
        "version.version_number as versionNumber",
        "version.parent_version_id as parentVersionId",
        "version.source_version_id as sourceVersionId",
        "version.origin_kind as originKind",
        "version.run_id as runId",
        "version.attempt_id as attemptId",
        "version.turn_id as turnId",
        "version.revision",
        "version.file_count as fileCount",
        "version.created_at as createdAt",
        "version.settled_at as settledAt",
        "pi.id as piArtifactId",
        "pi.kind as piArtifactKind",
        "pi.file_name as piFileName",
        "pi.media_type as piMediaType",
        "pi.sha256 as piSha256",
        "pi.size_bytes as piSizeBytes",
        "pi.created_at as piCreatedAt",
        "workspace.id as workspaceArtifactId",
        "workspace.kind as workspaceArtifactKind",
        "workspace.object_key as workspaceObjectKey",
        "workspace.file_name as workspaceFileName",
        "workspace.media_type as workspaceMediaType",
        "workspace.sha256 as workspaceSha256",
        "workspace.size_bytes as workspaceSizeBytes",
        "workspace.created_at as workspaceCreatedAt",
        "patch.id as patchArtifactId",
        "patch.kind as patchArtifactKind",
        "patch.file_name as patchFileName",
        "patch.media_type as patchMediaType",
        "patch.sha256 as patchSha256",
        "patch.size_bytes as patchSizeBytes",
        "patch.created_at as patchCreatedAt",
      ])
      .where("version.tenant_id", "=", tenantId)
      .$castTo<VersionRow>();
  }

  async #getVersionRow(tenantId: string, versionId: string): Promise<VersionRow> {
    const row = await this.#versionQuery(tenantId)
      .where("version.id", "=", versionId)
      .where("version.state", "=", "settled")
      .executeTakeFirst();
    if (row === undefined)
      throw new WorkspaceVersionError("not_found", "Workspace version was not found");
    return row;
  }

  async #assertNoUnsettledTurns(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
  ): Promise<void> {
    const active = await transaction
      .selectFrom("turns")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("state", "in", ["queued", "dispatching", "running", "waiting_approval", "cancelling"])
      .executeTakeFirst();
    if (active !== undefined) {
      throw new WorkspaceVersionError("conflict", "Session has unsettled work");
    }
  }

  async #operationReplay(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    expectedKind: "fork" | "rollback" | "archive" | "unarchive",
  ): Promise<WorkspaceOperationResource | undefined> {
    const row = await transaction
      .selectFrom("workspace_operations as operation")
      .leftJoin("workspace_versions as target", "target.id", "operation.to_version_id")
      .select([
        "operation.id",
        "operation.kind",
        "operation.session_id",
        "operation.to_version_id",
        "operation.created_at",
        "target.session_id as targetSessionId",
      ])
      .where("operation.tenant_id", "=", tenantId)
      .where("operation.session_id", "=", sessionId)
      .where("operation.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.kind !== expectedKind) {
      throw new WorkspaceVersionError(
        "idempotency_conflict",
        "Idempotency-Key was already used for a different Workspace operation",
      );
    }
    return {
      operationId: row.id,
      kind: row.kind,
      sessionId: row.session_id,
      ...(row.to_version_id === null ? {} : { versionId: row.to_version_id }),
      ...(row.kind === "fork" && row.targetSessionId !== null
        ? { forkedSessionId: row.targetSessionId }
        : {}),
      replayed: true,
      createdAt: iso(row.created_at),
    };
  }

  async #loadOperation(
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    kind: "fork" | "rollback" | "archive" | "unarchive",
    replayed: boolean,
  ): Promise<WorkspaceOperationResource> {
    const operation = await this.#database
      .transaction()
      .execute((transaction) =>
        this.#operationReplay(transaction, tenantId, sessionId, idempotencyKey, kind),
      );
    if (operation === undefined) {
      throw new WorkspaceVersionError("conflict", "Workspace operation could not be replayed");
    }
    return { ...operation, replayed };
  }

  #isUnique(error: unknown, constraint: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === constraint
    );
  }
}
