import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@agent-dock/database";
import {
  DomainModelValidationError,
  resolveTurnModel,
  type ModelProfile,
  type ModelThinkingLevel,
} from "@agent-dock/domain";
import type {
  AcceptTurnRequest,
  AcceptedTurnResource,
  ProjectResource,
  SessionResource,
} from "@agent-dock/protocol";
import type { Kysely, Transaction } from "kysely";

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

const COMMAND_TOPIC = "control.command.pending.v1";

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

function requestFingerprint(request: AcceptTurnRequest): string {
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
    turnId: row.turnId,
    sessionId: row.sessionId,
    commandId: row.commandId,
    state: "queued",
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

  async createProject(name: string): Promise<ProjectResource> {
    const projectId = this.#idGenerator();
    const workspaceId = this.#idGenerator();
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const project = await transaction
          .insertInto("projects")
          .values({ id: projectId, tenant_id: this.#tenantId, name })
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
        return {
          projectId: project.id,
          workspaceId,
          name: project.name,
          createdAt: isoTimestamp(project.created_at),
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

      await this.#resolveModelSnapshot(transaction);
      const session = await transaction
        .insertInto("sessions")
        .values({
          id: sessionId,
          tenant_id: this.#tenantId,
          project_id: workspace.project_id,
          workspace_id: workspace.id,
          desired_model_profile_id: this.#defaultModelProfileId,
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
        modelProfileId: this.#defaultModelProfileId,
        createdAt: isoTimestamp(session.created_at),
      };
    });
  }

  async acceptTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
  ): Promise<AcceptedTurnResource> {
    const fingerprint = requestFingerprint(request);
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

  async #acceptNewTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
    fingerprint: string,
  ): Promise<AcceptedTurnResource> {
    const turnId = this.#idGenerator();
    const commandId = this.#idGenerator();
    const outboxId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["id", "desired_model_profile_id"])
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!session) {
        throw new ControlPlaneStoreError("not_found", "Session was not found");
      }
      if (session.desired_model_profile_id !== this.#defaultModelProfileId) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session model profile does not match the configured v0 profile",
        );
      }
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
          payload: { schemaVersion: 1, requestHash: fingerprint },
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
          aggregate_id: session.id,
          topic: COMMAND_TOPIC,
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

      return acceptedTurnResource(
        {
          commandId: command.id,
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
      .where("command.kind", "=", "turn.execute")
      .executeTakeFirst();
    return row;
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
}
