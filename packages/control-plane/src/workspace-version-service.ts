import type { Database } from "@agent-dock/database";
import type {
  ArchiveSessionRequest,
  WorkspaceFileListResource,
  WorkspaceOperationResource,
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
  workspaceObjectKey: string;
  workspaceSha256: string;
  workspaceSizeBytes: string;
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

function versionResource(row: VersionRow): WorkspaceVersionResource {
  if (row.settledAt === null) {
    throw new WorkspaceVersionError("artifact_corrupt", "Settled Workspace version is invalid");
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
      .where("workspace.deleted_at", "is", null)
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

  async files(
    tenantId: string,
    versionId: string,
    cursor?: string,
    pageSize = 512,
  ): Promise<WorkspaceFileListResource> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 512) {
      throw new TypeError("Workspace file page size is invalid");
    }
    const loaded = await this.#loadWorkspace(tenantId, versionId);
    let start = 0;
    if (cursor !== undefined) {
      let low = 0;
      let high = loaded.files.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const path = loaded.files[middle]?.path;
        if (path !== undefined && path <= cursor) low = middle + 1;
        else high = middle;
      }
      start = low;
    }
    const page = loaded.files.slice(start, start + pageSize);
    const truncated = start + page.length < loaded.files.length;
    const last = page.at(-1);
    return {
      versionId,
      files: page.map((file) => ({
        path: file.path,
        executable: file.executable,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      })),
      truncated,
      ...(truncated && last !== undefined ? { nextCursor: last.path } : {}),
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
          .select([
            "state",
            "workspace_id",
            "sandbox_retention_policy",
            "archived_at",
            "current_workspace_version_id",
            "conversation_parent_session_id",
          ])
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
        if (request.archived) {
          const child = await transaction
            .selectFrom("sessions")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("conversation_parent_session_id", "=", sessionId)
            .where("archived_at", "is", null)
            .executeTakeFirst();
          if (child !== undefined) {
            throw new WorkspaceVersionError(
              "conflict",
              "Delete child conversation branches before deleting their parent",
            );
          }
        }
        if (!request.archived) {
          const parent =
            session.conversation_parent_session_id === null
              ? undefined
              : await transaction
                  .selectFrom("sessions")
                  .select("archived_at")
                  .where("tenant_id", "=", tenantId)
                  .where("id", "=", session.conversation_parent_session_id)
                  .executeTakeFirst();
          if (parent === undefined && session.conversation_parent_session_id !== null) {
            throw new WorkspaceVersionError("not_found", "Parent conversation was not found");
          }
          if (parent?.archived_at !== null && parent !== undefined) {
            throw new WorkspaceVersionError(
              "conflict",
              "Parent conversation must be restored before its child branch",
            );
          }
          await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("id", "=", session.workspace_id)
            .where("deleted_at", "is", null)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const liveWorkspaceSessions = await transaction
            .selectFrom("sessions")
            .select(["id", "sandbox_retention_policy"])
            .where("tenant_id", "=", tenantId)
            .where("workspace_id", "=", session.workspace_id)
            .where("archived_at", "is", null)
            .where("id", "!=", sessionId)
            .execute();
          if (
            (session.sandbox_retention_policy === "persistent" &&
              liveWorkspaceSessions.length > 0) ||
            liveWorkspaceSessions.some(
              (existing) => existing.sandbox_retention_policy === "persistent",
            )
          ) {
            throw new WorkspaceVersionError(
              "conflict",
              "A persistent Sandbox conversation requires an otherwise unused Workspace",
            );
          }
        }
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
      .innerJoin("artifacts as workspace", "workspace.id", "version.workspace_artifact_id")
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
        "workspace.object_key as workspaceObjectKey",
        "workspace.sha256 as workspaceSha256",
        "workspace.size_bytes as workspaceSizeBytes",
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
    expectedKind: "archive" | "unarchive",
  ): Promise<WorkspaceOperationResource | undefined> {
    const row = await transaction
      .selectFrom("workspace_operations as operation")
      .select([
        "operation.id",
        "operation.kind",
        "operation.session_id",
        "operation.to_version_id",
        "operation.created_at",
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
      kind: expectedKind,
      sessionId: row.session_id,
      ...(row.to_version_id === null ? {} : { versionId: row.to_version_id }),
      replayed: true,
      createdAt: iso(row.created_at),
    };
  }

  async #loadOperation(
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    kind: "archive" | "unarchive",
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
