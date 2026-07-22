import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@agent-dock/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  canonicalEnvironmentRecipeJson,
  parseEnvironmentRecipe,
  parseEnvironmentValidationReport,
  type ActivateProjectEnvironmentVersionRequest,
  type CreateProjectEnvironmentVersionRequest,
  type ProjectEnvironmentHistoryResource,
  type ProjectEnvironmentResource,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

type EnvironmentRow = {
  id: string;
  version_number: number;
  profile_key: string;
  profile_version: string;
  image_revision: string;
  spec_sha256: string;
  recipe: unknown;
  recipe_sha256: string;
  state: "pending" | "validated" | "failed";
  active: boolean;
  created_at: Date | string;
  validated_at: Date | string | null;
};

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Environment timestamp is invalid",
    );
  }
  return parsed.toISOString();
}

function fingerprint(kind: string, value: unknown): string {
  return createHash("sha256")
    .update(`agent-dock.environment-operation.v1\0${kind}\0`, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function recipeDigest(recipe: unknown): string {
  return createHash("sha256").update(canonicalEnvironmentRecipeJson(recipe), "utf8").digest("hex");
}

export class ProjectEnvironmentService {
  readonly #database: Kysely<Database>;
  readonly #imageRevision: string;
  readonly #idGenerator: () => string;

  constructor(options: {
    database: Kysely<Database>;
    imageRevision: string;
    idGenerator?: () => string;
  }) {
    this.#database = options.database;
    this.#imageRevision = options.imageRevision;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async history(
    identity: TenantRequestIdentity,
    projectId: string,
  ): Promise<ProjectEnvironmentHistoryResource> {
    const project = await this.#database
      .selectFrom("projects")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (project === undefined)
      throw new ControlPlaneStoreError("not_found", "Project was not found");

    const [rows, operationRows] = await Promise.all([
      this.#database
        .selectFrom("environment_versions")
        .select([
          "id",
          "version_number",
          "profile_key",
          "profile_version",
          "image_revision",
          "spec_sha256",
          "recipe",
          "recipe_sha256",
          "state",
          "active",
          "created_at",
          "validated_at",
        ])
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .orderBy("version_number", "desc")
        .limit(101)
        .execute(),
      this.#database
        .selectFrom("environment_operations")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .orderBy("created_at", "desc")
        .limit(101)
        .execute(),
    ]);
    const visibleRows = rows.slice(0, 100);
    const validationRows =
      visibleRows.length === 0
        ? []
        : await this.#database
            .selectFrom("environment_validations")
            .select(["environment_version_id", "report", "validated_at"])
            .where("tenant_id", "=", identity.tenantId)
            .where("project_id", "=", projectId)
            .where(
              "environment_version_id",
              "in",
              visibleRows.map((row) => row.id),
            )
            .where("status", "=", "validated")
            .orderBy("validated_at", "desc")
            .execute();
    const latestValidation = new Map<string, ProjectEnvironmentResource["latestValidation"]>();
    for (const validation of validationRows) {
      if (latestValidation.has(validation.environment_version_id) || validation.report === null) {
        continue;
      }
      latestValidation.set(
        validation.environment_version_id,
        parseEnvironmentValidationReport(validation.report),
      );
    }
    const versions = visibleRows.map((row) => this.#resource(row, latestValidation.get(row.id)));
    const active = versions.find((version) => version.active);
    if (active === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment",
      );
    }
    return {
      projectId,
      activeEnvironmentVersionId: active.environmentVersionId,
      versions,
      operations: operationRows.slice(0, 100).map((operation) => ({
        operationId: operation.id,
        kind: operation.kind,
        actorUserId: operation.actor_user_id,
        ...(operation.from_environment_version_id === null
          ? {}
          : { fromEnvironmentVersionId: operation.from_environment_version_id }),
        toEnvironmentVersionId: operation.to_environment_version_id,
        createdAt: timestamp(operation.created_at),
      })),
      truncated: rows.length > 100 || operationRows.length > 100,
    };
  }

  async createVersion(
    identity: TenantRequestIdentity,
    projectId: string,
    idempotencyKey: string,
    request: CreateProjectEnvironmentVersionRequest,
  ): Promise<ProjectEnvironmentHistoryResource> {
    const recipe = parseEnvironmentRecipe(request.recipe);
    const requestFingerprint = fingerprint("create", {
      projectId,
      recipe: JSON.parse(canonicalEnvironmentRecipeJson(recipe)) as unknown,
    });
    await this.#database.transaction().execute(async (transaction) => {
      const replay = await this.#replay(
        transaction,
        identity.tenantId,
        projectId,
        idempotencyKey,
        requestFingerprint,
        "create",
      );
      if (replay) return;
      const project = await transaction
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", projectId)
        .forUpdate()
        .executeTakeFirst();
      if (project === undefined)
        throw new ControlPlaneStoreError("not_found", "Project was not found");
      const current = await this.#active(transaction, identity.tenantId, projectId);
      const latest = await transaction
        .selectFrom("environment_versions")
        .select("version_number")
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .orderBy("version_number", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
      const digest = recipeDigest(recipe);
      if (current.recipe_sha256 === digest && current.image_revision === this.#imageRevision) {
        throw new ControlPlaneStoreError("conflict", "Environment recipe is unchanged");
      }
      const versionId = this.#idGenerator();
      await transaction
        .insertInto("environment_versions")
        .values({
          id: versionId,
          tenant_id: identity.tenantId,
          project_id: projectId,
          version_number: latest.version_number + 1,
          profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
          profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
          image_revision: this.#imageRevision,
          spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
          recipe: sql<Record<string, unknown>>`${JSON.stringify(recipe)}::jsonb`,
          recipe_sha256: digest,
          state: "pending",
          active: false,
          created_by_user_id: identity.userId,
          failure_code: null,
          validated_at: null,
        })
        .executeTakeFirstOrThrow();
      await this.#insertOperation(transaction, {
        identity,
        projectId,
        kind: "create",
        fromEnvironmentVersionId: current.id,
        toEnvironmentVersionId: versionId,
        idempotencyKey,
        requestFingerprint,
      });
    });
    return this.history(identity, projectId);
  }

  async activateVersion(
    identity: TenantRequestIdentity,
    projectId: string,
    environmentVersionId: string,
    idempotencyKey: string,
    request: ActivateProjectEnvironmentVersionRequest,
  ): Promise<ProjectEnvironmentHistoryResource> {
    const requestFingerprint = fingerprint("activate", {
      projectId,
      environmentVersionId,
      expectedActiveEnvironmentVersionId: request.expectedActiveEnvironmentVersionId,
    });
    await this.#database.transaction().execute(async (transaction) => {
      const replay = await this.#replay(
        transaction,
        identity.tenantId,
        projectId,
        idempotencyKey,
        requestFingerprint,
      );
      if (replay) return;
      const project = await transaction
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", projectId)
        .forUpdate()
        .executeTakeFirst();
      if (project === undefined)
        throw new ControlPlaneStoreError("not_found", "Project was not found");
      const current = await this.#active(transaction, identity.tenantId, projectId);
      if (current.id !== request.expectedActiveEnvironmentVersionId) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Active environment changed before activation",
        );
      }
      if (current.id === environmentVersionId) {
        throw new ControlPlaneStoreError("conflict", "Environment version is already active");
      }
      const target = await transaction
        .selectFrom("environment_versions")
        .select(["id", "version_number", "state", "image_revision"])
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .where("id", "=", environmentVersionId)
        .forUpdate()
        .executeTakeFirst();
      if (target === undefined) {
        throw new ControlPlaneStoreError("not_found", "Environment version was not found");
      }
      if (target.state !== "validated") {
        throw new ControlPlaneStoreError(
          "conflict",
          "Only a successfully validated environment version can be activated",
        );
      }
      if (target.image_revision !== this.#imageRevision) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Environment version is not served by the current deployment image",
        );
      }
      await transaction
        .updateTable("environment_versions")
        .set({ active: false, updated_at: sql<Date>`now()` })
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .where("id", "=", current.id)
        .where("active", "=", true)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("environment_versions")
        .set({ active: true, updated_at: sql<Date>`now()` })
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", projectId)
        .where("id", "=", target.id)
        .where("active", "=", false)
        .executeTakeFirstOrThrow();
      await this.#insertOperation(transaction, {
        identity,
        projectId,
        kind: target.version_number < current.version_number ? "rollback" : "activate",
        fromEnvironmentVersionId: current.id,
        toEnvironmentVersionId: target.id,
        idempotencyKey,
        requestFingerprint,
      });
    });
    return this.history(identity, projectId);
  }

  #resource(
    row: EnvironmentRow,
    latestValidation?: ProjectEnvironmentResource["latestValidation"],
  ): ProjectEnvironmentResource {
    const recipe = parseEnvironmentRecipe(row.recipe);
    if (
      row.profile_key !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      row.profile_version !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      row.spec_sha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      recipeDigest(recipe) !== row.recipe_sha256
    ) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Environment version metadata is invalid",
      );
    }
    return {
      environmentVersionId: row.id,
      versionNumber: row.version_number,
      profileKey: row.profile_key,
      profileVersion: row.profile_version,
      imageRevision: row.image_revision,
      specSha256: row.spec_sha256,
      recipe,
      recipeSha256: row.recipe_sha256,
      state: row.state,
      active: row.active,
      createdAt: timestamp(row.created_at),
      ...(row.validated_at === null ? {} : { validatedAt: timestamp(row.validated_at) }),
      ...(latestValidation === undefined ? {} : { latestValidation }),
    };
  }

  async #active(transaction: Transaction<Database>, tenantId: string, projectId: string) {
    const current = await transaction
      .selectFrom("environment_versions")
      .select(["id", "version_number", "image_revision", "recipe_sha256"])
      .where("tenant_id", "=", tenantId)
      .where("project_id", "=", projectId)
      .where("active", "=", true)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment",
      );
    }
    return current;
  }

  async #replay(
    transaction: Transaction<Database>,
    tenantId: string,
    projectId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    expectedKind?: "create",
  ): Promise<boolean> {
    const operation = await transaction
      .selectFrom("environment_operations")
      .select(["kind", "request_fingerprint"])
      .where("tenant_id", "=", tenantId)
      .where("project_id", "=", projectId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (operation === undefined) return false;
    if (
      operation.request_fingerprint !== requestFingerprint ||
      (expectedKind !== undefined && operation.kind !== expectedKind)
    ) {
      throw new ControlPlaneStoreError(
        "idempotency_conflict",
        "Idempotency-Key was already used for another environment operation",
      );
    }
    return true;
  }

  async #insertOperation(
    transaction: Transaction<Database>,
    input: {
      identity: TenantRequestIdentity;
      projectId: string;
      kind: "create" | "activate" | "rollback" | "validate";
      fromEnvironmentVersionId: string | null;
      toEnvironmentVersionId: string;
      idempotencyKey: string;
      requestFingerprint: string;
    },
  ): Promise<void> {
    await transaction
      .insertInto("environment_operations")
      .values({
        id: this.#idGenerator(),
        tenant_id: input.identity.tenantId,
        project_id: input.projectId,
        actor_user_id: input.identity.userId,
        kind: input.kind,
        from_environment_version_id: input.fromEnvironmentVersionId,
        to_environment_version_id: input.toEnvironmentVersionId,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
      })
      .executeTakeFirstOrThrow();
  }
}
