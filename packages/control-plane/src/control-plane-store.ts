import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@agent-dock/database";
import {
  DomainModelValidationError,
  resolveTurnModel,
  type ModelProfile,
  type ModelThinkingLevel,
  type SessionState,
} from "@agent-dock/domain";
import type {
  AcceptTurnRequest,
  AcceptedTurnCancellationResource,
  AcceptedTurnResource,
  ConversationDetailResource,
  ConversationListResource,
  CreateRunRewindRequest,
  CreateProjectRequest,
  CreateTurnCancellationRequest,
  ProjectResource,
  ProjectEnvironmentResource,
  EnvironmentRuntimeSnapshot,
  RunListResource,
  RunRewindResource,
  RunResource,
  ReviewBundleResource,
  SessionResource,
  TestResultListResource,
  WorkspaceSourceResource,
  WorkspaceSourceSetSnapshot,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  canonicalEnvironmentRecipeJson,
  canonicalReviewBundleManifestJson,
  canonicalWorkspaceSourceSetJson,
  parseEnvironmentRecipe,
  parseEnvironmentValidationReport,
  parseConversationTurnTranscriptResource,
  parseReviewBundleManifest,
  parseWorkspaceSourceSetSnapshot,
  TURN_CANCELLATION_OUTBOX_TOPIC,
  TURN_COMMAND_OUTBOX_TOPIC,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { materializeConversationTurnProjections } from "./conversation-turn-projection.ts";

export type ControlPlaneStoreOptions = {
  database: Kysely<Database>;
  tenantId: string;
  defaultModelProfileId: string;
  idGenerator?: () => string;
  environmentImageRevision?: string;
};

export type ControlPlaneStoreErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "tenant_quota_exceeded"
  | "control_plane_misconfigured";

export class ControlPlaneStoreError extends Error {
  readonly code: ControlPlaneStoreErrorCode;

  constructor(code: ControlPlaneStoreErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneStoreError";
    this.code = code;
  }
}

type AcceptedTurnRow = {
  runId: string;
  commandId: string;
  mailboxPosition: string;
  turnId: string;
  sessionId: string;
  commandCreatedAt: Date | string;
  commandPayload: Record<string, unknown>;
};

type AcceptedTurnCancellationRow = {
  commandId: string;
  turnId: string;
  sessionId: string;
  commandCreatedAt: Date | string;
  commandPayload: Record<string, unknown>;
};

type AcceptedRunRewindRow = AcceptedTurnRow & {
  rewindId: string;
  sourceRunId: string;
  sourceAttemptId: string;
  replacementRunId: string;
  conversationBoundarySeq: string;
  workspaceBaseVersionId: string | null;
  piSessionBaseArtifactId: string | null;
  rewindCreatedAt: Date | string;
};

type ModelSnapshotRow = {
  profileId: string;
  provider: string;
  modelId: string;
  defaultThinkingLevel: string;
  allowedThinkingLevels: string[];
  credentialBindingId: string;
  credentialBindingVersion: string;
  profileEnabled: boolean;
  credentialStatus: string;
  credentialProvider: string;
};

type TenantRuntimePolicy = {
  defaultModelProfileId: string;
  maximumProjects: number;
  maximumSessions: number;
  maximumUnsettledTurns: number;
};

type WorkspaceSourceRow = {
  sourceKind: string;
  sourceRepository: string | null;
  sourceCommitSha: string | null;
  sourceStatus: string;
  sourceFailureCode: string | null;
  sourceInstallationId: string | null;
  sourceRepositoryId: string | null;
  sourcePrivate: boolean | null;
  sourceRepositories?: readonly WorkspaceRepositorySourceRow[];
};

type WorkspaceRepositorySourceRow = {
  sourceRoot: string;
  sourceKind: "github_public" | "github_app";
  sourceRepository: string;
  sourceCommitSha: string;
  sourceInstallationId: string | null;
  sourceRepositoryId: string | null;
  sourcePrivate: boolean | null;
};

type EnvironmentVersionRow = {
  environmentVersionId: string;
  environmentVersionNumber: number;
  environmentProfileKey: string;
  environmentProfileVersion: string;
  environmentImageRevision: string;
  environmentSpecSha256: string;
  environmentRecipe: unknown;
  environmentRecipeSha256: string;
  environmentState: "pending" | "validated" | "failed";
  environmentActive: boolean;
  environmentCreatedAt: Date | string;
  environmentValidatedAt: Date | string | null;
};

function environmentSnapshot(row: EnvironmentVersionRow): EnvironmentRuntimeSnapshot {
  const recipe = parseEnvironmentRecipe(row.environmentRecipe);
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(recipe))
    .digest("hex");
  if (
    row.environmentProfileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
    row.environmentProfileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
    row.environmentSpecSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
    row.environmentRecipeSha256 !== recipeSha256
  ) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Project environment metadata is invalid",
    );
  }
  return {
    environmentVersionId: row.environmentVersionId,
    versionNumber: row.environmentVersionNumber,
    profileKey: row.environmentProfileKey,
    profileVersion: row.environmentProfileVersion,
    imageRevision: row.environmentImageRevision,
    specSha256: row.environmentSpecSha256,
    recipe,
    recipeSha256: row.environmentRecipeSha256,
  };
}

function workspaceSourceResource(row: WorkspaceSourceRow): WorkspaceSourceResource {
  if (row.sourceKind === "empty" && row.sourceStatus === "ready") {
    return { kind: "empty", status: "ready" };
  }
  if (row.sourceKind === "sample_java" && row.sourceStatus === "ready") {
    return { kind: "sample_java", status: "ready" };
  }
  if (
    row.sourceKind === "github_public" &&
    row.sourceRepository !== null &&
    row.sourceCommitSha !== null &&
    (row.sourceStatus === "pending" ||
      row.sourceStatus === "importing" ||
      row.sourceStatus === "ready" ||
      row.sourceStatus === "failed")
  ) {
    return {
      kind: "github_public",
      repository: row.sourceRepository,
      commitSha: row.sourceCommitSha,
      status: row.sourceStatus,
      ...(row.sourceStatus === "failed" && row.sourceFailureCode !== null
        ? { failureCode: row.sourceFailureCode }
        : {}),
    };
  }
  if (
    row.sourceKind === "repository_set" &&
    (row.sourceStatus === "pending" ||
      row.sourceStatus === "importing" ||
      row.sourceStatus === "ready" ||
      row.sourceStatus === "failed") &&
    row.sourceRepositories !== undefined &&
    row.sourceRepositories.length >= 2 &&
    row.sourceRepositories.length <= 8
  ) {
    return {
      kind: "repository_set",
      repositories: row.sourceRepositories.map((repository) =>
        repository.sourceKind === "github_public"
          ? {
              root: repository.sourceRoot,
              kind: "github_public" as const,
              repository: repository.sourceRepository,
              commitSha: repository.sourceCommitSha,
            }
          : {
              root: repository.sourceRoot,
              kind: "github_app" as const,
              installationId: positiveSafeInteger(
                repository.sourceInstallationId ?? "",
                "GitHub installation ID",
              ),
              repositoryId: positiveSafeInteger(
                repository.sourceRepositoryId ?? "",
                "GitHub repository ID",
              ),
              repository: repository.sourceRepository,
              commitSha: repository.sourceCommitSha,
              private:
                repository.sourcePrivate ??
                (() => {
                  throw new ControlPlaneStoreError(
                    "control_plane_misconfigured",
                    "GitHub repository privacy metadata is invalid",
                  );
                })(),
            },
      ),
      status: row.sourceStatus,
      ...(row.sourceStatus === "failed" && row.sourceFailureCode !== null
        ? { failureCode: row.sourceFailureCode }
        : {}),
    };
  }
  if (
    row.sourceKind === "github_app" &&
    row.sourceRepository !== null &&
    row.sourceCommitSha !== null &&
    row.sourceInstallationId !== null &&
    row.sourceRepositoryId !== null &&
    row.sourcePrivate !== null &&
    (row.sourceStatus === "pending" ||
      row.sourceStatus === "importing" ||
      row.sourceStatus === "ready" ||
      row.sourceStatus === "failed")
  ) {
    return {
      kind: "github_app",
      installationId: positiveSafeInteger(row.sourceInstallationId, "GitHub installation ID"),
      repositoryId: positiveSafeInteger(row.sourceRepositoryId, "GitHub repository ID"),
      repository: row.sourceRepository,
      commitSha: row.sourceCommitSha,
      private: row.sourcePrivate,
      status: row.sourceStatus,
      ...(row.sourceStatus === "failed" && row.sourceFailureCode !== null
        ? { failureCode: row.sourceFailureCode }
        : {}),
    };
  }
  throw new ControlPlaneStoreError(
    "control_plane_misconfigured",
    "Workspace source metadata is invalid",
  );
}

function workspaceSourceSetSnapshot(row: WorkspaceSourceRow): WorkspaceSourceSetSnapshot {
  if (row.sourceKind === "empty" || row.sourceKind === "sample_java") {
    return parseWorkspaceSourceSetSnapshot({
      schemaVersion: 1,
      entries: [{ root: ".", kind: row.sourceKind }],
    });
  }
  if (row.sourceKind === "github_public" && row.sourceRepository && row.sourceCommitSha) {
    return parseWorkspaceSourceSetSnapshot({
      schemaVersion: 1,
      entries: [
        {
          root: ".",
          kind: "github_public",
          repository: row.sourceRepository,
          commitSha: row.sourceCommitSha,
        },
      ],
    });
  }
  if (
    row.sourceKind === "github_app" &&
    row.sourceRepository &&
    row.sourceCommitSha &&
    row.sourceInstallationId &&
    row.sourceRepositoryId &&
    row.sourcePrivate !== null
  ) {
    return parseWorkspaceSourceSetSnapshot({
      schemaVersion: 1,
      entries: [
        {
          root: ".",
          kind: "github_app",
          installationId: positiveSafeInteger(row.sourceInstallationId, "GitHub installation ID"),
          repositoryId: positiveSafeInteger(row.sourceRepositoryId, "GitHub repository ID"),
          repository: row.sourceRepository,
          commitSha: row.sourceCommitSha,
          private: row.sourcePrivate,
        },
      ],
    });
  }
  if (row.sourceKind === "repository_set" && row.sourceRepositories !== undefined) {
    return parseWorkspaceSourceSetSnapshot({
      schemaVersion: 1,
      entries: row.sourceRepositories.map((repository) =>
        repository.sourceKind === "github_public"
          ? {
              root: repository.sourceRoot,
              kind: "github_public" as const,
              repository: repository.sourceRepository,
              commitSha: repository.sourceCommitSha,
            }
          : {
              root: repository.sourceRoot,
              kind: "github_app" as const,
              installationId: positiveSafeInteger(
                repository.sourceInstallationId ?? "",
                "GitHub installation ID",
              ),
              repositoryId: positiveSafeInteger(
                repository.sourceRepositoryId ?? "",
                "GitHub repository ID",
              ),
              repository: repository.sourceRepository,
              commitSha: repository.sourceCommitSha,
              private:
                repository.sourcePrivate ??
                (() => {
                  throw new ControlPlaneStoreError(
                    "control_plane_misconfigured",
                    "GitHub repository privacy metadata is invalid",
                  );
                })(),
            },
      ),
    });
  }
  throw new ControlPlaneStoreError(
    "control_plane_misconfigured",
    "Workspace source-set metadata is invalid",
  );
}

async function loadWorkspaceRepositorySources(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  workspaceId: string,
): Promise<WorkspaceRepositorySourceRow[]> {
  return database
    .selectFrom("workspace_repository_sources as repository_source")
    .leftJoin("github_repositories as github_repository", (join) =>
      join
        .onRef("github_repository.tenant_id", "=", "repository_source.tenant_id")
        .onRef("github_repository.repository_id", "=", "repository_source.github_repository_id"),
    )
    .select([
      "repository_source.root_path as sourceRoot",
      "repository_source.kind as sourceKind",
      "repository_source.repository as sourceRepository",
      "repository_source.commit_sha as sourceCommitSha",
      "repository_source.github_installation_id as sourceInstallationId",
      "repository_source.github_repository_id as sourceRepositoryId",
      "github_repository.private as sourcePrivate",
    ])
    .where("repository_source.tenant_id", "=", tenantId)
    .where("repository_source.workspace_id", "=", workspaceId)
    .orderBy("repository_source.ordinal", "asc")
    .execute() as Promise<WorkspaceRepositorySourceRow[]>;
}

function isoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Database returned an invalid timestamp",
    );
  }
  return timestamp.toISOString();
}

function positiveSafeInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a positive safe integer`,
    );
  }
  return parsed;
}

function nonNegativeSafeInteger(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a non-negative safe integer`,
    );
  }
  return parsed;
}

function isPostgresConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

const DEFAULT_CANCELLATION_GRACE_PERIOD_MS = 1_000;
const MAX_CONVERSATION_SUMMARIES = 100;
const MAX_CONVERSATION_TURNS = 200;
const MAX_SESSION_RUNS = 100;
const TURN_ACCEPTING_SESSION_STATES = new Set<SessionState>([
  "cold",
  "idle",
  "running",
  "waiting_approval",
  "cancelling",
]);

function turnRequestFingerprint(request: AcceptTurnRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        inputKind: "prompt",
        prompt: request.prompt,
        thinkingLevel: request.thinkingLevel ?? null,
      }),
    )
    .digest("hex");
}

function cancellationRequestFingerprint(gracePeriodMs: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        kind: "turn.cancel",
        reason: "user_request",
        gracePeriodMs,
      }),
    )
    .digest("hex");
}

function parseRequestHash(payload: Record<string, unknown>): string {
  const requestHash = payload.requestHash;
  if (typeof requestHash !== "string" || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Stored turn command has an invalid request fingerprint",
    );
  }
  return requestHash;
}

function acceptedTurnResource(
  row: AcceptedTurnRow,
  expectedRequestHash: string,
  replayed: boolean,
): AcceptedTurnResource {
  if (parseRequestHash(row.commandPayload) !== expectedRequestHash) {
    throw new ControlPlaneStoreError(
      "idempotency_conflict",
      "Idempotency-Key was already used for a different turn request",
    );
  }
  return {
    runId: row.runId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    commandId: row.commandId,
    mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Mailbox position"),
    state: "queued",
    acceptedAt: isoTimestamp(row.commandCreatedAt),
    replayed,
  };
}

function payloadString(
  payload: Record<string, unknown>,
  property: string,
  description: string,
): string {
  const value = payload[property];
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `Stored cancellation command has an invalid ${description}`,
    );
  }
  return value;
}

function acceptedTurnCancellationResource(
  row: AcceptedTurnCancellationRow,
  expectedRequestHash: string,
  replayed: boolean,
): AcceptedTurnCancellationResource {
  if (parseRequestHash(row.commandPayload) !== expectedRequestHash) {
    throw new ControlPlaneStoreError(
      "idempotency_conflict",
      "Idempotency-Key was already used for a different cancellation request",
    );
  }
  return {
    commandId: row.commandId,
    targetCommandId: payloadString(row.commandPayload, "targetCommandId", "target command ID"),
    turnId: row.turnId,
    sessionId: row.sessionId,
    state: "pending",
    acceptedAt: isoTimestamp(row.commandCreatedAt),
    replayed,
  };
}

function runRewindResource(
  row: AcceptedRunRewindRow,
  expectedRequestHash: string,
  replayed: boolean,
): RunRewindResource {
  return {
    rewindId: row.rewindId,
    sourceRunId: row.sourceRunId,
    sourceAttemptId: row.sourceAttemptId,
    replacementRunId: row.replacementRunId,
    conversationBoundarySeq: nonNegativeSafeInteger(
      row.conversationBoundarySeq,
      "Rewind conversation boundary",
    ),
    ...(row.workspaceBaseVersionId === null
      ? {}
      : { workspaceBaseVersionId: row.workspaceBaseVersionId }),
    ...(row.piSessionBaseArtifactId === null
      ? {}
      : { piSessionBaseArtifactId: row.piSessionBaseArtifactId }),
    acceptedTurn: acceptedTurnResource(row, expectedRequestHash, replayed),
    replayed,
    createdAt: isoTimestamp(row.rewindCreatedAt),
  };
}

export class ControlPlaneStore {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #defaultModelProfileId: string;
  readonly #idGenerator: () => string;
  readonly #environmentImageRevision: string;

  constructor(options: ControlPlaneStoreOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#defaultModelProfileId = options.defaultModelProfileId;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#environmentImageRevision = options.environmentImageRevision ?? "development";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#environmentImageRevision)) {
      throw new TypeError("environmentImageRevision is invalid");
    }
  }

  async createProject(input: string | CreateProjectRequest): Promise<ProjectResource> {
    const request: CreateProjectRequest =
      typeof input === "string" ? { name: input, source: { kind: "sample_java" } } : input;
    const source = request.source ?? { kind: "sample_java" as const };
    const projectId = this.#idGenerator();
    const workspaceId = this.#idGenerator();
    const environmentVersionId = this.#idGenerator();
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const policy = await this.#lockTenantPolicy(transaction);
        const projectCount = await transaction
          .selectFrom("projects")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", this.#tenantId)
          .executeTakeFirstOrThrow();
        if (
          nonNegativeSafeInteger(projectCount.count, "Tenant project count") >=
          policy.maximumProjects
        ) {
          throw new ControlPlaneStoreError(
            "tenant_quota_exceeded",
            "Tenant project quota has been reached",
          );
        }
        const requestedRepositories =
          source.kind === "repository_set" ? source.repositories : [source];
        const appRepositories = new Map<string, { full_name: string; private: boolean }>();
        for (const requestedRepository of requestedRepositories) {
          if (requestedRepository.kind !== "github_app") continue;
          const appRepository = await transaction
            .selectFrom("github_repositories as repository")
            .innerJoin("github_app_installations as installation", (join) =>
              join
                .onRef("installation.tenant_id", "=", "repository.tenant_id")
                .onRef("installation.installation_id", "=", "repository.installation_id"),
            )
            .select(["repository.full_name", "repository.private"])
            .where("repository.tenant_id", "=", this.#tenantId)
            .where("repository.repository_id", "=", String(requestedRepository.repositoryId))
            .where("repository.installation_id", "=", String(requestedRepository.installationId))
            .where("repository.enabled", "=", true)
            .where("installation.status", "=", "active")
            .executeTakeFirst();
          if (appRepository === undefined) {
            throw new ControlPlaneStoreError(
              "not_found",
              "GitHub App repository was not found or is not allowlisted",
            );
          }
          appRepositories.set(
            `${String(requestedRepository.installationId)}:${String(requestedRepository.repositoryId)}`,
            appRepository,
          );
        }
        if (source.kind === "repository_set") {
          const resolvedRepositories = new Set<string>();
          for (const requestedRepository of source.repositories) {
            const resolvedRepository =
              requestedRepository.kind === "github_public"
                ? requestedRepository.repository
                : appRepositories.get(
                    `${String(requestedRepository.installationId)}:${String(requestedRepository.repositoryId)}`,
                  )!.full_name;
            const identity = resolvedRepository.toLowerCase();
            if (resolvedRepositories.has(identity)) {
              throw new ControlPlaneStoreError(
                "invalid_request",
                "Repository-set entries must resolve to distinct repositories",
              );
            }
            resolvedRepositories.add(identity);
          }
        }
        const project = await transaction
          .insertInto("projects")
          .values({ id: projectId, tenant_id: this.#tenantId, name: request.name })
          .returning(["id", "name", "created_at"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("workspaces")
          .values({
            id: workspaceId,
            tenant_id: this.#tenantId,
            project_id: project.id,
            object_snapshot_key: null,
          })
          .executeTakeFirstOrThrow();
        const environment = await transaction
          .insertInto("environment_versions")
          .values({
            id: environmentVersionId,
            tenant_id: this.#tenantId,
            project_id: project.id,
            version_number: 1,
            profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
            profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
            image_revision: this.#environmentImageRevision,
            spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
            recipe: sql<Record<string, unknown>>`${JSON.stringify(
              DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            )}::jsonb`,
            recipe_sha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
            state: "pending",
            active: true,
            validated_at: null,
          })
          .returning(["id", "version_number", "state", "created_at"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("workspace_sources")
          .values({
            tenant_id: this.#tenantId,
            workspace_id: workspaceId,
            kind: source.kind,
            repository:
              source.kind === "github_public"
                ? source.repository
                : source.kind === "github_app"
                  ? appRepositories.get(
                      `${String(source.installationId)}:${String(source.repositoryId)}`,
                    )!.full_name
                  : null,
            commit_sha:
              source.kind === "github_public" || source.kind === "github_app"
                ? source.commitSha
                : null,
            status: source.kind === "empty" || source.kind === "sample_java" ? "ready" : "pending",
            object_key: null,
            sha256: null,
            size_bytes: null,
            import_lease_id: null,
            lease_expires_at: null,
            failure_code: null,
            github_installation_id: source.kind === "github_app" ? source.installationId : null,
            github_repository_id: source.kind === "github_app" ? source.repositoryId : null,
          })
          .executeTakeFirstOrThrow();
        if (source.kind === "repository_set") {
          await transaction
            .insertInto("workspace_repository_sources")
            .values(
              source.repositories.map((repository, index) => {
                const appRepository =
                  repository.kind === "github_app"
                    ? appRepositories.get(
                        `${String(repository.installationId)}:${String(repository.repositoryId)}`,
                      )!
                    : undefined;
                return {
                  tenant_id: this.#tenantId,
                  workspace_id: workspaceId,
                  ordinal: index + 1,
                  root_path: repository.root,
                  kind: repository.kind,
                  repository:
                    repository.kind === "github_public"
                      ? repository.repository
                      : appRepository!.full_name,
                  commit_sha: repository.commitSha,
                  github_installation_id:
                    repository.kind === "github_app" ? repository.installationId : null,
                  github_repository_id:
                    repository.kind === "github_app" ? repository.repositoryId : null,
                };
              }),
            )
            .execute();
        }
        const sourceResource: WorkspaceSourceResource =
          source.kind === "github_public"
            ? {
                kind: "github_public",
                repository: source.repository,
                commitSha: source.commitSha,
                status: "pending",
              }
            : source.kind === "github_app"
              ? {
                  kind: "github_app",
                  installationId: source.installationId,
                  repositoryId: source.repositoryId,
                  repository: appRepositories.get(
                    `${String(source.installationId)}:${String(source.repositoryId)}`,
                  )!.full_name,
                  commitSha: source.commitSha,
                  private: appRepositories.get(
                    `${String(source.installationId)}:${String(source.repositoryId)}`,
                  )!.private,
                  status: "pending",
                }
              : source.kind === "repository_set"
                ? {
                    kind: "repository_set",
                    repositories: source.repositories.map((repository) => {
                      if (repository.kind === "github_public") return repository;
                      const appRepository = appRepositories.get(
                        `${String(repository.installationId)}:${String(repository.repositoryId)}`,
                      )!;
                      return {
                        ...repository,
                        repository: appRepository.full_name,
                        private: appRepository.private,
                      };
                    }),
                    status: "pending",
                  }
                : source.kind === "empty"
                  ? { kind: "empty", status: "ready" }
                  : { kind: "sample_java", status: "ready" };
        return {
          projectId: project.id,
          workspaceId,
          name: project.name,
          createdAt: isoTimestamp(project.created_at),
          source: sourceResource,
          environment: {
            environmentVersionId: environment.id,
            versionNumber: environment.version_number,
            profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
            profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
            imageRevision: this.#environmentImageRevision,
            specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
            recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
            state: environment.state,
            active: true,
            createdAt: isoTimestamp(environment.created_at),
          },
        };
      });
    } catch (error) {
      if (isPostgresConstraint(error, "projects_tenant_name_unique")) {
        throw new ControlPlaneStoreError("conflict", "A project with this name already exists");
      }
      throw error;
    }
  }

  async createSession(projectId: string, workspaceId: string): Promise<SessionResource> {
    const sessionId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const policy = await this.#lockTenantPolicy(transaction);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["id", "project_id"])
        .where("tenant_id", "=", this.#tenantId)
        .where("project_id", "=", projectId)
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (!workspace) {
        throw new ControlPlaneStoreError("not_found", "Project workspace was not found");
      }
      const sessionCount = await transaction
        .selectFrom("sessions")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("tenant_id", "=", this.#tenantId)
        .executeTakeFirstOrThrow();
      if (
        nonNegativeSafeInteger(sessionCount.count, "Tenant session count") >= policy.maximumSessions
      ) {
        throw new ControlPlaneStoreError(
          "tenant_quota_exceeded",
          "Tenant session quota has been reached",
        );
      }

      await this.#resolveModelSnapshot(transaction);
      const session = await transaction
        .insertInto("sessions")
        .values({
          id: sessionId,
          tenant_id: this.#tenantId,
          project_id: workspace.project_id,
          workspace_id: workspace.id,
          desired_model_profile_id: policy.defaultModelProfileId,
          state: "cold",
          pi_session_snapshot_key: null,
          workspace_snapshot_key: null,
        })
        .returning(["id", "project_id", "workspace_id", "state", "created_at"])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("session_event_cursors")
        .values({ session_id: session.id })
        .executeTakeFirstOrThrow();
      return {
        sessionId: session.id,
        projectId: session.project_id,
        workspaceId: session.workspace_id,
        state: "cold",
        modelProfileId: policy.defaultModelProfileId,
        createdAt: isoTimestamp(session.created_at),
      };
    });
  }

  async listConversations(): Promise<ConversationListResource> {
    const rows = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .leftJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "session_row.tenant_id")
          .onRef("turn.session_id", "=", "session_row.id"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.state as state",
        "session_row.created_at as createdAt",
        "session_row.updated_at as updatedAt",
        "session_row.last_active_at as lastActiveAt",
        "project.name as projectName",
      ])
      .select((expression) => expression.fn.count<string>("turn.id").as("turnCount"))
      .where("session_row.tenant_id", "=", this.#tenantId)
      .groupBy([
        "session_row.id",
        "session_row.project_id",
        "session_row.workspace_id",
        "session_row.state",
        "session_row.created_at",
        "session_row.updated_at",
        "session_row.last_active_at",
        "project.name",
      ])
      .orderBy("session_row.last_active_at", "desc")
      .orderBy("session_row.id", "desc")
      .limit(MAX_CONVERSATION_SUMMARIES + 1)
      .execute();
    return {
      conversations: rows.slice(0, MAX_CONVERSATION_SUMMARIES).map((row) => ({
        sessionId: row.sessionId,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        projectName: row.projectName,
        state: row.state,
        turnCount: nonNegativeSafeInteger(row.turnCount, "Conversation turn count"),
        createdAt: isoTimestamp(row.createdAt),
        updatedAt: isoTimestamp(row.updatedAt),
        lastActiveAt: isoTimestamp(row.lastActiveAt),
      })),
      truncated: rows.length > MAX_CONVERSATION_SUMMARIES,
    };
  }

  async getConversation(sessionId: string): Promise<ConversationDetailResource> {
    const conversation = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .innerJoin("workspace_sources as source", (join) =>
        join
          .onRef("source.tenant_id", "=", "session_row.tenant_id")
          .onRef("source.workspace_id", "=", "session_row.workspace_id"),
      )
      .leftJoin("github_repositories as github_repository", (join) =>
        join
          .onRef("github_repository.tenant_id", "=", "source.tenant_id")
          .onRef("github_repository.repository_id", "=", "source.github_repository_id"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.desired_model_profile_id as modelProfileId",
        "session_row.state as sessionState",
        "session_row.created_at as sessionCreatedAt",
        "session_row.updated_at as sessionUpdatedAt",
        "session_row.last_active_at as lastActiveAt",
        "project.name as projectName",
        "project.created_at as projectCreatedAt",
        "source.kind as sourceKind",
        "source.repository as sourceRepository",
        "source.commit_sha as sourceCommitSha",
        "source.status as sourceStatus",
        "source.failure_code as sourceFailureCode",
        "source.github_installation_id as sourceInstallationId",
        "source.github_repository_id as sourceRepositoryId",
        "github_repository.private as sourcePrivate",
        "cursor.last_persisted_seq as lastPersistedSequence",
      ])
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.id", "=", sessionId)
      .executeTakeFirst();
    if (conversation === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }

    const newestTurnRows = await this.#database
      .selectFrom("commands as command")
      .innerJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "command.tenant_id")
          .onRef("turn.id", "=", "command.turn_id"),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "command.tenant_id")
          .onRef("run.turn_id", "=", "turn.id")
          .onRef("run.command_id", "=", "command.id"),
      )
      .leftJoin("run_rewinds as source_rewind", (join) =>
        join
          .onRef("source_rewind.tenant_id", "=", "run.tenant_id")
          .onRef("source_rewind.source_run_id", "=", "run.id"),
      )
      .leftJoin("run_rewinds as replacement_rewind", (join) =>
        join
          .onRef("replacement_rewind.tenant_id", "=", "run.tenant_id")
          .onRef("replacement_rewind.replacement_run_id", "=", "run.id"),
      )
      .select([
        "run.id as runId",
        "turn.id as turnId",
        "turn.input_kind as inputKind",
        "turn.input_text as prompt",
        "turn.state as turnState",
        "command.id as commandId",
        "command.mailbox_position as mailboxPosition",
        "command.created_at as acceptedAt",
        "source_rewind.replacement_run_id as supersededByRunId",
        "replacement_rewind.source_run_id as rewoundFromRunId",
      ])
      .where("command.tenant_id", "=", this.#tenantId)
      .where("command.session_id", "=", sessionId)
      .where("command.kind", "=", "turn.execute")
      .where("command.mailbox_position", "is not", null)
      .orderBy("command.mailbox_position", "desc")
      .orderBy("command.id", "desc")
      .limit(MAX_CONVERSATION_TURNS + 1)
      .execute();
    const historyTruncated = newestTurnRows.length > MAX_CONVERSATION_TURNS;
    const includedRows = newestTurnRows.slice(0, MAX_CONVERSATION_TURNS).reverse();
    const terminalTurnIds = includedRows
      .filter(
        (row) =>
          row.turnState === "completed" ||
          row.turnState === "failed" ||
          row.turnState === "cancelled",
      )
      .map((row) => row.turnId);
    let projectionRows =
      terminalTurnIds.length === 0
        ? []
        : await this.#database
            .selectFrom("conversation_turn_projections")
            .select(["turn_id", "through_seq", "transcript"])
            .where("tenant_id", "=", this.#tenantId)
            .where("session_id", "=", sessionId)
            .where("turn_id", "in", terminalTurnIds)
            .execute();
    const projectedTurnIds = new Set(projectionRows.map((row) => row.turn_id));
    const missingTerminalTurnIds = terminalTurnIds.filter(
      (turnId) => !projectedTurnIds.has(turnId),
    );
    if (missingTerminalTurnIds.length > 0) {
      await this.#database.transaction().execute(async (transaction) => {
        await materializeConversationTurnProjections(transaction, {
          tenantId: this.#tenantId,
          sessionId,
          turnIds: missingTerminalTurnIds,
        });
      });
      projectionRows = await this.#database
        .selectFrom("conversation_turn_projections")
        .select(["turn_id", "through_seq", "transcript"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "in", terminalTurnIds)
        .execute();
    }
    const transcriptByTurnId = new Map(
      projectionRows.map((row) => {
        const transcript = parseConversationTurnTranscriptResource(row.transcript);
        if (transcript.throughSequence !== positiveSafeInteger(row.through_seq, "Projection seq")) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Conversation transcript projection watermark is inconsistent",
          );
        }
        return [row.turn_id, transcript] as const;
      }),
    );
    const turns = includedRows.map((row) => {
      if (row.inputKind !== "prompt" || row.prompt === null || row.mailboxPosition === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation contains an invalid prompt turn",
        );
      }
      return {
        runId: row.runId,
        turnId: row.turnId,
        commandId: row.commandId,
        mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Conversation mailbox position"),
        prompt: row.prompt,
        state: row.turnState,
        projection:
          row.supersededByRunId === null ? ("canonical" as const) : ("superseded" as const),
        ...(row.supersededByRunId === null ? {} : { supersededByRunId: row.supersededByRunId }),
        ...(row.rewoundFromRunId === null ? {} : { rewoundFromRunId: row.rewoundFromRunId }),
        ...(transcriptByTurnId.has(row.turnId)
          ? { transcript: transcriptByTurnId.get(row.turnId)! }
          : {}),
        acceptedAt: isoTimestamp(row.acceptedAt),
      };
    });

    let replayAfterSequence = Math.max(
      nonNegativeSafeInteger(
        conversation.lastPersistedSequence,
        "Conversation durable event cursor",
      ),
      ...projectionRows.map((row) =>
        positiveSafeInteger(row.through_seq, "Conversation projection sequence"),
      ),
    );
    const unprojectedTurnIds = includedRows
      .filter((row) => !transcriptByTurnId.has(row.turnId))
      .map((row) => row.turnId);
    if (unprojectedTurnIds.length > 0) {
      const earliestIncludedEvent = await this.#database
        .selectFrom("session_events")
        .select((expression) => expression.fn.min<string>("seq").as("sequence"))
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "in", unprojectedTurnIds)
        .executeTakeFirstOrThrow();
      replayAfterSequence =
        earliestIncludedEvent.sequence === null
          ? replayAfterSequence
          : Math.max(
              0,
              positiveSafeInteger(
                earliestIncludedEvent.sequence,
                "Conversation first included event sequence",
              ) - 1,
            );
    }

    const environment = await this.#loadActiveProjectEnvironment(conversation.projectId);
    const conversationSource: WorkspaceSourceRow = {
      ...conversation,
      ...(conversation.sourceKind === "repository_set"
        ? {
            sourceRepositories: await loadWorkspaceRepositorySources(
              this.#database,
              this.#tenantId,
              conversation.workspaceId,
            ),
          }
        : {}),
    };
    return {
      project: {
        projectId: conversation.projectId,
        workspaceId: conversation.workspaceId,
        name: conversation.projectName,
        createdAt: isoTimestamp(conversation.projectCreatedAt),
        source: workspaceSourceResource(conversationSource),
        environment,
      },
      session: {
        sessionId: conversation.sessionId,
        projectId: conversation.projectId,
        workspaceId: conversation.workspaceId,
        state: conversation.sessionState,
        modelProfileId: conversation.modelProfileId,
        createdAt: isoTimestamp(conversation.sessionCreatedAt),
        updatedAt: isoTimestamp(conversation.sessionUpdatedAt),
        lastActiveAt: isoTimestamp(conversation.lastActiveAt),
      },
      turns,
      historyTruncated,
      replayAfterSequence,
    };
  }

  async listRuns(sessionId: string): Promise<RunListResource> {
    const session = await this.#database
      .selectFrom("sessions")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (session === undefined) {
      throw new ControlPlaneStoreError("not_found", "Session was not found");
    }
    const rows = await this.#database
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(MAX_SESSION_RUNS + 1)
      .execute();
    return {
      runs: await Promise.all(
        rows.slice(0, MAX_SESSION_RUNS).map((row) => this.#loadRunResource(row.id)),
      ),
      truncated: rows.length > MAX_SESSION_RUNS,
    };
  }

  async getRun(runId: string): Promise<RunResource> {
    return this.#loadRunResource(runId);
  }

  async listTestResults(runId: string): Promise<TestResultListResource> {
    const run = await this.#database
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", runId)
      .executeTakeFirst();
    if (run === undefined) throw new ControlPlaneStoreError("not_found", "Run was not found");
    const rows = await this.#database
      .selectFrom("test_results")
      .selectAll()
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", runId)
      .orderBy("created_at")
      .limit(100)
      .execute();
    return {
      runId,
      results: rows.map((row) => ({
        testResultId: row.id,
        runId: row.run_id,
        ...(row.workspace_version_id === null
          ? {}
          : { workspaceVersionId: row.workspace_version_id }),
        toolCallId: row.tool_call_id,
        command: row.command,
        suite: row.suite,
        status: row.status,
        ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        ...(row.summary === null ? {} : { summary: row.summary }),
        ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
        createdAt: isoTimestamp(row.created_at),
      })),
    };
  }

  async getReviewBundle(runId: string): Promise<ReviewBundleResource> {
    const row = await this.#database
      .selectFrom("review_bundles")
      .select(["id", "manifest", "manifest_sha256", "created_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (row === undefined) {
      const run = await this.#database
        .selectFrom("runs")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", runId)
        .executeTakeFirst();
      throw new ControlPlaneStoreError(
        "not_found",
        run === undefined ? "Run was not found" : "Run Review Bundle is not available",
      );
    }
    const manifest = parseReviewBundleManifest(row.manifest);
    const digest = createHash("sha256")
      .update(canonicalReviewBundleManifestJson(manifest), "utf8")
      .digest("hex");
    if (digest !== row.manifest_sha256) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Run Review Bundle failed its integrity check",
      );
    }
    return {
      reviewBundleId: row.id,
      manifestSha256: row.manifest_sha256,
      manifest,
      createdAt: isoTimestamp(row.created_at),
    };
  }

  async acceptTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
  ): Promise<AcceptedTurnResource> {
    const fingerprint = turnRequestFingerprint(request);
    const existing = await this.#findAcceptedTurn(sessionId, idempotencyKey);
    if (existing) {
      return acceptedTurnResource(existing, fingerprint, true);
    }

    try {
      return await this.#acceptNewTurn(sessionId, idempotencyKey, request, fingerprint);
    } catch (error) {
      if (!isPostgresConstraint(error, "commands_session_idempotency_unique")) {
        throw error;
      }
      const concurrentWinner = await this.#findAcceptedTurn(sessionId, idempotencyKey);
      if (!concurrentWinner) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Idempotent command exists without its accepted turn",
        );
      }
      return acceptedTurnResource(concurrentWinner, fingerprint, true);
    }
  }

  async acceptRunRewind(
    runId: string,
    idempotencyKey: string,
    request: CreateRunRewindRequest,
    actorUserId: string,
  ): Promise<RunRewindResource> {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          kind: "run.rewind",
          sourceRunId: runId,
          sourceAttemptId: request.sourceAttemptId,
        }),
      )
      .digest("hex");
    const existing = await this.#findAcceptedRunRewind(idempotencyKey);
    if (existing !== undefined) {
      if (existing.sourceRunId !== runId || existing.sourceAttemptId !== request.sourceAttemptId) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different Run rewind",
        );
      }
      return runRewindResource(existing, requestHash, true);
    }

    const rewindId = this.#idGenerator();
    const turnId = this.#idGenerator();
    const commandId = this.#idGenerator();
    const replacementRunId = this.#idGenerator();
    const outboxId = this.#idGenerator();
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const policy = await this.#lockTenantPolicy(transaction);
        const source = await transaction
          .selectFrom("runs as run")
          .innerJoin("turns as turn", (join) =>
            join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
          )
          .innerJoin("commands as command", (join) =>
            join
              .onRef("command.tenant_id", "=", "run.tenant_id")
              .onRef("command.id", "=", "run.command_id"),
          )
          .select([
            "run.id as runId",
            "run.project_id as projectId",
            "run.workspace_id as workspaceId",
            "run.session_id as sessionId",
            "run.state as runState",
            "run.current_attempt_id as currentAttemptId",
            "run.environment_version_id as environmentVersionId",
            "run.source_set_snapshot as sourceSetSnapshot",
            "run.conversation_base_seq as conversationBaseSeq",
            "run.workspace_base_version_id as workspaceBaseVersionId",
            "run.pi_session_base_artifact_id as piSessionBaseArtifactId",
            "turn.input_text as prompt",
            "turn.model_profile_id as modelProfileId",
            "turn.provider",
            "turn.model_id as modelId",
            "turn.thinking_level as thinkingLevel",
            "turn.credential_binding_id as credentialBindingId",
            "turn.credential_binding_version as credentialBindingVersion",
            "command.mailbox_position as mailboxPosition",
          ])
          .where("run.tenant_id", "=", this.#tenantId)
          .where("run.id", "=", runId)
          .forUpdate(["run", "turn", "command"])
          .executeTakeFirst();
        if (source === undefined)
          throw new ControlPlaneStoreError("not_found", "Run was not found");
        if (
          source.prompt === null ||
          source.mailboxPosition === null ||
          source.currentAttemptId === null
        ) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Source Run is missing immutable execution metadata",
          );
        }
        if (source.currentAttemptId !== request.sourceAttemptId) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Only the source Run's current Attempt can be rewound",
          );
        }
        if (
          source.runState !== "completed" &&
          source.runState !== "failed" &&
          source.runState !== "cancelled" &&
          source.runState !== "timed_out"
        ) {
          throw new ControlPlaneStoreError("conflict", "Only a terminal Run can be rewound");
        }
        const priorRewind = await transaction
          .selectFrom("run_rewinds")
          .select("id")
          .where("tenant_id", "=", this.#tenantId)
          .where("source_run_id", "=", source.runId)
          .executeTakeFirst();
        if (priorRewind !== undefined) {
          throw new ControlPlaneStoreError("conflict", "Run has already been rewound");
        }
        const session = await transaction
          .selectFrom("sessions")
          .select([
            "id",
            "state",
            "next_mailbox_position",
            "archived_at",
            "current_workspace_version_id",
          ])
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", source.sessionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (session.archived_at !== null) {
          throw new ControlPlaneStoreError("conflict", "Archived Session cannot be rewound");
        }
        if (session.state !== "cold" && session.state !== "idle" && session.state !== "failed") {
          throw new ControlPlaneStoreError(
            "conflict",
            "Session must be idle before its latest Run can be rewound",
          );
        }
        const nextMailboxPosition = positiveSafeInteger(
          session.next_mailbox_position,
          "Next mailbox position",
        );
        if (
          positiveSafeInteger(source.mailboxPosition, "Source mailbox position") !==
          nextMailboxPosition - 1
        ) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Only the latest Run in a Session can be rewound",
          );
        }
        const unsettled = await transaction
          .selectFrom("turns")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", this.#tenantId)
          .where("state", "in", [
            "queued",
            "dispatching",
            "running",
            "waiting_approval",
            "cancelling",
          ])
          .executeTakeFirstOrThrow();
        if (
          nonNegativeSafeInteger(unsettled.count, "Tenant unsettled-turn count") >=
          policy.maximumUnsettledTurns
        ) {
          throw new ControlPlaneStoreError(
            "tenant_quota_exceeded",
            "Tenant unsettled-turn quota has been reached",
          );
        }

        const baseVersion =
          source.workspaceBaseVersionId === null
            ? undefined
            : await transaction
                .selectFrom("workspace_versions as version")
                .innerJoin("artifacts as workspace_artifact", (join) =>
                  join
                    .onRef("workspace_artifact.tenant_id", "=", "version.tenant_id")
                    .onRef("workspace_artifact.id", "=", "version.workspace_artifact_id"),
                )
                .select(["version.id", "workspace_artifact.object_key as workspaceObjectKey"])
                .where("version.tenant_id", "=", this.#tenantId)
                .where("version.id", "=", source.workspaceBaseVersionId)
                .where("version.session_id", "=", source.sessionId)
                .where("version.state", "=", "settled")
                .executeTakeFirst();
        if (source.workspaceBaseVersionId !== null && baseVersion === undefined) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Rewind Workspace base is missing or unsettled",
          );
        }
        const piArtifact =
          source.piSessionBaseArtifactId === null
            ? undefined
            : await transaction
                .selectFrom("artifacts")
                .select(["id", "object_key"])
                .where("tenant_id", "=", this.#tenantId)
                .where("id", "=", source.piSessionBaseArtifactId)
                .where("session_id", "=", source.sessionId)
                .where("kind", "=", "pi_session_snapshot")
                .executeTakeFirst();
        if (source.piSessionBaseArtifactId !== null && piArtifact === undefined) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Rewind Pi Session base Artifact is missing",
          );
        }

        await transaction
          .insertInto("turns")
          .values({
            id: turnId,
            tenant_id: this.#tenantId,
            session_id: source.sessionId,
            state: "queued",
            input_kind: "prompt",
            input_text: source.prompt,
            model_profile_id: source.modelProfileId,
            provider: source.provider,
            model_id: source.modelId,
            thinking_level: source.thinkingLevel,
            credential_binding_id: source.credentialBindingId,
            credential_binding_version: source.credentialBindingVersion,
            stop_reason: null,
            failure_code: null,
            failure_message: null,
            failure_retryable: null,
          })
          .executeTakeFirstOrThrow();
        const command = await transaction
          .insertInto("commands")
          .values({
            id: commandId,
            tenant_id: this.#tenantId,
            session_id: source.sessionId,
            turn_id: turnId,
            idempotency_key: idempotencyKey,
            kind: "turn.execute",
            state: "pending",
            mailbox_position: nextMailboxPosition,
            payload: {
              schemaVersion: 1,
              requestHash,
              rewindId,
              sourceRunId: source.runId,
              sourceAttemptId: request.sourceAttemptId,
            },
            dispatched_at: null,
            acknowledged_at: null,
            completed_at: null,
            failure_code: null,
          })
          .returning(["id", "created_at", "payload"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("runs")
          .values({
            id: replacementRunId,
            trace_id: createHash("sha256")
              .update("agent-dock.run-trace.v1\0", "utf8")
              .update(replacementRunId, "utf8")
              .digest("hex")
              .slice(0, 32),
            tenant_id: this.#tenantId,
            project_id: source.projectId,
            workspace_id: source.workspaceId,
            session_id: source.sessionId,
            turn_id: turnId,
            command_id: command.id,
            environment_version_id: source.environmentVersionId,
            source_set_snapshot: source.sourceSetSnapshot,
            conversation_base_seq: source.conversationBaseSeq,
            workspace_base_version_id: source.workspaceBaseVersionId,
            pi_session_base_artifact_id: source.piSessionBaseArtifactId,
            idempotency_key: idempotencyKey,
            state: "queued",
            current_attempt_id: null,
            attempt_count: 0,
            stop_reason: null,
            failure_code: null,
            failure_message: null,
            failure_retryable: null,
            started_at: null,
            settled_at: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("run_rewinds")
          .values({
            id: rewindId,
            tenant_id: this.#tenantId,
            session_id: source.sessionId,
            source_run_id: source.runId,
            source_attempt_id: request.sourceAttemptId,
            replacement_run_id: replacementRunId,
            conversation_boundary_seq: source.conversationBaseSeq,
            workspace_base_version_id: source.workspaceBaseVersionId,
            pi_session_base_artifact_id: source.piSessionBaseArtifactId,
            actor_user_id: actorUserId,
            idempotency_key: idempotencyKey,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("outbox")
          .values({
            id: outboxId,
            tenant_id: this.#tenantId,
            aggregate_type: "session",
            aggregate_id: source.sessionId,
            topic: TURN_COMMAND_OUTBOX_TOPIC,
            payload: {
              schemaVersion: 1,
              commandId: command.id,
              sessionId: source.sessionId,
              turnId,
              kind: "turn.execute",
            },
            published_at: null,
            last_error: null,
          })
          .executeTakeFirstOrThrow();
        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: session.state === "failed" ? "cold" : session.state,
            current_workspace_version_id: source.workspaceBaseVersionId,
            workspace_snapshot_key: baseVersion?.workspaceObjectKey ?? null,
            pi_session_snapshot_key: piArtifact?.object_key ?? null,
            next_mailbox_position: sql<string>`${sql.ref("next_mailbox_position")} + 1`,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: sql<Date>`now()`,
            last_active_at: sql<Date>`now()`,
          })
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", source.sessionId)
          .where("next_mailbox_position", "=", String(nextMailboxPosition))
          .executeTakeFirst();
        if (sessionUpdate.numUpdatedRows !== 1n) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Session rewind could not atomically restore its base",
          );
        }
        return runRewindResource(
          {
            rewindId,
            sourceRunId: source.runId,
            sourceAttemptId: request.sourceAttemptId,
            replacementRunId,
            conversationBoundarySeq: source.conversationBaseSeq,
            workspaceBaseVersionId: source.workspaceBaseVersionId,
            piSessionBaseArtifactId: source.piSessionBaseArtifactId,
            runId: replacementRunId,
            commandId: command.id,
            mailboxPosition: String(nextMailboxPosition),
            turnId,
            sessionId: source.sessionId,
            commandCreatedAt: command.created_at,
            commandPayload: command.payload,
            rewindCreatedAt: command.created_at,
          },
          requestHash,
          false,
        );
      });
    } catch (error: unknown) {
      if (
        !isPostgresConstraint(error, "commands_session_idempotency_unique") &&
        !isPostgresConstraint(error, "run_rewinds_session_key_unique")
      ) {
        throw error;
      }
      const concurrentWinner = await this.#findAcceptedRunRewind(idempotencyKey);
      if (
        concurrentWinner === undefined ||
        concurrentWinner.sourceRunId !== runId ||
        concurrentWinner.sourceAttemptId !== request.sourceAttemptId
      ) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different command",
        );
      }
      return runRewindResource(concurrentWinner, requestHash, true);
    }
  }

  async #findAcceptedRunRewind(idempotencyKey: string): Promise<AcceptedRunRewindRow | undefined> {
    return this.#database
      .selectFrom("run_rewinds as rewind")
      .innerJoin("runs as replacement", (join) =>
        join
          .onRef("replacement.tenant_id", "=", "rewind.tenant_id")
          .onRef("replacement.id", "=", "rewind.replacement_run_id"),
      )
      .innerJoin("commands as command", (join) =>
        join
          .onRef("command.tenant_id", "=", "replacement.tenant_id")
          .onRef("command.id", "=", "replacement.command_id"),
      )
      .select([
        "rewind.id as rewindId",
        "rewind.source_run_id as sourceRunId",
        "rewind.source_attempt_id as sourceAttemptId",
        "rewind.replacement_run_id as replacementRunId",
        "rewind.conversation_boundary_seq as conversationBoundarySeq",
        "rewind.workspace_base_version_id as workspaceBaseVersionId",
        "rewind.pi_session_base_artifact_id as piSessionBaseArtifactId",
        "rewind.created_at as rewindCreatedAt",
        "replacement.id as runId",
        "replacement.turn_id as turnId",
        "replacement.session_id as sessionId",
        "command.id as commandId",
        "command.mailbox_position as mailboxPosition",
        "command.created_at as commandCreatedAt",
        "command.payload as commandPayload",
      ])
      .where("rewind.tenant_id", "=", this.#tenantId)
      .where("rewind.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst() as Promise<AcceptedRunRewindRow | undefined>;
  }

  async acceptEnvironmentValidationTurn(
    sessionId: string,
    environmentVersionId: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<AcceptedTurnResource> {
    const request: AcceptTurnRequest = {
      prompt: [
        `Validate AgentDock environment version ${environmentVersionId}.`,
        "Before answering, call the bash tool exactly once with `git status --short` in /workspace.",
        "Do not edit files. Report whether the environment is ready.",
      ].join(" "),
      thinkingLevel: "minimal",
    };
    const fingerprint = turnRequestFingerprint(request);
    const existing = await this.#findAcceptedTurn(sessionId, idempotencyKey);
    if (existing) return acceptedTurnResource(existing, fingerprint, true);
    try {
      return await this.#acceptNewTurn(sessionId, idempotencyKey, request, fingerprint, {
        environmentVersionId,
        actorUserId,
      });
    } catch (error) {
      if (!isPostgresConstraint(error, "commands_session_idempotency_unique")) throw error;
      const concurrentWinner = await this.#findAcceptedTurn(sessionId, idempotencyKey);
      if (!concurrentWinner) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Idempotent environment validation exists without its accepted turn",
        );
      }
      return acceptedTurnResource(concurrentWinner, fingerprint, true);
    }
  }

  async #loadRunResource(runId: string): Promise<RunResource> {
    const run = await this.#database
      .selectFrom("runs as run")
      .innerJoin("environment_versions as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "run.tenant_id")
          .onRef("environment.project_id", "=", "run.project_id")
          .onRef("environment.id", "=", "run.environment_version_id"),
      )
      .selectAll("run")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("run.tenant_id", "=", this.#tenantId)
      .where("run.id", "=", runId)
      .executeTakeFirst();
    if (run === undefined) throw new ControlPlaneStoreError("not_found", "Run was not found");

    const attempts = await this.#database
      .selectFrom("run_attempts")
      .selectAll()
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", run.id)
      .orderBy("attempt_number", "asc")
      .limit(32)
      .execute();
    const transitions = await this.#database
      .selectFrom("run_attempt_transitions")
      .select(["attempt_id", "from_state", "to_state", "reason", "occurred_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", run.id)
      .orderBy("occurred_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const [rewoundFrom, rewoundBy] = await Promise.all([
      this.#database
        .selectFrom("run_rewinds")
        .select(["source_run_id", "source_attempt_id", "conversation_boundary_seq"])
        .where("tenant_id", "=", this.#tenantId)
        .where("replacement_run_id", "=", run.id)
        .executeTakeFirst(),
      this.#database
        .selectFrom("run_rewinds")
        .select("replacement_run_id")
        .where("tenant_id", "=", this.#tenantId)
        .where("source_run_id", "=", run.id)
        .executeTakeFirst(),
    ]);
    const optionalTimestamp = (value: Date | string | null): string | undefined =>
      value === null ? undefined : isoTimestamp(value);
    const transitionRank: Record<string, number> = {
      claimed: 1,
      provisioning: 2,
      restoring: 3,
      running: 4,
      checkpointing: 5,
      cancel_requested: 6,
      completed: 7,
      failed: 7,
      cancelled: 7,
      timed_out: 7,
      superseded: 7,
    };
    const failure = (
      code: string | null,
      message: string | null,
      retryable: boolean | null,
    ): { code: string; message?: string; retryable: boolean } | undefined => {
      if (code === null && message === null && retryable === null) return undefined;
      if (code === null || retryable === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Run failure metadata is incomplete",
        );
      }
      return { code, ...(message === null ? {} : { message }), retryable };
    };

    return {
      runId: run.id,
      projectId: run.project_id,
      workspaceId: run.workspace_id,
      sessionId: run.session_id,
      turnId: run.turn_id,
      commandId: run.command_id,
      environment: environmentSnapshot(run),
      sourceSet: parseWorkspaceSourceSetSnapshot(run.source_set_snapshot),
      state: run.state,
      projection: rewoundBy === undefined ? "canonical" : "superseded",
      ...(rewoundBy === undefined ? {} : { supersededByRunId: rewoundBy.replacement_run_id }),
      ...(rewoundFrom === undefined
        ? {}
        : {
            rewoundFrom: {
              sourceRunId: rewoundFrom.source_run_id,
              sourceAttemptId: rewoundFrom.source_attempt_id,
              conversationBoundarySeq: nonNegativeSafeInteger(
                rewoundFrom.conversation_boundary_seq,
                "Rewind conversation boundary",
              ),
            },
          }),
      traceId: run.trace_id,
      attemptCount: nonNegativeSafeInteger(run.attempt_count, "Run attempt count"),
      ...(run.current_attempt_id === null ? {} : { currentAttemptId: run.current_attempt_id }),
      ...(run.stop_reason === null ? {} : { stopReason: run.stop_reason }),
      ...(failure(run.failure_code, run.failure_message, run.failure_retryable) === undefined
        ? {}
        : { failure: failure(run.failure_code, run.failure_message, run.failure_retryable)! }),
      queuedAt: isoTimestamp(run.queued_at),
      ...(optionalTimestamp(run.started_at) === undefined
        ? {}
        : { startedAt: optionalTimestamp(run.started_at)! }),
      ...(optionalTimestamp(run.settled_at) === undefined
        ? {}
        : { settledAt: optionalTimestamp(run.settled_at)! }),
      updatedAt: isoTimestamp(run.updated_at),
      attempts: attempts.map((attempt, index) => {
        const attemptFailure = failure(
          attempt.failure_code,
          attempt.failure_message,
          attempt.failure_retryable,
        );
        return {
          attemptId: attempt.id,
          attemptNumber: positiveSafeInteger(String(attempt.attempt_number), "Run attempt number"),
          state: attempt.state,
          projection:
            rewoundBy === undefined && attempt.id === run.current_attempt_id
              ? "canonical"
              : "superseded",
          ...(attempt.id === run.current_attempt_id || attempts[index + 1] === undefined
            ? {}
            : { supersededByAttemptId: attempts[index + 1]!.id }),
          claimOwnerId: attempt.claim_owner_id,
          claimExpiresAt: isoTimestamp(attempt.claim_expires_at),
          ...(attempt.sandbox_id === null ? {} : { sandboxId: attempt.sandbox_id }),
          ...(attempt.lease_id === null ? {} : { leaseId: attempt.lease_id }),
          ...(attempt.fencing_token === null
            ? {}
            : {
                fencingToken: positiveSafeInteger(
                  attempt.fencing_token,
                  "Run attempt fencing token",
                ),
              }),
          ...(attempt.checkpoint_revision === null
            ? {}
            : { checkpointRevision: attempt.checkpoint_revision }),
          ...(attemptFailure === undefined ? {} : { failure: attemptFailure }),
          claimedAt: isoTimestamp(attempt.claimed_at),
          ...(optionalTimestamp(attempt.provisioning_at) === undefined
            ? {}
            : { provisioningAt: optionalTimestamp(attempt.provisioning_at)! }),
          ...(optionalTimestamp(attempt.restoring_at) === undefined
            ? {}
            : { restoringAt: optionalTimestamp(attempt.restoring_at)! }),
          ...(optionalTimestamp(attempt.running_at) === undefined
            ? {}
            : { runningAt: optionalTimestamp(attempt.running_at)! }),
          ...(optionalTimestamp(attempt.checkpointing_at) === undefined
            ? {}
            : { checkpointingAt: optionalTimestamp(attempt.checkpointing_at)! }),
          ...(optionalTimestamp(attempt.last_heartbeat_at) === undefined
            ? {}
            : { lastHeartbeatAt: optionalTimestamp(attempt.last_heartbeat_at)! }),
          ...(optionalTimestamp(attempt.settled_at) === undefined
            ? {}
            : { settledAt: optionalTimestamp(attempt.settled_at)! }),
          transitions: transitions
            .filter((transition) => transition.attempt_id === attempt.id)
            .sort((left, right) => {
              const time =
                new Date(left.occurred_at).valueOf() - new Date(right.occurred_at).valueOf();
              return time !== 0
                ? time
                : transitionRank[left.to_state]! - transitionRank[right.to_state]!;
            })
            .map((transition) => ({
              fromState: transition.from_state,
              toState: transition.to_state,
              reason: transition.reason,
              occurredAt: isoTimestamp(transition.occurred_at),
            })),
        };
      }),
    };
  }

  async acceptTurnCancellation(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    request: CreateTurnCancellationRequest,
  ): Promise<AcceptedTurnCancellationResource> {
    const gracePeriodMs = request.gracePeriodMs ?? DEFAULT_CANCELLATION_GRACE_PERIOD_MS;
    const fingerprint = cancellationRequestFingerprint(gracePeriodMs);
    const existing = await this.#findAcceptedTurnCancellation(sessionId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.turnId !== turnId) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different cancellation request",
        );
      }
      return acceptedTurnCancellationResource(existing, fingerprint, true);
    }

    try {
      return await this.#acceptNewTurnCancellation(
        sessionId,
        turnId,
        idempotencyKey,
        gracePeriodMs,
        fingerprint,
      );
    } catch (error) {
      if (!isPostgresConstraint(error, "commands_session_idempotency_unique")) throw error;
      const concurrentWinner = await this.#findAcceptedTurnCancellation(sessionId, idempotencyKey);
      if (concurrentWinner === undefined || concurrentWinner.turnId !== turnId) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different command",
        );
      }
      return acceptedTurnCancellationResource(concurrentWinner, fingerprint, true);
    }
  }

  async #acceptNewTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
    fingerprint: string,
    validation?: { environmentVersionId: string; actorUserId: string },
  ): Promise<AcceptedTurnResource> {
    const turnId = this.#idGenerator();
    const commandId = this.#idGenerator();
    const outboxId = this.#idGenerator();
    const runId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const policy = await this.#lockTenantPolicy(transaction);
      const session = await transaction
        .selectFrom("sessions")
        .select([
          "id",
          "project_id",
          "workspace_id",
          "desired_model_profile_id",
          "state",
          "next_event_seq",
          "next_mailbox_position",
          "current_workspace_version_id",
          "pi_session_snapshot_key",
          "archived_at",
        ])
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!session) {
        throw new ControlPlaneStoreError("not_found", "Session was not found");
      }
      if (session.archived_at !== null) {
        throw new ControlPlaneStoreError("conflict", "Archived Session cannot accept turns");
      }
      if (session.desired_model_profile_id !== this.#defaultModelProfileId) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session model profile does not match the configured v0 profile",
        );
      }
      if (!TURN_ACCEPTING_SESSION_STATES.has(session.state)) {
        throw new ControlPlaneStoreError(
          "conflict",
          `Session cannot accept a queued follow-up while it is ${session.state}`,
        );
      }
      const unsettled = await transaction
        .selectFrom("turns")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("tenant_id", "=", this.#tenantId)
        .where("state", "in", [
          "queued",
          "dispatching",
          "running",
          "waiting_approval",
          "cancelling",
        ])
        .executeTakeFirstOrThrow();
      if (
        nonNegativeSafeInteger(unsettled.count, "Tenant unsettled-turn count") >=
        policy.maximumUnsettledTurns
      ) {
        throw new ControlPlaneStoreError(
          "tenant_quota_exceeded",
          "Tenant unsettled-turn quota has been reached",
        );
      }
      const mailboxPosition = positiveSafeInteger(
        session.next_mailbox_position,
        "Next mailbox position",
      );
      const model = await this.#resolveModelSnapshot(transaction, request.thinkingLevel);
      const environment =
        validation === undefined
          ? await this.#activeEnvironmentForRun(transaction, session.project_id)
          : await this.#environmentVersionForValidation(
              transaction,
              session.project_id,
              validation.environmentVersionId,
            );
      const sourceSet = await this.#workspaceSourceSetForRun(
        transaction,
        session.project_id,
        session.workspace_id,
      );
      const piSessionBaseArtifact =
        session.pi_session_snapshot_key === null
          ? undefined
          : await transaction
              .selectFrom("artifacts")
              .select("id")
              .where("tenant_id", "=", this.#tenantId)
              .where("session_id", "=", session.id)
              .where("kind", "=", "pi_session_snapshot")
              .where("object_key", "=", session.pi_session_snapshot_key)
              .executeTakeFirst();
      if (session.pi_session_snapshot_key !== null && piSessionBaseArtifact === undefined) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session Pi snapshot does not reference a durable Artifact",
        );
      }

      await transaction
        .insertInto("turns")
        .values({
          id: turnId,
          tenant_id: this.#tenantId,
          session_id: session.id,
          state: "queued",
          input_kind: "prompt",
          input_text: request.prompt,
          model_profile_id: model.profileId,
          provider: model.provider,
          model_id: model.modelId,
          thinking_level: model.thinkingLevel,
          credential_binding_id: model.credentialBindingId,
          credential_binding_version: model.credentialBindingVersion,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
        })
        .executeTakeFirstOrThrow();

      const command = await transaction
        .insertInto("commands")
        .values({
          id: commandId,
          tenant_id: this.#tenantId,
          session_id: session.id,
          turn_id: turnId,
          idempotency_key: idempotencyKey,
          kind: "turn.execute",
          state: "pending",
          mailbox_position: mailboxPosition,
          payload: { schemaVersion: 1, requestHash: fingerprint },
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .returning(["id", "created_at", "payload"])
        .executeTakeFirstOrThrow();

      if (validation !== undefined) {
        const active = await transaction
          .selectFrom("environment_versions")
          .select("id")
          .where("tenant_id", "=", this.#tenantId)
          .where("project_id", "=", session.project_id)
          .where("active", "=", true)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("environment_operations")
          .values({
            id: this.#idGenerator(),
            tenant_id: this.#tenantId,
            project_id: session.project_id,
            actor_user_id: validation.actorUserId,
            kind: "validate",
            from_environment_version_id: active.id,
            to_environment_version_id: validation.environmentVersionId,
            idempotency_key: idempotencyKey,
            request_fingerprint: fingerprint,
          })
          .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto("runs")
        .values({
          id: runId,
          trace_id: createHash("sha256")
            .update("agent-dock.run-trace.v1\0", "utf8")
            .update(runId, "utf8")
            .digest("hex")
            .slice(0, 32),
          tenant_id: this.#tenantId,
          project_id: session.project_id,
          workspace_id: session.workspace_id,
          session_id: session.id,
          turn_id: turnId,
          command_id: command.id,
          environment_version_id: environment.environmentVersionId,
          source_set_snapshot: sql<Record<string, unknown>>`${canonicalWorkspaceSourceSetJson(
            sourceSet,
          )}::jsonb`,
          conversation_base_seq: Math.max(
            0,
            positiveSafeInteger(session.next_event_seq, "Next event sequence") - 1,
          ),
          workspace_base_version_id: session.current_workspace_version_id,
          pi_session_base_artifact_id: piSessionBaseArtifact?.id ?? null,
          idempotency_key: idempotencyKey,
          state: "queued",
          current_attempt_id: null,
          attempt_count: 0,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          started_at: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("outbox")
        .values({
          id: outboxId,
          tenant_id: this.#tenantId,
          aggregate_type: "session",
          aggregate_id: session.id,
          topic: TURN_COMMAND_OUTBOX_TOPIC,
          payload: {
            schemaVersion: 1,
            commandId: command.id,
            sessionId: session.id,
            turnId,
            kind: "turn.execute",
          },
          published_at: null,
          last_error: null,
        })
        .executeTakeFirstOrThrow();

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          next_mailbox_position: sql<string>`${sql.ref("next_mailbox_position")} + 1`,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", session.id)
        .where("next_mailbox_position", "=", String(mailboxPosition))
        .executeTakeFirst();
      if (sessionUpdate.numUpdatedRows !== 1n) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session mailbox position could not be advanced",
        );
      }

      return acceptedTurnResource(
        {
          runId,
          commandId: command.id,
          mailboxPosition: String(mailboxPosition),
          turnId,
          sessionId: session.id,
          commandCreatedAt: command.created_at,
          commandPayload: command.payload,
        },
        fingerprint,
        false,
      );
    });
  }

  async #findAcceptedTurn(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<AcceptedTurnRow | undefined> {
    const row = await this.#database
      .selectFrom("commands as command")
      .innerJoin("turns as turn", "turn.id", "command.turn_id")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "command.tenant_id")
          .onRef("run.turn_id", "=", "turn.id")
          .onRef("run.command_id", "=", "command.id"),
      )
      .select([
        "run.id as runId",
        "command.id as commandId",
        "command.mailbox_position as mailboxPosition",
        "command.created_at as commandCreatedAt",
        "command.payload as commandPayload",
        "turn.id as turnId",
        "turn.session_id as sessionId",
      ])
      .where("command.tenant_id", "=", this.#tenantId)
      .where("command.session_id", "=", sessionId)
      .where("command.idempotency_key", "=", idempotencyKey)
      .where("command.kind", "=", "turn.execute")
      .where("command.mailbox_position", "is not", null)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.mailboxPosition === null) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Stored turn command has no mailbox position",
      );
    }
    return { ...row, mailboxPosition: row.mailboxPosition };
  }

  async #acceptNewTurnCancellation(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    gracePeriodMs: number,
    fingerprint: string,
  ): Promise<AcceptedTurnCancellationResource> {
    const commandId = this.#idGenerator();
    const outboxId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const lifecycle = await transaction
        .selectFrom("turns as turn")
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "turn.tenant_id")
            .onRef("session_row.id", "=", "turn.session_id"),
        )
        .select([
          "turn.id as turnId",
          "turn.state as turnState",
          "session_row.id as sessionId",
          "session_row.state as sessionState",
        ])
        .where("turn.tenant_id", "=", this.#tenantId)
        .where("turn.session_id", "=", sessionId)
        .where("turn.id", "=", turnId)
        .forUpdate(["turn", "session_row"])
        .executeTakeFirst();
      if (lifecycle === undefined) {
        throw new ControlPlaneStoreError("not_found", "Turn was not found");
      }
      const activePair =
        (lifecycle.turnState === "running" && lifecycle.sessionState === "running") ||
        (lifecycle.turnState === "waiting_approval" &&
          lifecycle.sessionState === "waiting_approval");
      if (!activePair) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Only an active turn can accept a cancellation request",
        );
      }

      const target = await transaction
        .selectFrom("commands")
        .select(["id", "state"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "=", turnId)
        .where("kind", "=", "turn.execute")
        .forUpdate()
        .executeTakeFirst();
      if (target === undefined || target.state !== "acknowledged") {
        throw new ControlPlaneStoreError(
          "conflict",
          "Turn does not have one acknowledged execution to cancel",
        );
      }

      const activeCancellation = await transaction
        .selectFrom("commands")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "=", turnId)
        .where("kind", "=", "turn.cancel")
        .where("state", "in", ["pending", "dispatched", "acknowledged"])
        .executeTakeFirst();
      if (activeCancellation !== undefined) {
        throw new ControlPlaneStoreError("conflict", "Turn cancellation is already in progress");
      }

      const command = await transaction
        .insertInto("commands")
        .values({
          id: commandId,
          tenant_id: this.#tenantId,
          session_id: sessionId,
          turn_id: turnId,
          idempotency_key: idempotencyKey,
          kind: "turn.cancel",
          state: "pending",
          payload: {
            schemaVersion: 1,
            requestHash: fingerprint,
            targetCommandId: target.id,
            reason: "user_request",
            gracePeriodMs,
          },
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .returning(["id", "created_at", "payload"])
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("outbox")
        .values({
          id: outboxId,
          tenant_id: this.#tenantId,
          aggregate_type: "session",
          aggregate_id: sessionId,
          topic: TURN_CANCELLATION_OUTBOX_TOPIC,
          payload: {
            schemaVersion: 1,
            commandId: command.id,
            targetCommandId: target.id,
            sessionId,
            turnId,
            kind: "turn.cancel",
          },
          published_at: null,
          last_error: null,
        })
        .executeTakeFirstOrThrow();

      return acceptedTurnCancellationResource(
        {
          commandId: command.id,
          turnId,
          sessionId,
          commandCreatedAt: command.created_at,
          commandPayload: command.payload,
        },
        fingerprint,
        false,
      );
    });
  }

  async #findAcceptedTurnCancellation(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<AcceptedTurnCancellationRow | undefined> {
    return this.#database
      .selectFrom("commands as command")
      .innerJoin("turns as turn", "turn.id", "command.turn_id")
      .select([
        "command.id as commandId",
        "command.created_at as commandCreatedAt",
        "command.payload as commandPayload",
        "turn.id as turnId",
        "turn.session_id as sessionId",
      ])
      .where("command.tenant_id", "=", this.#tenantId)
      .where("command.session_id", "=", sessionId)
      .where("command.idempotency_key", "=", idempotencyKey)
      .where("command.kind", "=", "turn.cancel")
      .executeTakeFirst();
  }

  async #loadActiveProjectEnvironment(projectId: string): Promise<ProjectEnvironmentResource> {
    const row = await this.#database
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.active", "=", true)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment version",
      );
    }
    const snapshot = environmentSnapshot(row);
    const validation = await this.#database
      .selectFrom("environment_validations")
      .select(["report", "validated_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("project_id", "=", projectId)
      .where("environment_version_id", "=", snapshot.environmentVersionId)
      .where("status", "=", "validated")
      .orderBy("validated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    let latestValidation;
    if (validation?.report !== null && validation?.report !== undefined) {
      try {
        latestValidation = parseEnvironmentValidationReport(validation.report);
      } catch {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Project environment validation evidence is invalid",
        );
      }
    }
    if (row.environmentState === "validated" && latestValidation === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Validated project environment has no evidence",
      );
    }
    return {
      ...snapshot,
      state: row.environmentState,
      active: row.environmentActive,
      createdAt: isoTimestamp(row.environmentCreatedAt),
      ...(row.environmentValidatedAt === null
        ? {}
        : { validatedAt: isoTimestamp(row.environmentValidatedAt) }),
      ...(latestValidation === undefined ? {} : { latestValidation }),
    };
  }

  async #workspaceSourceSetForRun(
    transaction: Transaction<Database>,
    projectId: string,
    workspaceId: string,
  ): Promise<WorkspaceSourceSetSnapshot> {
    const row = await transaction
      .selectFrom("workspaces as workspace")
      .innerJoin("workspace_sources as source", (join) =>
        join
          .onRef("source.tenant_id", "=", "workspace.tenant_id")
          .onRef("source.workspace_id", "=", "workspace.id"),
      )
      .leftJoin("github_repositories as github_repository", (join) =>
        join
          .onRef("github_repository.tenant_id", "=", "source.tenant_id")
          .onRef("github_repository.repository_id", "=", "source.github_repository_id"),
      )
      .select([
        "source.kind as sourceKind",
        "source.repository as sourceRepository",
        "source.commit_sha as sourceCommitSha",
        "source.status as sourceStatus",
        "source.failure_code as sourceFailureCode",
        "source.github_installation_id as sourceInstallationId",
        "source.github_repository_id as sourceRepositoryId",
        "github_repository.private as sourcePrivate",
      ])
      .where("workspace.tenant_id", "=", this.#tenantId)
      .where("workspace.project_id", "=", projectId)
      .where("workspace.id", "=", workspaceId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Workspace source was not found");
    }
    return workspaceSourceSetSnapshot({
      ...row,
      ...(row.sourceKind === "repository_set"
        ? {
            sourceRepositories: await loadWorkspaceRepositorySources(
              transaction,
              this.#tenantId,
              workspaceId,
            ),
          }
        : {}),
    });
  }

  async #activeEnvironmentForRun(
    transaction: Transaction<Database>,
    projectId: string,
  ): Promise<EnvironmentRuntimeSnapshot> {
    const project = await transaction
      .selectFrom("projects")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    if (project === undefined) {
      throw new ControlPlaneStoreError("not_found", "Project was not found");
    }
    const active = await transaction
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.active", "=", true)
      .forUpdate()
      .executeTakeFirst();
    if (active === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment version",
      );
    }
    const current = environmentSnapshot(active);
    if (active.environmentState === "failed") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Active environment failed validation and must be rolled back",
      );
    }
    if (current.imageRevision === this.#environmentImageRevision) return current;

    await transaction
      .updateTable("environment_versions")
      .set({ active: false, updated_at: sql<Date>`now()` })
      .where("tenant_id", "=", this.#tenantId)
      .where("project_id", "=", projectId)
      .where("id", "=", current.environmentVersionId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const created = await transaction
      .insertInto("environment_versions")
      .values({
        id: this.#idGenerator(),
        tenant_id: this.#tenantId,
        project_id: projectId,
        version_number: current.versionNumber + 1,
        profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
        profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
        image_revision: this.#environmentImageRevision,
        spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipe: sql<Record<string, unknown>>`${JSON.stringify(current.recipe)}::jsonb`,
        recipe_sha256: current.recipeSha256,
        state: "pending",
        active: true,
        validated_at: null,
      })
      .returning([
        "id as environmentVersionId",
        "version_number as environmentVersionNumber",
        "profile_key as environmentProfileKey",
        "profile_version as environmentProfileVersion",
        "image_revision as environmentImageRevision",
        "spec_sha256 as environmentSpecSha256",
        "recipe as environmentRecipe",
        "recipe_sha256 as environmentRecipeSha256",
        "state as environmentState",
        "active as environmentActive",
        "created_at as environmentCreatedAt",
        "validated_at as environmentValidatedAt",
      ])
      .executeTakeFirstOrThrow();
    return environmentSnapshot(created);
  }

  async #environmentVersionForValidation(
    transaction: Transaction<Database>,
    projectId: string,
    environmentVersionId: string,
  ): Promise<EnvironmentRuntimeSnapshot> {
    const row = await transaction
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.id", "=", environmentVersionId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Environment version was not found");
    }
    if (row.environmentState === "failed") {
      throw new ControlPlaneStoreError("conflict", "Failed environment version cannot be retried");
    }
    const snapshot = environmentSnapshot(row);
    if (snapshot.imageRevision !== this.#environmentImageRevision) {
      throw new ControlPlaneStoreError(
        "conflict",
        "Environment version is not served by the current deployment image",
      );
    }
    return snapshot;
  }

  async #resolveModelSnapshot(
    transaction: Transaction<Database>,
    requestedThinkingLevel?: ModelThinkingLevel,
  ) {
    const row = (await transaction
      .selectFrom("model_profiles as profile")
      .innerJoin("credential_bindings as credential", (join) =>
        join
          .onRef("credential.tenant_id", "=", "profile.tenant_id")
          .onRef("credential.id", "=", "profile.credential_binding_id")
          .onRef("credential.version", "=", "profile.credential_binding_version"),
      )
      .select([
        "profile.id as profileId",
        "profile.provider as provider",
        "profile.model_id as modelId",
        "profile.default_thinking_level as defaultThinkingLevel",
        "profile.allowed_thinking_levels as allowedThinkingLevels",
        "profile.credential_binding_id as credentialBindingId",
        "profile.credential_binding_version as credentialBindingVersion",
        "profile.enabled as profileEnabled",
        "credential.status as credentialStatus",
        "credential.provider as credentialProvider",
      ])
      .where("profile.tenant_id", "=", this.#tenantId)
      .where("profile.id", "=", this.#defaultModelProfileId)
      .executeTakeFirst()) as ModelSnapshotRow | undefined;

    if (
      !row ||
      !row.profileEnabled ||
      row.credentialStatus !== "active" ||
      row.credentialProvider !== row.provider
    ) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "The configured model profile is unavailable",
      );
    }

    const profile: ModelProfile = {
      profileId: row.profileId,
      provider: row.provider,
      modelId: row.modelId,
      defaultThinkingLevel: row.defaultThinkingLevel as ModelThinkingLevel,
      allowedThinkingLevels: row.allowedThinkingLevels as ModelThinkingLevel[],
      credentialBindingId: row.credentialBindingId,
      credentialBindingVersion: positiveSafeInteger(
        row.credentialBindingVersion,
        "Credential binding version",
      ),
      enabled: row.profileEnabled,
    };
    try {
      return resolveTurnModel(profile, requestedThinkingLevel);
    } catch (error) {
      if (error instanceof DomainModelValidationError) {
        throw new ControlPlaneStoreError(
          requestedThinkingLevel === undefined ? "control_plane_misconfigured" : "invalid_request",
          error.message,
        );
      }
      throw error;
    }
  }

  async #lockTenantPolicy(transaction: Transaction<Database>): Promise<TenantRuntimePolicy> {
    const policy = await transaction
      .selectFrom("tenant_runtime_policies")
      .select([
        "default_model_profile_id as defaultModelProfileId",
        "enabled",
        "maximum_projects as maximumProjects",
        "maximum_sessions as maximumSessions",
        "maximum_unsettled_turns as maximumUnsettledTurns",
      ])
      .where("tenant_id", "=", this.#tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (policy === undefined || !policy.enabled) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Tenant runtime policy is unavailable",
      );
    }
    if (policy.defaultModelProfileId !== this.#defaultModelProfileId) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Tenant runtime policy changed during request authentication",
      );
    }
    return {
      defaultModelProfileId: policy.defaultModelProfileId,
      maximumProjects: positiveSafeInteger(String(policy.maximumProjects), "Project quota"),
      maximumSessions: positiveSafeInteger(String(policy.maximumSessions), "Session quota"),
      maximumUnsettledTurns: positiveSafeInteger(
        String(policy.maximumUnsettledTurns),
        "Unsettled-turn quota",
      ),
    };
  }
}
