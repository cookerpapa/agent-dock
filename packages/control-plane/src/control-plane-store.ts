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
  CreateProjectRequest,
  CreateTurnCancellationRequest,
  ProjectResource,
  RunListResource,
  RunResource,
  SessionResource,
  TestResultListResource,
  WorkspaceSourceResource,
} from "@agent-dock/protocol";
import { TURN_CANCELLATION_OUTBOX_TOPIC, TURN_COMMAND_OUTBOX_TOPIC } from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";

export type ControlPlaneStoreOptions = {
  database: Kysely<Database>;
  tenantId: string;
  defaultModelProfileId: string;
  idGenerator?: () => string;
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
};

function workspaceSourceResource(row: WorkspaceSourceRow): WorkspaceSourceResource {
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

export class ControlPlaneStore {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #defaultModelProfileId: string;
  readonly #idGenerator: () => string;

  constructor(options: ControlPlaneStoreOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#defaultModelProfileId = options.defaultModelProfileId;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async createProject(input: string | CreateProjectRequest): Promise<ProjectResource> {
    const request: CreateProjectRequest =
      typeof input === "string" ? { name: input, source: { kind: "sample_java" } } : input;
    const source = request.source ?? { kind: "sample_java" as const };
    const projectId = this.#idGenerator();
    const workspaceId = this.#idGenerator();
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
        const appRepository =
          source.kind === "github_app"
            ? await transaction
                .selectFrom("github_repositories as repository")
                .innerJoin("github_app_installations as installation", (join) =>
                  join
                    .onRef("installation.tenant_id", "=", "repository.tenant_id")
                    .onRef("installation.installation_id", "=", "repository.installation_id"),
                )
                .select(["repository.full_name", "repository.private"])
                .where("repository.tenant_id", "=", this.#tenantId)
                .where("repository.repository_id", "=", String(source.repositoryId))
                .where("repository.installation_id", "=", String(source.installationId))
                .where("repository.enabled", "=", true)
                .where("installation.status", "=", "active")
                .executeTakeFirst()
            : undefined;
        if (source.kind === "github_app" && appRepository === undefined) {
          throw new ControlPlaneStoreError(
            "not_found",
            "GitHub App repository was not found or is not allowlisted",
          );
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
                  ? appRepository!.full_name
                  : null,
            commit_sha: source.kind === "sample_java" ? null : source.commitSha,
            status: source.kind === "sample_java" ? "ready" : "pending",
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
        return {
          projectId: project.id,
          workspaceId,
          name: project.name,
          createdAt: isoTimestamp(project.created_at),
          source:
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
                    repository: appRepository!.full_name,
                    commitSha: source.commitSha,
                    private: appRepository!.private,
                    status: "pending",
                  }
                : { kind: "sample_java", status: "ready" },
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
      .select([
        "run.id as runId",
        "turn.id as turnId",
        "turn.input_kind as inputKind",
        "turn.input_text as prompt",
        "turn.state as turnState",
        "command.id as commandId",
        "command.mailbox_position as mailboxPosition",
        "command.created_at as acceptedAt",
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
        acceptedAt: isoTimestamp(row.acceptedAt),
      };
    });

    let replayAfterSequence = 0;
    if (historyTruncated) {
      const includedTurnIds = turns.map((turn) => turn.turnId);
      const earliestIncludedEvent = await this.#database
        .selectFrom("session_events")
        .select((expression) => expression.fn.min<string>("seq").as("sequence"))
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "in", includedTurnIds)
        .executeTakeFirstOrThrow();
      replayAfterSequence =
        earliestIncludedEvent.sequence === null
          ? nonNegativeSafeInteger(
              conversation.lastPersistedSequence,
              "Conversation durable event cursor",
            )
          : Math.max(
              0,
              positiveSafeInteger(
                earliestIncludedEvent.sequence,
                "Conversation first included event sequence",
              ) - 1,
            );
    }

    return {
      project: {
        projectId: conversation.projectId,
        workspaceId: conversation.workspaceId,
        name: conversation.projectName,
        createdAt: isoTimestamp(conversation.projectCreatedAt),
        source: workspaceSourceResource(conversation),
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

  async #loadRunResource(runId: string): Promise<RunResource> {
    const run = await this.#database
      .selectFrom("runs")
      .selectAll()
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", runId)
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
      state: run.state,
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
      attempts: attempts.map((attempt) => {
        const attemptFailure = failure(
          attempt.failure_code,
          attempt.failure_message,
          attempt.failure_retryable,
        );
        return {
          attemptId: attempt.id,
          attemptNumber: positiveSafeInteger(String(attempt.attempt_number), "Run attempt number"),
          state: attempt.state,
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
          "next_mailbox_position",
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

      await transaction
        .insertInto("runs")
        .values({
          id: runId,
          tenant_id: this.#tenantId,
          project_id: session.project_id,
          workspace_id: session.workspace_id,
          session_id: session.id,
          turn_id: turnId,
          command_id: command.id,
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
