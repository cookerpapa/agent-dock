import type { Database } from "@agent-dock/database";
import type {
  ModelConfigurationResource,
  ReplaceModelConfigurationRequest,
} from "@agent-dock/protocol";
import type { Kysely } from "kysely";
import {
  TenantModelCredentialVault,
  tenantModelCredentialDigest,
} from "./model-credential-runtime.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

export class TenantModelConfigurationError extends Error {
  readonly code: "authorization_denied" | "model_configuration_unavailable";

  constructor(code: TenantModelConfigurationError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantModelConfigurationError";
    this.code = code;
  }
}

export type TenantModelConfigurationServiceOptions = {
  database: Kysely<Database>;
  vault?: TenantModelCredentialVault;
  clock?: () => Date;
};

function positiveVersion(value: string | number | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TenantModelConfigurationError(
      "model_configuration_unavailable",
      "Persisted model credential version is invalid",
    );
  }
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TenantModelConfigurationError(
      "model_configuration_unavailable",
      "Persisted model configuration timestamp is invalid",
    );
  }
  return parsed.toISOString();
}

function validClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("Tenant model configuration clock must return a valid Date");
  }
  return now;
}

export class TenantModelConfigurationService {
  readonly #database: Kysely<Database>;
  readonly #vault: TenantModelCredentialVault | undefined;
  readonly #clock: () => Date;

  constructor(options: TenantModelConfigurationServiceOptions) {
    this.#database = options.database;
    this.#vault = options.vault;
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(identity: TenantRequestIdentity): Promise<ModelConfigurationResource> {
    const row = await this.#database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .innerJoin("credential_bindings as binding", (join) =>
        join
          .onRef("binding.tenant_id", "=", "profile.tenant_id")
          .onRef("binding.id", "=", "profile.credential_binding_id")
          .onRef("binding.version", "=", "profile.credential_binding_version"),
      )
      .select([
        "profile.provider",
        "profile.model_id as modelId",
        "profile.credential_binding_version as credentialVersion",
        "profile.enabled",
        "profile.updated_at as updatedAt",
        "binding.status as credentialStatus",
      ])
      .where("policy.tenant_id", "=", identity.tenantId)
      .executeTakeFirst();
    if (row === undefined || !row.enabled || row.credentialStatus !== "active") {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Tenant model configuration is unavailable",
      );
    }
    const credentialVersion = positiveVersion(row.credentialVersion);
    const updatedAt = timestamp(row.updatedAt);
    if (row.provider === "agent-dock-fake" && row.modelId === "agent-dock-fake") {
      return {
        mode: "deterministic",
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        configured: false,
        credentialVersion,
        updatedAt,
      };
    }
    if (
      row.provider === "deepseek" &&
      (row.modelId === "deepseek-v4-flash" || row.modelId === "deepseek-v4-pro")
    ) {
      return {
        mode: "real",
        provider: "deepseek",
        modelId: row.modelId,
        configured: true,
        credentialVersion,
        updatedAt,
      };
    }
    throw new TenantModelConfigurationError(
      "model_configuration_unavailable",
      "Tenant model configuration is unsupported",
    );
  }

  async replace(
    identity: TenantRequestIdentity,
    request: ReplaceModelConfigurationRequest,
  ): Promise<ModelConfigurationResource> {
    if (identity.role !== "owner") {
      throw new TenantModelConfigurationError(
        "authorization_denied",
        "Only a tenant owner can replace model credentials",
      );
    }
    const now = validClock(this.#clock);
    const digest = tenantModelCredentialDigest(request.apiKey);
    return this.#database.transaction().execute(async (transaction) => {
      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select(["default_model_profile_id as profileId", "enabled"])
        .where("tenant_id", "=", identity.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (policy === undefined || !policy.enabled) {
        throw new TenantModelConfigurationError(
          "model_configuration_unavailable",
          "Tenant model configuration is unavailable",
        );
      }
      const profile = await transaction
        .selectFrom("model_profiles")
        .select([
          "id",
          "provider",
          "model_id as modelId",
          "credential_binding_id as credentialBindingId",
          "credential_binding_version as credentialVersion",
          "updated_at as updatedAt",
          "enabled",
        ])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", policy.profileId)
        .executeTakeFirst();
      if (profile === undefined || !profile.enabled) {
        throw new TenantModelConfigurationError(
          "model_configuration_unavailable",
          "Tenant model configuration is unavailable",
        );
      }
      const currentVersion = positiveVersion(profile.credentialVersion);
      const currentSecret =
        profile.provider === "deepseek"
          ? await transaction
              .selectFrom("tenant_model_credentials")
              .select("secret_sha256 as secretSha256")
              .where("tenant_id", "=", identity.tenantId)
              .where("credential_binding_id", "=", profile.credentialBindingId)
              .where("credential_binding_version", "=", String(currentVersion))
              .executeTakeFirst()
          : undefined;

      if (currentSecret?.secretSha256 === digest) {
        const changedModel = profile.modelId !== request.modelId;
        if (changedModel) {
          await transaction
            .updateTable("model_profiles")
            .set({ model_id: request.modelId, updated_at: now })
            .where("tenant_id", "=", identity.tenantId)
            .where("id", "=", profile.id)
            .executeTakeFirstOrThrow();
        }
        return {
          mode: "real",
          provider: "deepseek",
          modelId: request.modelId,
          configured: true,
          credentialVersion: currentVersion,
          updatedAt: changedModel ? now.toISOString() : timestamp(profile.updatedAt),
        };
      }

      const maximum = await transaction
        .selectFrom("credential_bindings")
        .select((expression) => expression.fn.max("version").as("maximumVersion"))
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", profile.credentialBindingId)
        .executeTakeFirstOrThrow();
      const nextVersion = positiveVersion(maximum.maximumVersion ?? currentVersion) + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw new TenantModelConfigurationError(
          "model_configuration_unavailable",
          "Model credential version capacity is exhausted",
        );
      }
      const credentialIdentity = {
        tenantId: identity.tenantId,
        credentialBindingId: profile.credentialBindingId,
        credentialBindingVersion: nextVersion,
        provider: "deepseek",
      } as const;
      if (this.#vault === undefined) {
        throw new TenantModelConfigurationError(
          "model_configuration_unavailable",
          "Encrypted model credential storage is unavailable",
        );
      }
      const sealed = this.#vault.seal(credentialIdentity, request.apiKey);
      await transaction
        .insertInto("credential_bindings")
        .values({
          id: profile.credentialBindingId,
          tenant_id: identity.tenantId,
          provider: "deepseek",
          kind: "api_key",
          secret_ref: `sealed://tenant-model-credentials/${identity.tenantId}/${profile.credentialBindingId}/${String(nextVersion)}`,
          version: nextVersion,
          status: "active",
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("tenant_model_credentials")
        .values({
          tenant_id: identity.tenantId,
          credential_binding_id: profile.credentialBindingId,
          credential_binding_version: nextVersion,
          key_version: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          auth_tag: sealed.authTag,
          secret_sha256: sealed.secretSha256,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("model_profiles")
        .set({
          provider: "deepseek",
          model_id: request.modelId,
          default_thinking_level: "off",
          allowed_thinking_levels: ["off"],
          credential_binding_id: profile.credentialBindingId,
          credential_binding_version: nextVersion,
          enabled: true,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", profile.id)
        .executeTakeFirstOrThrow();
      return {
        mode: "real",
        provider: "deepseek",
        modelId: request.modelId,
        configured: true,
        credentialVersion: nextVersion,
        updatedAt: now.toISOString(),
      };
    });
  }
}
