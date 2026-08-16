import type { Database } from "@pi-cloud/database";
import type {
  ModelConfigurationResource,
  ReplaceModelConfigurationRequest,
} from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";
import {
  TenantModelCredentialVault,
  tenantModelCredentialDigest,
} from "@pi-cloud/runtime-core/model-credential-runtime";
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
  platformOperatorTenantId?: string;
  platformModelSourceTenantId?: string;
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
  readonly #platformOperatorTenantId: string | undefined;
  readonly #platformModelSourceTenantId: string | undefined;

  constructor(options: TenantModelConfigurationServiceOptions) {
    this.#database = options.database;
    this.#vault = options.vault;
    this.#clock = options.clock ?? (() => new Date());
    this.#platformOperatorTenantId = options.platformOperatorTenantId;
    this.#platformModelSourceTenantId =
      options.platformModelSourceTenantId ?? options.platformOperatorTenantId;
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
    if (row.provider === "pi-cloud-fake" && row.modelId === "pi-cloud-fake") {
      return {
        mode: "deterministic",
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
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
    if (
      this.#platformOperatorTenantId !== undefined &&
      identity.tenantId !== this.#platformOperatorTenantId
    ) {
      throw new TenantModelConfigurationError(
        "authorization_denied",
        "Model configuration is managed by the platform operator",
      );
    }
    const now = validClock(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      if (
        this.#platformOperatorTenantId !== undefined &&
        this.#platformModelSourceTenantId !== undefined
      ) {
        const result = await this.#replaceForTenant(
          transaction,
          this.#platformModelSourceTenantId,
          request,
          now,
        );
        const managedTenants = await transaction
          .selectFrom("user_password_credentials")
          .select("tenant_id as tenantId")
          .distinct()
          .where("tenant_id", "!=", this.#platformModelSourceTenantId)
          .orderBy("tenant_id", "asc")
          .execute();
        for (const managedTenant of managedTenants) {
          await this.#replaceForTenant(transaction, managedTenant.tenantId, request, now);
        }
        return result;
      }
      return this.#replaceForTenant(transaction, identity.tenantId, request, now);
    });
  }

  async #replaceForTenant(
    transaction: Transaction<Database>,
    tenantId: string,
    request: ReplaceModelConfigurationRequest,
    now: Date,
  ): Promise<ModelConfigurationResource> {
    const digest = tenantModelCredentialDigest(request.apiKey);
    const policy = await transaction
      .selectFrom("tenant_runtime_policies")
      .select(["default_model_profile_id as profileId", "enabled"])
      .where("tenant_id", "=", tenantId)
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
      .where("tenant_id", "=", tenantId)
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
            .where("tenant_id", "=", tenantId)
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
          .where("tenant_id", "=", tenantId)
          .where("id", "=", profile.id)
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto("model_rates")
        .values({
          tenant_id: tenantId,
          provider: "deepseek",
          model_id: request.modelId,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
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
      .where("tenant_id", "=", tenantId)
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
      tenantId,
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
        tenant_id: tenantId,
        provider: "deepseek",
        kind: "api_key",
        secret_ref: `sealed://tenant-model-credentials/${tenantId}/${profile.credentialBindingId}/${String(nextVersion)}`,
        version: nextVersion,
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("tenant_model_credentials")
      .values({
        tenant_id: tenantId,
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
      .where("tenant_id", "=", tenantId)
      .where("id", "=", profile.id)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("model_rates")
      .values({
        tenant_id: tenantId,
        provider: "deepseek",
        model_id: request.modelId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await transaction
      .insertInto("model_routing_policies")
      .values({
        tenant_id: tenantId,
        model_profile_id: profile.id,
        fallback_provider: null,
        fallback_model_id: null,
        enabled: false,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    return {
      mode: "real",
      provider: "deepseek",
      modelId: request.modelId,
      configured: true,
      credentialVersion: nextVersion,
      updatedAt: now.toISOString(),
    };
  }
}
