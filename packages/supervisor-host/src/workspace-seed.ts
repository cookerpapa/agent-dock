import {
  SandboxCheckpointStoreError,
  validateCheckpointObjectKey,
  type CheckpointObjectStore,
} from "@agent-dock/control-plane/checkpoint-runtime";
import type { Database } from "@agent-dock/database";
import { GitHubGatewayClient, GitHubGatewayError } from "@agent-dock/github-gateway";
import {
  MAX_WORKSPACE_SNAPSHOT_BYTES,
  type ExecuteTurnCommandMessage,
  type GitHubRepositorySource,
} from "@agent-dock/protocol";
import { PiRpcTurnError, validateWorkspaceSnapshot } from "@agent-dock/sandbox-supervisor";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import { createWorkspaceSnapshot } from "@agent-dock/workspace-runtime";

type GitHubWorkspaceImporter = {
  import(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array>;
};

function isWorkspaceImporterFailure(
  value: unknown,
): value is Error & { code: string; retryable: boolean } {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof value.code === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  );
}

type WorkspaceSourceRow = {
  kind: "empty" | "sample_java" | "github_public" | "github_app";
  repository: string | null;
  commitSha: string | null;
  status: "pending" | "importing" | "ready" | "failed";
  objectKey: string | null;
  workspaceObjectKey: string | null;
  sha256: string | null;
  sizeBytes: string | null;
  leaseExpiresAt: Date | string | null;
  installationId: string | null;
  repositoryId: string | null;
};

export type PostgresWorkspaceSeedResolverOptions = {
  database: Kysely<Database>;
  objectStore: CheckpointObjectStore;
  importer: GitHubWorkspaceImporter;
  privateImporter?: PrivateGitHubWorkspaceImporter;
  importLeaseMs?: number;
  maximumWaitMs?: number;
  pollIntervalMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

export interface PrivateGitHubWorkspaceImporter {
  import(
    source: { installationId: number; repositoryId: number; commitSha: string },
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export class GatewayGitHubWorkspaceImporter implements PrivateGitHubWorkspaceImporter {
  readonly #gateway: GitHubGatewayClient;
  readonly #idGenerator: () => string;

  constructor(gateway: GitHubGatewayClient, idGenerator: () => string = randomUUID) {
    this.#gateway = gateway;
    this.#idGenerator = idGenerator;
  }

  async import(
    source: { installationId: number; repositoryId: number; commitSha: string },
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) {
      throw new WorkspaceSeedError(
        "workspace_seed_cancelled",
        "Workspace import was cancelled",
        true,
      );
    }
    const requestId = this.#idGenerator();
    const response = await this.#gateway.request({
      type: "repository.snapshot",
      requestId,
      ...source,
    });
    if (
      response.type !== "repository.snapshotted" ||
      response.requestId !== requestId ||
      response.repository.repositoryId !== source.repositoryId ||
      response.repository.installationId !== source.installationId ||
      response.commitSha !== source.commitSha
    ) {
      throw new WorkspaceSeedError(
        "github_gateway_response_mismatch",
        "GitHub Gateway response did not match",
        false,
      );
    }
    return Buffer.from(response.workspaceSnapshotBase64, "base64");
  }
}

export class WorkspaceSeedError extends PiRpcTurnError {
  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(code, safeMessage, retryable);
    this.name = "WorkspaceSeedError";
  }
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeId(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new WorkspaceSeedError("workspace_seed_metadata_invalid", `${name} is invalid`, false);
  }
  return parsed;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Workspace seed clock returned an invalid date");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFailureCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 128);
  return /^[a-z][a-z0-9_]*$/.test(normalized) ? normalized : "workspace_import_failed";
}

function safeSize(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw new WorkspaceSeedError(
      "workspace_seed_metadata_invalid",
      "Workspace seed metadata is invalid",
      false,
    );
  }
  return parsed;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      new WorkspaceSeedError("workspace_seed_cancelled", "Workspace import was cancelled", true),
    );
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }, ms);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      rejectPromise(
        new WorkspaceSeedError("workspace_seed_cancelled", "Workspace import was cancelled", true),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class PostgresWorkspaceSeedResolver {
  readonly #database: Kysely<Database>;
  readonly #objectStore: CheckpointObjectStore;
  readonly #importer: GitHubWorkspaceImporter;
  readonly #privateImporter: PrivateGitHubWorkspaceImporter | undefined;
  readonly #importLeaseMs: number;
  readonly #maximumWaitMs: number;
  readonly #pollIntervalMs: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PostgresWorkspaceSeedResolverOptions) {
    this.#database = options.database;
    this.#objectStore = options.objectStore;
    this.#importer = options.importer;
    this.#privateImporter = options.privateImporter;
    this.#importLeaseMs = positiveInteger(
      options.importLeaseMs ?? 240_000,
      "importLeaseMs",
      10 * 60_000,
    );
    this.#maximumWaitMs = positiveInteger(
      options.maximumWaitMs ?? 300_000,
      "maximumWaitMs",
      15 * 60_000,
    );
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "pollIntervalMs", 10_000);
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async resolve(
    command: ExecuteTurnCommandMessage,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    const deadline = validDate(this.#clock).valueOf() + this.#maximumWaitMs;
    while (validDate(this.#clock).valueOf() < deadline) {
      const source = await this.#load(command);
      if (source.kind === "empty") return createWorkspaceSnapshot([]);
      if (source.kind === "sample_java") return undefined;
      if (source.status === "ready") return this.#loadReady(source);
      const leaseId = this.#idGenerator();
      const now = validDate(this.#clock);
      const claimed = await this.#database
        .updateTable("workspace_sources")
        .set({
          status: "importing",
          import_lease_id: leaseId,
          lease_expires_at: new Date(now.valueOf() + this.#importLeaseMs),
          failure_code: null,
          updated_at: now,
        })
        .where("tenant_id", "=", command.payload.tenantId)
        .where("workspace_id", "=", command.payload.workspaceId)
        .where("kind", "=", source.kind)
        .where((expression) =>
          expression.or([
            expression("status", "in", ["pending", "failed"]),
            expression.and([
              expression("status", "=", "importing"),
              expression("lease_expires_at", "<=", now),
            ]),
          ]),
        )
        .returning([
          "kind",
          "repository",
          "commit_sha as commitSha",
          "github_installation_id as installationId",
          "github_repository_id as repositoryId",
        ])
        .executeTakeFirst();
      if (claimed !== undefined && claimed.repository !== null && claimed.commitSha !== null) {
        if (claimed.kind === "github_public") {
          return this.#importAndPublish(
            command,
            leaseId,
            () =>
              this.#importer.import(
                {
                  kind: "github_public",
                  repository: claimed.repository!,
                  commitSha: claimed.commitSha!,
                },
                signal,
              ),
            signal,
          );
        }
        if (
          claimed.kind === "github_app" &&
          claimed.installationId !== null &&
          claimed.repositoryId !== null
        ) {
          if (this.#privateImporter === undefined) {
            throw new WorkspaceSeedError(
              "github_app_not_configured",
              "Private GitHub import is not configured",
              false,
            );
          }
          return this.#importAndPublish(
            command,
            leaseId,
            () =>
              this.#privateImporter!.import(
                {
                  installationId: safeId(claimed.installationId!, "GitHub installation ID"),
                  repositoryId: safeId(claimed.repositoryId!, "GitHub repository ID"),
                  commitSha: claimed.commitSha!,
                },
                signal,
              ),
            signal,
          );
        }
      }
      await abortableDelay(this.#pollIntervalMs, signal);
    }
    throw new WorkspaceSeedError(
      "workspace_import_wait_timeout",
      "Workspace import did not become ready in time",
      true,
    );
  }

  async #load(command: ExecuteTurnCommandMessage): Promise<WorkspaceSourceRow> {
    const row = await this.#database
      .selectFrom("workspaces as workspace")
      .innerJoin("workspace_sources as source", (join) =>
        join
          .onRef("source.tenant_id", "=", "workspace.tenant_id")
          .onRef("source.workspace_id", "=", "workspace.id"),
      )
      .select([
        "source.kind",
        "source.repository",
        "source.commit_sha as commitSha",
        "source.status",
        "source.object_key as objectKey",
        "workspace.object_snapshot_key as workspaceObjectKey",
        "source.sha256",
        "source.size_bytes as sizeBytes",
        "source.lease_expires_at as leaseExpiresAt",
        "source.github_installation_id as installationId",
        "source.github_repository_id as repositoryId",
      ])
      .where("workspace.tenant_id", "=", command.payload.tenantId)
      .where("workspace.project_id", "=", command.payload.projectId)
      .where("workspace.id", "=", command.payload.workspaceId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new WorkspaceSeedError(
        "workspace_source_unavailable",
        "Workspace source is unavailable",
        false,
      );
    }
    return row;
  }

  async #loadReady(source: WorkspaceSourceRow): Promise<Uint8Array> {
    if (
      source.objectKey === null ||
      source.workspaceObjectKey !== source.objectKey ||
      source.sha256 === null
    ) {
      throw new WorkspaceSeedError(
        "workspace_seed_metadata_invalid",
        "Workspace seed metadata is invalid",
        false,
      );
    }
    validateCheckpointObjectKey(source.objectKey);
    const expectedSize = safeSize(source.sizeBytes);
    const bytes = await this.#objectStore.get(source.objectKey);
    if (bytes.byteLength !== expectedSize || sha256(bytes) !== source.sha256) {
      throw new WorkspaceSeedError(
        "workspace_seed_integrity_failed",
        "Workspace seed did not match its metadata",
        false,
      );
    }
    validateWorkspaceSnapshot(bytes);
    return bytes;
  }

  async #importAndPublish(
    command: ExecuteTurnCommandMessage,
    leaseId: string,
    importWorkspace: () => Promise<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const bytes = await importWorkspace();
      validateWorkspaceSnapshot(bytes);
      const digest = sha256(bytes);
      const objectKey = validateCheckpointObjectKey(
        `workspace-seeds/${command.payload.tenantId}/${command.payload.workspaceId}/${digest}.json`,
      );
      try {
        await this.#objectStore.put(objectKey, bytes);
      } catch (error: unknown) {
        if (
          !(error instanceof SandboxCheckpointStoreError) ||
          error.code !== "checkpoint_object_exists"
        ) {
          throw error;
        }
        const existing = await this.#objectStore.get(objectKey);
        if (
          existing.byteLength !== bytes.byteLength ||
          !timingSafeEqual(Buffer.from(existing), Buffer.from(bytes))
        ) {
          throw new WorkspaceSeedError(
            "workspace_seed_object_conflict",
            "Workspace seed object conflicted with existing bytes",
            false,
          );
        }
      }
      await this.#database.transaction().execute(async (transaction) => {
        const owned = await transaction
          .selectFrom("workspace_sources")
          .select("import_lease_id as leaseId")
          .where("tenant_id", "=", command.payload.tenantId)
          .where("workspace_id", "=", command.payload.workspaceId)
          .where("status", "=", "importing")
          .forUpdate()
          .executeTakeFirst();
        if (owned?.leaseId !== leaseId) {
          throw new WorkspaceSeedError(
            "workspace_import_lease_lost",
            "Workspace import lease is no longer current",
            true,
          );
        }
        const now = validDate(this.#clock);
        const sourceUpdate = await transaction
          .updateTable("workspace_sources")
          .set({
            status: "ready",
            object_key: objectKey,
            sha256: digest,
            size_bytes: bytes.byteLength,
            import_lease_id: null,
            lease_expires_at: null,
            failure_code: null,
            updated_at: now,
          })
          .where("tenant_id", "=", command.payload.tenantId)
          .where("workspace_id", "=", command.payload.workspaceId)
          .where("import_lease_id", "=", leaseId)
          .executeTakeFirst();
        if (sourceUpdate.numUpdatedRows !== 1n) {
          throw new WorkspaceSeedError(
            "workspace_import_lease_lost",
            "Workspace import lease is no longer current",
            true,
          );
        }
        const workspaceUpdate = await transaction
          .updateTable("workspaces")
          .set({ object_snapshot_key: objectKey, updated_at: now })
          .where("tenant_id", "=", command.payload.tenantId)
          .where("project_id", "=", command.payload.projectId)
          .where("id", "=", command.payload.workspaceId)
          .executeTakeFirst();
        if (workspaceUpdate.numUpdatedRows !== 1n) {
          throw new WorkspaceSeedError(
            "workspace_source_unavailable",
            "Workspace source is unavailable",
            false,
          );
        }
      });
      return bytes;
    } catch (error: unknown) {
      const translated =
        error instanceof WorkspaceSeedError
          ? error
          : isWorkspaceImporterFailure(error)
            ? new WorkspaceSeedError(error.code, error.message, error.retryable)
            : error instanceof GitHubGatewayError
              ? new WorkspaceSeedError(error.code, error.message, error.retryable)
              : new WorkspaceSeedError("workspace_import_failed", "Workspace import failed", true);
      const now = validDate(this.#clock);
      await this.#database
        .updateTable("workspace_sources")
        .set({
          status: "failed",
          object_key: null,
          sha256: null,
          size_bytes: null,
          import_lease_id: null,
          lease_expires_at: null,
          failure_code: safeFailureCode(translated.code),
          updated_at: now,
        })
        .where("tenant_id", "=", command.payload.tenantId)
        .where("workspace_id", "=", command.payload.workspaceId)
        .where("status", "=", "importing")
        .where("import_lease_id", "=", leaseId)
        .executeTakeFirst()
        .catch(() => undefined);
      throw translated;
    }
  }
}
