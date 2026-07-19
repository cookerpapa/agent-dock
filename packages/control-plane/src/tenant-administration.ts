import type { Database, TenantApiCredentialRole } from "@agent-dock/database";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import {
  generateTenantApiCredential,
  issueTenantApiCredential,
  revokeTenantApiCredential,
  type GeneratedTenantApiCredential,
} from "./tenant-identity.ts";

export type TenantQuotaConfiguration = Readonly<{
  maximumProjects: number;
  maximumSessions: number;
  maximumUnsettledTurns: number;
  maximumConcurrentTurns: number;
}>;

export type CreatePrivateTenantOptions = {
  slug: string;
  ownerDisplayName: string;
  ownerCredentialLabel?: string;
  quotas?: Partial<TenantQuotaConfiguration>;
  idGenerator?: () => string;
  randomSecret?: () => string;
  clock?: () => Date;
};

export type CreatedPrivateTenant = Readonly<{
  tenantId: string;
  tenantSlug: string;
  ownerUserId: string;
  credentialBindingId: string;
  defaultModelProfileId: string;
  quotas: TenantQuotaConfiguration;
  credential: GeneratedTenantApiCredential;
}>;

export type TenantCredentialMetadata = Readonly<{
  credentialId: string;
  userId: string;
  displayName: string;
  label: string;
  role: TenantApiCredentialRole;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}>;

const DEFAULT_QUOTAS: TenantQuotaConfiguration = {
  maximumProjects: 100,
  maximumSessions: 1_000,
  maximumUnsettledTurns: 100,
  maximumConcurrentTurns: 1,
};

export class TenantAdministrationError extends Error {
  readonly code: "tenant_conflict" | "tenant_not_found" | "user_not_found";

  constructor(code: TenantAdministrationError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantAdministrationError";
    this.code = code;
  }
}

function validUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function tenantSlug(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new TypeError("tenant slug must contain 1-64 lowercase letters, digits, or hyphens");
  }
  return value;
}

function boundedText(value: string, name: string, maximum: number): string {
  if (
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} must contain 1-${String(maximum)} safe bytes`);
  }
  return value;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${String(maximum)}`);
  }
  return value;
}

function quotaConfiguration(
  value: Partial<TenantQuotaConfiguration> = {},
): TenantQuotaConfiguration {
  const quotas = {
    maximumProjects: positiveInteger(
      value.maximumProjects ?? DEFAULT_QUOTAS.maximumProjects,
      "maximumProjects",
      1_000_000,
    ),
    maximumSessions: positiveInteger(
      value.maximumSessions ?? DEFAULT_QUOTAS.maximumSessions,
      "maximumSessions",
      1_000_000,
    ),
    maximumUnsettledTurns: positiveInteger(
      value.maximumUnsettledTurns ?? DEFAULT_QUOTAS.maximumUnsettledTurns,
      "maximumUnsettledTurns",
      1_000_000,
    ),
    maximumConcurrentTurns: positiveInteger(
      value.maximumConcurrentTurns ?? DEFAULT_QUOTAS.maximumConcurrentTurns,
      "maximumConcurrentTurns",
      256,
    ),
  };
  if (quotas.maximumConcurrentTurns > quotas.maximumUnsettledTurns) {
    throw new TypeError("maximumConcurrentTurns cannot exceed maximumUnsettledTurns");
  }
  return quotas;
}

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("Persisted credential timestamp is invalid");
  return parsed.toISOString();
}

async function resolveTenantId(database: Kysely<Database>, tenant: string): Promise<string> {
  const row = /^[0-9a-f-]{36}$/i.test(tenant)
    ? await database
        .selectFrom("tenants")
        .select("id")
        .where("id", "=", validUuid(tenant, "tenant"))
        .executeTakeFirst()
    : await database
        .selectFrom("tenants")
        .select("id")
        .where("slug", "=", tenantSlug(tenant))
        .executeTakeFirst();
  if (row === undefined) {
    throw new TenantAdministrationError("tenant_not_found", "Tenant was not found");
  }
  return row.id;
}

export async function createPrivateTenant(
  database: Kysely<Database>,
  options: CreatePrivateTenantOptions,
): Promise<CreatedPrivateTenant> {
  const slug = tenantSlug(options.slug);
  const displayName = boundedText(options.ownerDisplayName, "ownerDisplayName", 256);
  const label = boundedText(
    options.ownerCredentialLabel ?? "initial owner",
    "credential label",
    128,
  );
  const quotas = quotaConfiguration(options.quotas);
  const idGenerator = options.idGenerator ?? randomUUID;
  const tenantId = validUuid(idGenerator(), "generated tenantId");
  const ownerUserId = validUuid(idGenerator(), "generated ownerUserId");
  const credentialBindingId = validUuid(idGenerator(), "generated credentialBindingId");
  const defaultModelProfileId = validUuid(idGenerator(), "generated defaultModelProfileId");
  const apiCredentialId = validUuid(idGenerator(), "generated apiCredentialId");
  const credential = generateTenantApiCredential(apiCredentialId, options.randomSecret?.());
  const now = options.clock?.() ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("tenant administration clock must return a valid Date");
  }

  const existing = await database
    .selectFrom("tenants")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (existing !== undefined) {
    throw new TenantAdministrationError("tenant_conflict", "Tenant identity already exists");
  }

  try {
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("tenants")
        .values({ id: tenantId, slug, created_at: now })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("users")
        .values({
          id: ownerUserId,
          tenant_id: tenantId,
          display_name: displayName,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("credential_bindings")
        .values({
          id: credentialBindingId,
          tenant_id: tenantId,
          provider: "agent-dock-fake",
          kind: "brokered",
          secret_ref: `broker://self-hosted/${tenantId}/deterministic-java-repair`,
          version: 1,
          status: "active",
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("model_profiles")
        .values({
          id: defaultModelProfileId,
          tenant_id: tenantId,
          name: "deterministic-java-repair",
          provider: "agent-dock-fake",
          model_id: "agent-dock-fake",
          default_thinking_level: "off",
          allowed_thinking_levels: ["off"],
          credential_binding_id: credentialBindingId,
          credential_binding_version: 1,
          enabled: true,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("tenant_runtime_policies")
        .values({
          tenant_id: tenantId,
          default_model_profile_id: defaultModelProfileId,
          enabled: true,
          maximum_projects: quotas.maximumProjects,
          maximum_sessions: quotas.maximumSessions,
          maximum_unsettled_turns: quotas.maximumUnsettledTurns,
          maximum_concurrent_turns: quotas.maximumConcurrentTurns,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("tenant_api_credentials")
        .values({
          credential_id: credential.credentialId,
          tenant_id: tenantId,
          user_id: ownerUserId,
          label,
          role: "owner",
          secret_sha256: credential.secretSha256,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
    });
  } catch (error: unknown) {
    const code = (error as { code?: unknown })?.code;
    if (code === "23505") {
      throw new TenantAdministrationError("tenant_conflict", "Tenant identity already exists");
    }
    throw error;
  }

  return {
    tenantId,
    tenantSlug: slug,
    ownerUserId,
    credentialBindingId,
    defaultModelProfileId,
    quotas,
    credential,
  };
}

export async function issuePrivateTenantCredential(
  database: Kysely<Database>,
  options: {
    tenant: string;
    userId: string;
    label: string;
    role: TenantApiCredentialRole;
    expiresAt?: Date | null;
    credentialId?: string;
    randomSecret?: () => string;
    clock?: () => Date;
  },
): Promise<GeneratedTenantApiCredential> {
  const tenantId = await resolveTenantId(database, options.tenant);
  const userId = validUuid(options.userId, "userId");
  const user = await database
    .selectFrom("users")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user === undefined) {
    throw new TenantAdministrationError("user_not_found", "Tenant user was not found");
  }
  return issueTenantApiCredential(database, {
    tenantId,
    userId,
    label: options.label,
    role: options.role,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.credentialId === undefined ? {} : { credentialId: options.credentialId }),
    ...(options.randomSecret === undefined ? {} : { randomSecret: options.randomSecret }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export async function revokePrivateTenantCredential(
  database: Kysely<Database>,
  options: { tenant: string; credentialId: string; revokedAt?: Date },
): Promise<boolean> {
  return revokeTenantApiCredential(database, {
    tenantId: await resolveTenantId(database, options.tenant),
    credentialId: options.credentialId,
    ...(options.revokedAt === undefined ? {} : { revokedAt: options.revokedAt }),
  });
}

export async function listPrivateTenantCredentials(
  database: Kysely<Database>,
  tenant: string,
): Promise<readonly TenantCredentialMetadata[]> {
  const tenantId = await resolveTenantId(database, tenant);
  const rows = await database
    .selectFrom("tenant_api_credentials as credential")
    .innerJoin("users as user_row", (join) =>
      join
        .onRef("user_row.tenant_id", "=", "credential.tenant_id")
        .onRef("user_row.id", "=", "credential.user_id"),
    )
    .select([
      "credential.credential_id as credentialId",
      "credential.user_id as userId",
      "user_row.display_name as displayName",
      "credential.label as label",
      "credential.role as role",
      "credential.created_at as createdAt",
      "credential.expires_at as expiresAt",
      "credential.revoked_at as revokedAt",
      "credential.last_used_at as lastUsedAt",
    ])
    .where("credential.tenant_id", "=", tenantId)
    .orderBy("credential.created_at", "asc")
    .orderBy("credential.credential_id", "asc")
    .execute();
  return rows.map((row) => ({
    credentialId: row.credentialId,
    userId: row.userId,
    displayName: row.displayName,
    label: row.label,
    role: row.role,
    createdAt: isoTimestamp(row.createdAt)!,
    expiresAt: isoTimestamp(row.expiresAt),
    revokedAt: isoTimestamp(row.revokedAt),
    lastUsedAt: isoTimestamp(row.lastUsedAt),
  }));
}
