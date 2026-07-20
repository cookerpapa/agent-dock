import type { Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import type { ProductionBootstrapConfig } from "./production-config.ts";
import { tenantApiTokenDigest } from "./tenant-identity.ts";

export type ProductionBootstrapResult = {
  tenantId: string;
  userId: string;
  apiCredentialId: string;
  credentialBindingId: string;
  modelProfileId: string;
};

export class ProductionBootstrapError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "ProductionBootstrapError";
    this.code = code;
  }
}

function exact(value: boolean, description: string): void {
  if (!value) {
    throw new ProductionBootstrapError(
      "bootstrap_identity_conflict",
      `Existing ${description} does not match production bootstrap configuration`,
    );
  }
}

export async function bootstrapProductionDatabase(
  database: Kysely<Database>,
  config: ProductionBootstrapConfig,
  apiToken: string,
): Promise<ProductionBootstrapResult> {
  if (config.maximumConcurrentTurns > config.maximumUnsettledTurns) {
    throw new ProductionBootstrapError(
      "bootstrap_policy_invalid",
      "Tenant concurrent-turn limit cannot exceed its unsettled-turn limit",
    );
  }
  const apiTokenSha256 = tenantApiTokenDigest(apiToken);
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("tenants")
      .values({ id: config.tenantId, slug: config.tenantSlug })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .executeTakeFirst();
    const tenant = await transaction
      .selectFrom("tenants")
      .select(["id", "slug"])
      .where("id", "=", config.tenantId)
      .executeTakeFirstOrThrow();
    exact(tenant.slug === config.tenantSlug, "tenant");

    await transaction
      .insertInto("users")
      .values({
        id: config.userId,
        tenant_id: config.tenantId,
        display_name: "AgentDock Operator",
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .executeTakeFirst();
    const user = await transaction
      .selectFrom("users")
      .select(["tenant_id", "display_name"])
      .where("id", "=", config.userId)
      .executeTakeFirstOrThrow();
    exact(
      user.tenant_id === config.tenantId && user.display_name === "AgentDock Operator",
      "operator user",
    );

    await transaction
      .insertInto("credential_bindings")
      .values({
        id: config.credentialBindingId,
        tenant_id: config.tenantId,
        provider: "agent-dock-fake",
        kind: "brokered",
        secret_ref: "broker://self-hosted/deterministic-java-repair",
        version: 1,
        status: "active",
      })
      .onConflict((conflict) => conflict.columns(["tenant_id", "id", "version"]).doNothing())
      .executeTakeFirst();
    const credential = await transaction
      .selectFrom("credential_bindings")
      .select(["provider", "kind", "secret_ref", "status"])
      .where("tenant_id", "=", config.tenantId)
      .where("id", "=", config.credentialBindingId)
      .where("version", "=", "1")
      .executeTakeFirstOrThrow();
    exact(
      credential.provider === "agent-dock-fake" &&
        credential.kind === "brokered" &&
        credential.secret_ref === "broker://self-hosted/deterministic-java-repair" &&
        credential.status === "active",
      "credential binding",
    );

    await transaction
      .insertInto("model_profiles")
      .values({
        id: config.modelProfileId,
        tenant_id: config.tenantId,
        name: config.modelProfileName,
        provider: "agent-dock-fake",
        model_id: "agent-dock-fake",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: config.credentialBindingId,
        credential_binding_version: 1,
        enabled: true,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .executeTakeFirst();
    const profile = await transaction
      .selectFrom("model_profiles")
      .select([
        "tenant_id",
        "name",
        "provider",
        "model_id",
        "default_thinking_level",
        "allowed_thinking_levels",
        "credential_binding_id",
        "credential_binding_version",
        "enabled",
      ])
      .where("id", "=", config.modelProfileId)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("model_rates")
      .values({
        tenant_id: config.tenantId,
        provider: profile.provider,
        model_id: profile.model_id,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await transaction
      .insertInto("model_routing_policies")
      .values({
        tenant_id: config.tenantId,
        model_profile_id: config.modelProfileId,
        fallback_provider: null,
        fallback_model_id: null,
        enabled: false,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const credentialVersion = Number(profile.credential_binding_version);
    const deterministicProfile =
      profile.provider === "agent-dock-fake" &&
      profile.model_id === "agent-dock-fake" &&
      credentialVersion === 1;
    const ownerConfiguredDeepSeekProfile =
      profile.provider === "deepseek" &&
      (profile.model_id === "deepseek-v4-flash" || profile.model_id === "deepseek-v4-pro") &&
      Number.isSafeInteger(credentialVersion) &&
      credentialVersion >= 2;
    exact(
      profile.tenant_id === config.tenantId &&
        profile.name === config.modelProfileName &&
        (deterministicProfile || ownerConfiguredDeepSeekProfile) &&
        profile.default_thinking_level === "off" &&
        profile.allowed_thinking_levels.length === 1 &&
        profile.allowed_thinking_levels[0] === "off" &&
        profile.credential_binding_id === config.credentialBindingId &&
        profile.enabled,
      "model profile",
    );
    if (ownerConfiguredDeepSeekProfile) {
      const activeBinding = await transaction
        .selectFrom("credential_bindings")
        .select(["provider", "kind", "secret_ref", "status"])
        .where("tenant_id", "=", config.tenantId)
        .where("id", "=", config.credentialBindingId)
        .where("version", "=", String(credentialVersion))
        .executeTakeFirst();
      exact(
        activeBinding !== undefined &&
          activeBinding.provider === "deepseek" &&
          activeBinding.kind === "api_key" &&
          activeBinding.secret_ref ===
            `sealed://tenant-model-credentials/${config.tenantId}/${config.credentialBindingId}/${String(credentialVersion)}` &&
          activeBinding.status === "active",
        "active model credential binding",
      );
      const sealedCredential = await transaction
        .selectFrom("tenant_model_credentials")
        .select("key_version")
        .where("tenant_id", "=", config.tenantId)
        .where("credential_binding_id", "=", config.credentialBindingId)
        .where("credential_binding_version", "=", String(credentialVersion))
        .executeTakeFirst();
      exact(sealedCredential !== undefined, "active model credential ciphertext");
    }

    await transaction
      .insertInto("tenant_runtime_policies")
      .values({
        tenant_id: config.tenantId,
        default_model_profile_id: config.modelProfileId,
        enabled: true,
        maximum_projects: config.maximumProjects,
        maximum_sessions: config.maximumSessions,
        maximum_unsettled_turns: config.maximumUnsettledTurns,
        maximum_concurrent_turns: config.maximumConcurrentTurns,
      })
      .onConflict((conflict) => conflict.column("tenant_id").doNothing())
      .executeTakeFirst();
    const policy = await transaction
      .selectFrom("tenant_runtime_policies")
      .select([
        "default_model_profile_id",
        "enabled",
        "maximum_projects",
        "maximum_sessions",
        "maximum_unsettled_turns",
        "maximum_concurrent_turns",
      ])
      .where("tenant_id", "=", config.tenantId)
      .executeTakeFirstOrThrow();
    exact(
      policy.default_model_profile_id === config.modelProfileId &&
        policy.enabled &&
        policy.maximum_projects === config.maximumProjects &&
        policy.maximum_sessions === config.maximumSessions &&
        policy.maximum_unsettled_turns === config.maximumUnsettledTurns &&
        policy.maximum_concurrent_turns === config.maximumConcurrentTurns,
      "tenant runtime policy",
    );

    await transaction
      .insertInto("tenant_api_credentials")
      .values({
        credential_id: config.apiCredentialId,
        tenant_id: config.tenantId,
        user_id: config.userId,
        label: "production bootstrap owner",
        role: "owner",
        secret_sha256: apiTokenSha256,
      })
      .onConflict((conflict) => conflict.column("credential_id").doNothing())
      .executeTakeFirst();
    const apiCredential = await transaction
      .selectFrom("tenant_api_credentials")
      .select(["tenant_id", "user_id", "label", "role", "secret_sha256"])
      .where("credential_id", "=", config.apiCredentialId)
      .executeTakeFirstOrThrow();
    exact(
      apiCredential.tenant_id === config.tenantId &&
        apiCredential.user_id === config.userId &&
        apiCredential.label === "production bootstrap owner" &&
        apiCredential.role === "owner" &&
        apiCredential.secret_sha256 === apiTokenSha256,
      "tenant API credential",
    );
  });
  return {
    tenantId: config.tenantId,
    userId: config.userId,
    apiCredentialId: config.apiCredentialId,
    credentialBindingId: config.credentialBindingId,
    modelProfileId: config.modelProfileId,
  };
}
