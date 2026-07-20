import type { Database } from "@agent-dock/database";
import {
  GitHubGatewayClient,
  GitHubGatewayError,
  type GitHubInstallation,
} from "@agent-dock/github-gateway";
import type {
  CreateGitHubPullRequestRequest,
  GitHubInstallationResource,
  GitHubPullRequestDeliveryResource,
} from "@agent-dock/protocol";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { WorkspaceVersionService } from "./workspace-version-service.ts";

export type GitHubIntegrationServiceOptions = {
  database: Kysely<Database>;
  gateway?: GitHubGatewayClient;
  workspaceVersions: WorkspaceVersionService;
  idGenerator?: () => string;
  clock?: () => Date;
};

export class GitHubIntegrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "GitHubIntegrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function date(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new GitHubIntegrationError("github_state_corrupt", "Stored GitHub timestamp is invalid");
  }
  return parsed.toISOString();
}

function number(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new GitHubIntegrationError("github_state_corrupt", `${name} is invalid`);
  }
  return parsed;
}

function safeFailureCode(error: GitHubGatewayError): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "github_delivery_failed";
}

export class GitHubIntegrationService {
  readonly #database: Kysely<Database>;
  readonly #gateway: GitHubGatewayClient | undefined;
  readonly #workspaceVersions: WorkspaceVersionService;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: GitHubIntegrationServiceOptions) {
    this.#database = options.database;
    this.#gateway = options.gateway;
    this.#workspaceVersions = options.workspaceVersions;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async registerInstallation(
    tenantId: string,
    installationId: number,
  ): Promise<GitHubInstallationResource> {
    const gateway = this.#requireGateway();
    const requestId = this.#idGenerator();
    const response = await gateway.request({
      type: "installation.inspect",
      requestId,
      installationId,
    });
    if (
      response.type !== "installation.inspected" ||
      response.requestId !== requestId ||
      response.installation.installationId !== installationId
    ) {
      throw new GitHubIntegrationError(
        "github_gateway_response_mismatch",
        "GitHub Gateway response did not match",
      );
    }
    await this.#saveInstallation(tenantId, response.installation);
    return this.getInstallation(tenantId, installationId);
  }

  async getInstallation(
    tenantId: string,
    installationId: number,
  ): Promise<GitHubInstallationResource> {
    const installation = await this.#database
      .selectFrom("github_app_installations")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("installation_id", "=", String(installationId))
      .executeTakeFirst();
    if (installation === undefined) {
      throw new GitHubIntegrationError("not_found", "GitHub installation was not found");
    }
    const repositories = await this.#database
      .selectFrom("github_repositories")
      .select(["repository_id", "full_name", "private", "default_branch", "enabled"])
      .where("tenant_id", "=", tenantId)
      .where("installation_id", "=", String(installationId))
      .orderBy("full_name")
      .limit(501)
      .execute();
    if (repositories.length > 500) {
      throw new GitHubIntegrationError(
        "github_repository_limit_exceeded",
        "GitHub installation has too many repositories",
      );
    }
    return {
      installationId: number(installation.installation_id, "Installation ID"),
      accountId: number(installation.account_id, "Account ID"),
      accountLogin: installation.account_login,
      targetType: installation.target_type,
      repositorySelection: installation.repository_selection,
      status: installation.status,
      repositories: repositories.map((repository) => ({
        repositoryId: number(repository.repository_id, "Repository ID"),
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
        enabled: repository.enabled,
      })),
    };
  }

  async setRepositoryEnabled(
    tenantId: string,
    installationId: number,
    repositoryId: number,
    enabled: boolean,
  ): Promise<GitHubInstallationResource> {
    const updated = await this.#database
      .updateTable("github_repositories")
      .set({ enabled, updated_at: this.#clock() })
      .where("tenant_id", "=", tenantId)
      .where("installation_id", "=", String(installationId))
      .where("repository_id", "=", String(repositoryId))
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new GitHubIntegrationError("not_found", "GitHub repository was not found");
    }
    return this.getInstallation(tenantId, installationId);
  }

  async deliverPullRequest(
    tenantId: string,
    workspaceVersionId: string,
    idempotencyKey: string,
    request: CreateGitHubPullRequestRequest,
  ): Promise<GitHubPullRequestDeliveryResource> {
    const gateway = this.#requireGateway();
    const prepared = await this.#prepareDelivery(
      tenantId,
      workspaceVersionId,
      idempotencyKey,
      request,
    );
    if (prepared.resource.state === "completed") {
      return { ...prepared.resource, replayed: true };
    }
    const artifact = await this.#workspaceVersions.artifact(tenantId, prepared.workspaceArtifactId);
    try {
      const response = await gateway.request({
        type: "pull_request.deliver",
        requestId: this.#idGenerator(),
        deliveryId: prepared.resource.deliveryId,
        installationId: prepared.installationId,
        repositoryId: request.repositoryId,
        baseBranch: request.baseBranch,
        baseCommitSha: request.baseCommitSha,
        headBranch: request.headBranch,
        title: request.title,
        body: request.body,
        workspaceSnapshotBase64: Buffer.from(artifact.bytes).toString("base64"),
      });
      if (
        response.type !== "pull_request.delivered" ||
        response.deliveryId !== prepared.resource.deliveryId
      ) {
        throw new GitHubIntegrationError(
          "github_gateway_response_mismatch",
          "GitHub Gateway response did not match",
        );
      }
      await this.#database
        .updateTable("github_pull_request_deliveries")
        .set({
          state: "completed",
          commit_sha: response.commitSha,
          pull_request_number: response.pullRequestNumber,
          pull_request_url: response.pullRequestUrl,
          check_run_id: response.checkRunId,
          failure_code: null,
          completed_at: this.#clock(),
          updated_at: this.#clock(),
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", prepared.resource.deliveryId)
        .executeTakeFirstOrThrow();
    } catch (error: unknown) {
      const translated =
        error instanceof GitHubGatewayError
          ? new GitHubIntegrationError(safeFailureCode(error), error.message, error.retryable)
          : error instanceof GitHubIntegrationError
            ? error
            : new GitHubIntegrationError("github_delivery_failed", "GitHub delivery failed", true);
      await this.#database
        .updateTable("github_pull_request_deliveries")
        .set({ state: "failed", failure_code: translated.code, updated_at: this.#clock() })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", prepared.resource.deliveryId)
        .execute()
        .catch(() => undefined);
      throw translated;
    }
    return {
      ...(await this.#deliveryResource(tenantId, prepared.resource.deliveryId)),
      replayed: false,
    };
  }

  async #saveInstallation(tenantId: string, installation: GitHubInstallation): Promise<void> {
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("github_app_installations")
        .values({
          tenant_id: tenantId,
          installation_id: installation.installationId,
          account_id: installation.accountId,
          account_login: installation.accountLogin,
          target_type: installation.targetType,
          repository_selection: installation.repositorySelection,
          status: installation.suspended ? "suspended" : "active",
          permissions: installation.permissions,
          suspended_at: installation.suspended ? now : null,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "installation_id"]).doUpdateSet({
            account_id: installation.accountId,
            account_login: installation.accountLogin,
            target_type: installation.targetType,
            repository_selection: installation.repositorySelection,
            status: installation.suspended ? "suspended" : "active",
            permissions: installation.permissions,
            suspended_at: installation.suspended ? now : null,
            updated_at: now,
          }),
        )
        .execute();
      const known = new Set(
        installation.repositories.map((repository) => String(repository.repositoryId)),
      );
      if (known.size > 0) {
        await transaction
          .updateTable("github_repositories")
          .set({ enabled: false, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("installation_id", "=", String(installation.installationId))
          .where("repository_id", "not in", [...known])
          .execute();
      }
      for (const repository of installation.repositories) {
        await transaction
          .insertInto("github_repositories")
          .values({
            tenant_id: tenantId,
            repository_id: repository.repositoryId,
            installation_id: installation.installationId,
            full_name: repository.fullName,
            owner_login: repository.ownerLogin,
            name: repository.name,
            private: repository.private,
            default_branch: repository.defaultBranch,
            enabled: true,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "repository_id"]).doUpdateSet({
              installation_id: installation.installationId,
              full_name: repository.fullName,
              owner_login: repository.ownerLogin,
              name: repository.name,
              private: repository.private,
              default_branch: repository.defaultBranch,
              updated_at: now,
            }),
          )
          .execute();
      }
    });
  }

  async #prepareDelivery(
    tenantId: string,
    versionId: string,
    idempotencyKey: string,
    request: CreateGitHubPullRequestRequest,
  ): Promise<{
    resource: GitHubPullRequestDeliveryResource;
    installationId: number;
    workspaceArtifactId: string;
  }> {
    return this.#database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("github_pull_request_deliveries")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("idempotency_key", "=", idempotencyKey)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined) {
        if (
          existing.workspace_version_id !== versionId ||
          Number(existing.repository_id) !== request.repositoryId ||
          existing.base_branch !== request.baseBranch ||
          existing.base_commit_sha !== request.baseCommitSha ||
          existing.head_branch !== request.headBranch ||
          existing.title !== request.title ||
          existing.body !== request.body
        ) {
          throw new GitHubIntegrationError(
            "idempotency_conflict",
            "Idempotency-Key was already used for a different GitHub delivery",
          );
        }
        if (existing.state === "delivering") {
          throw new GitHubIntegrationError(
            "conflict",
            "GitHub delivery is already in progress",
            true,
          );
        }
        if (existing.state !== "completed") {
          await transaction
            .updateTable("github_pull_request_deliveries")
            .set({
              state: "delivering",
              attempts: sql<number>`${sql.ref("attempts")} + 1`,
              failure_code: null,
              updated_at: this.#clock(),
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "=", existing.id)
            .executeTakeFirstOrThrow();
        }
        const version = await this.#deliveryVersion(
          transaction,
          tenantId,
          versionId,
          request.repositoryId,
        );
        return {
          resource: await this.#deliveryResourceWith(transaction, tenantId, existing.id, true),
          installationId: version.installationId,
          workspaceArtifactId: version.workspaceArtifactId,
        };
      }
      const version = await this.#deliveryVersion(
        transaction,
        tenantId,
        versionId,
        request.repositoryId,
      );
      const id = this.#idGenerator();
      await transaction
        .insertInto("github_pull_request_deliveries")
        .values({
          id,
          tenant_id: tenantId,
          workspace_version_id: versionId,
          repository_id: request.repositoryId,
          installation_id: version.installationId,
          idempotency_key: idempotencyKey,
          state: "delivering",
          base_branch: request.baseBranch,
          base_commit_sha: request.baseCommitSha,
          head_branch: request.headBranch,
          title: request.title,
          body: request.body,
          commit_sha: null,
          pull_request_number: null,
          pull_request_url: null,
          check_run_id: null,
          attempts: 1,
          failure_code: null,
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
      return {
        resource: await this.#deliveryResourceWith(transaction, tenantId, id, false),
        installationId: version.installationId,
        workspaceArtifactId: version.workspaceArtifactId,
      };
    });
  }

  async #deliveryVersion(
    transaction: Transaction<Database>,
    tenantId: string,
    versionId: string,
    repositoryId: number,
  ): Promise<{ installationId: number; workspaceArtifactId: string }> {
    const row = await transaction
      .selectFrom("workspace_versions as version")
      .innerJoin("workspace_sources as source", (join) =>
        join
          .onRef("source.tenant_id", "=", "version.tenant_id")
          .onRef("source.workspace_id", "=", "version.workspace_id"),
      )
      .innerJoin("github_repositories as repository", (join) =>
        join
          .onRef("repository.tenant_id", "=", "source.tenant_id")
          .onRef("repository.repository_id", "=", "source.github_repository_id"),
      )
      .innerJoin("github_app_installations as installation", (join) =>
        join
          .onRef("installation.tenant_id", "=", "repository.tenant_id")
          .onRef("installation.installation_id", "=", "repository.installation_id"),
      )
      .select([
        "version.workspace_artifact_id as workspaceArtifactId",
        "repository.installation_id as installationId",
        "installation.permissions",
      ])
      .where("version.tenant_id", "=", tenantId)
      .where("version.id", "=", versionId)
      .where("version.state", "=", "settled")
      .where("source.kind", "=", "github_app")
      .where("repository.repository_id", "=", String(repositoryId))
      .where("repository.enabled", "=", true)
      .where("installation.status", "=", "active")
      .executeTakeFirst();
    if (row === undefined) {
      throw new GitHubIntegrationError(
        "not_found",
        "Workspace version or allowlisted source repository was not found",
      );
    }
    if (
      row.permissions.contents !== "write" ||
      row.permissions.pull_requests !== "write" ||
      row.permissions.checks !== "write"
    ) {
      throw new GitHubIntegrationError(
        "github_permission_denied",
        "GitHub App installation lacks contents, pull-request, or check write permission",
      );
    }
    return {
      installationId: number(row.installationId, "Installation ID"),
      workspaceArtifactId: row.workspaceArtifactId,
    };
  }

  async #deliveryResource(
    tenantId: string,
    deliveryId: string,
  ): Promise<GitHubPullRequestDeliveryResource> {
    return this.#deliveryResourceWith(this.#database, tenantId, deliveryId, false);
  }

  async #deliveryResourceWith(
    database: Kysely<Database> | Transaction<Database>,
    tenantId: string,
    deliveryId: string,
    replayed: boolean,
  ): Promise<GitHubPullRequestDeliveryResource> {
    const row = await database
      .selectFrom("github_pull_request_deliveries")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", deliveryId)
      .executeTakeFirst();
    if (row === undefined)
      throw new GitHubIntegrationError("not_found", "GitHub delivery was not found");
    return {
      deliveryId: row.id,
      workspaceVersionId: row.workspace_version_id,
      repositoryId: number(row.repository_id, "Repository ID"),
      state: row.state,
      headBranch: row.head_branch,
      ...(row.commit_sha === null ? {} : { commitSha: row.commit_sha }),
      ...(row.pull_request_number === null ? {} : { pullRequestNumber: row.pull_request_number }),
      ...(row.pull_request_url === null ? {} : { pullRequestUrl: row.pull_request_url }),
      ...(row.check_run_id === null
        ? {}
        : { checkRunId: number(row.check_run_id, "Check Run ID") }),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
      replayed,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    };
  }

  #requireGateway(): GitHubGatewayClient {
    if (this.#gateway === undefined) {
      throw new GitHubIntegrationError("github_app_not_configured", "GitHub App is not configured");
    }
    return this.#gateway;
  }
}
