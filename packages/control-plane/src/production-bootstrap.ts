import type { Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import type { ProductionBootstrapConfig } from "./production-config.ts";

export type ProductionBootstrapResult = {
  tenantId: string;
  userId: string;
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
): Promise<ProductionBootstrapResult> {
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
    exact(
      profile.tenant_id === config.tenantId &&
        profile.name === config.modelProfileName &&
        profile.provider === "agent-dock-fake" &&
        profile.model_id === "agent-dock-fake" &&
        profile.default_thinking_level === "off" &&
        profile.allowed_thinking_levels.length === 1 &&
        profile.allowed_thinking_levels[0] === "off" &&
        profile.credential_binding_id === config.credentialBindingId &&
        Number(profile.credential_binding_version) === 1 &&
        profile.enabled,
      "model profile",
    );
  });
  return {
    tenantId: config.tenantId,
    userId: config.userId,
    credentialBindingId: config.credentialBindingId,
    modelProfileId: config.modelProfileId,
  };
}
