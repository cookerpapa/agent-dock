import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import {
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH,
  DEVELOPMENT_ENVIRONMENT_PROFILES,
  parseDevelopmentEnvironmentBrokerResponse,
  parseEnvironmentRuntimeSnapshot,
  type CreateDevelopmentEnvironmentRequest,
  type DevelopmentEnvironmentActionRequest,
  type DevelopmentEnvironmentBrokerRequest,
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentResource,
} from "@pi-cloud/protocol";
import { createWorkspaceSnapshot, encodeWorkspaceSnapshotBlob } from "@pi-cloud/workspace-runtime";
import type { Kysely } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const MAXIMUM_ENVIRONMENTS = 100;
const MAXIMUM_REDIRECTS = 3;

export type DevelopmentEnvironmentServiceOptions = Readonly<{
  database: Kysely<Database>;
  terminalToken: string;
  allowInsecureInternalHttp: boolean;
  idGenerator?: () => string;
}>;

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function profile(key: string) {
  const selected = DEVELOPMENT_ENVIRONMENT_PROFILES.find((candidate) => candidate.key === key);
  if (selected === undefined) {
    throw new ControlPlaneStoreError(
      "invalid_request",
      "Development environment profile is invalid",
    );
  }
  return selected;
}

function resource(row: {
  id: string;
  projectId: string;
  workspaceId: string;
  workspaceName: string;
  state: DevelopmentEnvironmentResource["state"];
  generation: string;
  profileKey: string;
  cpuCount: number;
  memoryMiB: number;
  systemDiskGiB: number;
  failureCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  releasedAt: Date | string | null;
}): DevelopmentEnvironmentResource {
  const generation = Number(row.generation);
  const selectedProfile = profile(row.profileKey);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Development environment generation is invalid",
    );
  }
  return {
    environmentId: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    state: row.state,
    generation,
    profileKey: selectedProfile.key,
    cpuCount: row.cpuCount,
    memoryMiB: row.memoryMiB,
    systemDiskGiB: row.systemDiskGiB,
    ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(row.releasedAt === null ? {} : { releasedAt: new Date(row.releasedAt).toISOString() }),
  };
}

export class DevelopmentEnvironmentService {
  readonly #database: Kysely<Database>;
  readonly #terminalToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  readonly #id: () => string;

  constructor(options: DevelopmentEnvironmentServiceOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.terminalToken)) {
      throw new TypeError("Development environment service token is invalid");
    }
    this.#database = options.database;
    this.#terminalToken = options.terminalToken;
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
    this.#id = options.idGenerator ?? randomUUID;
  }

  async list(identity: TenantRequestIdentity): Promise<DevelopmentEnvironmentListResource> {
    const rows = await this.#baseQuery(identity)
      .orderBy("development.updated_at", "desc")
      .orderBy("development.id", "desc")
      .limit(MAXIMUM_ENVIRONMENTS + 1)
      .execute();
    return {
      environments: rows.slice(0, MAXIMUM_ENVIRONMENTS).map(resource),
      profiles: DEVELOPMENT_ENVIRONMENT_PROFILES.map((candidate) => ({
        ...candidate,
        recommended: candidate.key === "standard",
      })),
      truncated: rows.length > MAXIMUM_ENVIRONMENTS,
    };
  }

  async get(
    identity: TenantRequestIdentity,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentResource> {
    const row = await this.#baseQuery(identity)
      .where("development.id", "=", environmentId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Development environment was not found");
    }
    return resource(row);
  }

  async create(
    identity: TenantRequestIdentity,
    idempotencyKey: string,
    request: CreateDevelopmentEnvironmentRequest,
  ): Promise<DevelopmentEnvironmentResource> {
    const fingerprint = requestHash(request);
    const environmentId = await this.#database.transaction().execute(async (transaction) => {
      const replay = await transaction
        .selectFrom("development_environments")
        .select(["id", "request_sha256"])
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency key was reused for another development environment",
          );
        }
        return replay.id;
      }
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["id", "project_id", "sandbox_domain_id"])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", request.workspaceId)
        .where("workspace_kind", "=", "user")
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (workspace === undefined) {
        throw new ControlPlaneStoreError("not_found", "Workspace was not found");
      }
      const activeRun = await transaction
        .selectFrom("runs")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", workspace.id)
        .where("state", "in", ["claimed", "running", "cancel_requested"])
        .limit(1)
        .executeTakeFirst();
      if (activeRun !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Wait for the active Agent Run before requesting an exclusive environment",
        );
      }
      const live = await transaction
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", workspace.id)
        .where("state", "in", [
          "requested",
          "provisioning",
          "running",
          "paused",
          "releasing",
          "unknown",
        ])
        .executeTakeFirst();
      if (live !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Workspace already has an exclusive development environment",
        );
      }
      const id = this.#id();
      const selectedProfile = profile(request.profileKey);
      await transaction
        .insertInto("development_environments")
        .values({
          id,
          tenant_id: identity.tenantId,
          owner_user_id: identity.userId,
          project_id: workspace.project_id,
          workspace_id: workspace.id,
          sandbox_domain_id: workspace.sandbox_domain_id,
          environment_version_id: null,
          owner_instance_id: null,
          owner_base_url: null,
          runtime_id: null,
          runtime_name: null,
          profile_key: selectedProfile.key,
          cpu_count: selectedProfile.cpuCount,
          memory_mib: selectedProfile.memoryMiB,
          system_disk_gib: selectedProfile.systemDiskGiB,
          state: "requested",
          failure_code: null,
          idempotency_key: idempotencyKey,
          request_sha256: fingerprint,
          released_at: null,
        })
        .executeTakeFirstOrThrow();
      return id;
    });
    await this.#provision(identity, environmentId);
    return this.get(identity, environmentId);
  }

  async action(
    identity: TenantRequestIdentity,
    environmentId: string,
    idempotencyKey: string,
    request: DevelopmentEnvironmentActionRequest,
  ): Promise<DevelopmentEnvironmentResource> {
    const fingerprint = requestHash(request);
    const replayed = await this.#database.transaction().execute(async (transaction) => {
      const environment = await transaction
        .selectFrom("development_environments")
        .select(["state", "generation", "workspace_id as workspaceId"])
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirst();
      if (environment === undefined) {
        throw new ControlPlaneStoreError("not_found", "Development environment was not found");
      }
      const replay = await transaction
        .selectFrom("development_environment_operations")
        .select("request_sha256")
        .where("tenant_id", "=", identity.tenantId)
        .where("environment_id", "=", environmentId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency key was reused for another environment action",
          );
        }
        return true;
      }
      const allowed =
        (request.action === "start" && ["requested", "failed"].includes(environment.state)) ||
        (request.action === "pause" && environment.state === "running") ||
        (request.action === "resume" && environment.state === "paused") ||
        (request.action === "release" &&
          ["requested", "running", "paused", "failed", "unknown"].includes(environment.state));
      if (!allowed) {
        throw new ControlPlaneStoreError(
          "conflict",
          `Development environment cannot ${request.action} from ${environment.state}`,
        );
      }
      if (request.action === "start") {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", environment.workspaceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const activeRun = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("workspace_id", "=", environment.workspaceId)
          .where("state", "in", ["claimed", "running", "cancel_requested"])
          .limit(1)
          .executeTakeFirst();
        if (activeRun !== undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the active Agent Run before starting the exclusive environment",
          );
        }
      }
      if (request.action === "start" && environment.state === "failed") {
        const currentGeneration = Number(environment.generation);
        if (
          !Number.isSafeInteger(currentGeneration) ||
          currentGeneration >= Number.MAX_SAFE_INTEGER
        ) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Development environment generation cannot advance",
          );
        }
        await transaction
          .updateTable("development_environments")
          .set({
            state: "requested",
            owner_instance_id: null,
            owner_base_url: null,
            environment_version_id: null,
            runtime_id: null,
            runtime_name: null,
            generation: String(currentGeneration + 1),
            failure_code: null,
            released_at: null,
            updated_at: new Date(),
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", environmentId)
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto("development_environment_operations")
        .values({
          id: this.#id(),
          tenant_id: identity.tenantId,
          environment_id: environmentId,
          actor_user_id: identity.userId,
          idempotency_key: idempotencyKey,
          action: request.action,
          request_sha256: fingerprint,
          result_state: request.action === "start" ? "requested" : environment.state,
        })
        .executeTakeFirstOrThrow();
      return false;
    });
    if (!replayed) {
      if (request.action === "start") {
        await this.#provision(identity, environmentId);
      } else if (request.action === "release") {
        const current = await this.get(identity, environmentId);
        if (current.state === "requested" || current.state === "failed") {
          await this.#database
            .updateTable("development_environments")
            .set({
              state: "released",
              owner_instance_id: null,
              owner_base_url: null,
              runtime_id: null,
              runtime_name: null,
              released_at: new Date(),
              updated_at: new Date(),
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("owner_user_id", "=", identity.userId)
            .where("id", "=", environmentId)
            .executeTakeFirstOrThrow();
        } else {
          await this.#lifecycle(identity, environmentId, request.action);
        }
      } else {
        await this.#lifecycle(identity, environmentId, request.action);
      }
      const settled = await this.get(identity, environmentId);
      await this.#database
        .updateTable("development_environment_operations")
        .set({ result_state: settled.state })
        .where("tenant_id", "=", identity.tenantId)
        .where("environment_id", "=", environmentId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirstOrThrow();
    }
    return this.get(identity, environmentId);
  }

  #baseQuery(identity: TenantRequestIdentity) {
    return this.#database
      .selectFrom("development_environments as development")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "development.tenant_id")
          .onRef("project.id", "=", "development.project_id"),
      )
      .select([
        "development.id",
        "development.project_id as projectId",
        "development.workspace_id as workspaceId",
        "project.name as workspaceName",
        "development.state",
        "development.generation",
        "development.profile_key as profileKey",
        "development.cpu_count as cpuCount",
        "development.memory_mib as memoryMiB",
        "development.system_disk_gib as systemDiskGiB",
        "development.failure_code as failureCode",
        "development.created_at as createdAt",
        "development.updated_at as updatedAt",
        "development.released_at as releasedAt",
      ])
      .where("development.tenant_id", "=", identity.tenantId)
      .where("development.owner_user_id", "=", identity.userId);
  }

  async #provision(identity: TenantRequestIdentity, environmentId: string): Promise<void> {
    const descriptor = await this.#descriptor(identity, environmentId);
    await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      projectId: descriptor.projectId,
      workspaceId: descriptor.workspaceId,
      generation: descriptor.generation,
      profileKey: descriptor.profileKey,
      environment: descriptor.environment,
      workspaceSeed: descriptor.workspaceSeed,
    });
  }

  async #lifecycle(
    identity: TenantRequestIdentity,
    environmentId: string,
    action: "pause" | "resume" | "release",
  ): Promise<void> {
    const descriptor = await this.#descriptor(identity, environmentId);
    await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      action,
    });
  }

  async #descriptor(identity: TenantRequestIdentity, environmentId: string) {
    const row = await this.#database
      .selectFrom("development_environments as development")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "development.tenant_id")
          .onRef("workspace.id", "=", "development.workspace_id"),
      )
      .innerJoin("sandbox_domains as domain", "domain.id", "development.sandbox_domain_id")
      .innerJoin("environment_versions as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "workspace.tenant_id")
          .onRef("environment.project_id", "=", "workspace.project_id")
          .on("environment.active", "=", true),
      )
      .select([
        "workspace.project_id as projectId",
        "workspace.id as workspaceId",
        "domain.id as domainId",
        "domain.tool_broker_base_url as toolBrokerBaseUrl",
        "development.generation",
        "development.profile_key as profileKey",
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
      ])
      .where("development.tenant_id", "=", identity.tenantId)
      .where("development.owner_user_id", "=", identity.userId)
      .where("development.id", "=", environmentId)
      .where("workspace.deleted_at", "is", null)
      .where("domain.state", "=", "active")
      .executeTakeFirst();
    if (row === undefined || row.environmentState === "failed") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Development environment runtime profile is unavailable",
      );
    }
    const generation = Number(row.generation);
    const selectedProfile = profile(row.profileKey);
    return {
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      domainId: row.domainId,
      toolBrokerBaseUrl: row.toolBrokerBaseUrl,
      generation,
      profileKey: selectedProfile.key,
      environment: parseEnvironmentRuntimeSnapshot({
        environmentVersionId: row.environmentVersionId,
        versionNumber: row.environmentVersionNumber,
        profileKey: row.environmentProfileKey,
        profileVersion: row.environmentProfileVersion,
        imageRevision: row.environmentImageRevision,
        specSha256: row.environmentSpecSha256,
        recipe: row.environmentRecipe,
        recipeSha256: row.environmentRecipeSha256,
      }),
      workspaceSeed: {
        kind: "snapshot" as const,
        snapshot: encodeWorkspaceSnapshotBlob(createWorkspaceSnapshot([])),
      },
    };
  }

  async #send(
    domainId: string,
    initialBaseUrl: string,
    message: DevelopmentEnvironmentBrokerRequest,
  ): Promise<void> {
    let baseUrl = initialBaseUrl;
    for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
      const target = new URL(TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH, baseUrl);
      if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
        throw new Error("Insecure Tool Broker development environment URL was rejected");
      }
      const response = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#terminalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json()) as unknown;
      if (!response.ok) {
        const safeError =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null
            ? (body.error as { code?: unknown; message?: unknown })
            : undefined;
        const message =
          typeof safeError?.message === "string" && safeError.message.length <= 1_024
            ? safeError.message
            : "Development environment operation was rejected by Tool Broker";
        throw new ControlPlaneStoreError(
          response.status === 409 ? "conflict" : "control_plane_misconfigured",
          message,
        );
      }
      const parsed = parseDevelopmentEnvironmentBrokerResponse(body);
      if (parsed.type === "development_environment.state") return;
      baseUrl = await this.#validatedOwnerRedirect(domainId, parsed.ownerBaseUrl);
    }
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Development environment exceeded the Tool Broker redirect limit",
    );
  }

  async #validatedOwnerRedirect(domainId: string, ownerBaseUrl: string): Promise<string> {
    const normalized = new URL(ownerBaseUrl).toString();
    const owner = await this.#database
      .selectFrom("tool_broker_instances")
      .select("owner_base_url")
      .where("sandbox_domain_id", "=", domainId)
      .where("owner_base_url", "=", normalized)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", new Date())
      .executeTakeFirst();
    if (owner === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Development environment Tool Broker redirect was stale",
      );
    }
    return owner.owner_base_url;
  }
}
