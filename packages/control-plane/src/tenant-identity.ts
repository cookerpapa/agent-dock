import type { Database, TenantApiCredentialRole } from "@pi-cloud/database";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import type { FastifyRequest } from "fastify";

const TOKEN_PATTERN =
  /^pck_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43,256})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DUMMY_DIGEST = Buffer.alloc(32);
const DUMMY_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000000";
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const requestIdentities = new WeakMap<FastifyRequest, TenantRequestIdentity>();

export type TenantRequestIdentity = Readonly<{
  credentialId: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  displayName: string;
  role: TenantApiCredentialRole;
  defaultModelProfileId: string;
}>;

export type GeneratedTenantApiCredential = Readonly<{
  credentialId: string;
  token: string;
  secretSha256: string;
}>;

export type IssueTenantApiCredentialOptions = {
  tenantId: string;
  userId: string;
  label: string;
  role: TenantApiCredentialRole;
  expiresAt?: Date | null;
  credentialId?: string;
  clock?: () => Date;
  randomSecret?: () => string;
};

export interface TenantApiAuthenticator {
  authenticate(token: string): Promise<TenantRequestIdentity | undefined>;
}

export function bindTenantRequestIdentity(
  request: FastifyRequest,
  identity: TenantRequestIdentity,
): void {
  if (requestIdentities.has(request)) {
    throw new Error("Tenant request identity was already bound");
  }
  requestIdentities.set(request, Object.freeze({ ...identity }));
}

export function tenantRequestIdentity(request: FastifyRequest): TenantRequestIdentity | undefined {
  return requestIdentities.get(request);
}

function validUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

function boundedLabel(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("credential label must contain 1-128 safe bytes");
  }
  return value;
}

function validRole(value: TenantApiCredentialRole): TenantApiCredentialRole {
  if (value !== "owner" && value !== "member" && value !== "viewer") {
    throw new TypeError("credential role is invalid");
  }
  return value;
}

function tokenDigestBuffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tenantApiTokenDigest(value: string): string {
  if (!TOKEN_PATTERN.test(value)) {
    throw new TypeError("tenant API token must use the current adk credential format");
  }
  return tokenDigestBuffer(value).toString("hex");
}

export function generateTenantApiCredential(
  credentialId: string = randomUUID(),
  secret: string = randomBytes(32).toString("base64url"),
): GeneratedTenantApiCredential {
  const normalizedId = validUuid(credentialId, "credentialId");
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(secret)) {
    throw new TypeError("tenant API credential secret is invalid");
  }
  const token = `pck_${normalizedId}.${secret}`;
  return { credentialId: normalizedId, token, secretSha256: tenantApiTokenDigest(token) };
}

function parsedCredentialId(token: string): string | undefined {
  return TOKEN_PATTERN.exec(token)?.[1]?.toLowerCase();
}

function digestBuffer(value: string | undefined): Buffer {
  return value !== undefined && SHA256_PATTERN.test(value)
    ? Buffer.from(value, "hex")
    : DUMMY_DIGEST;
}

function credentialSelect() {
  return [
    "credential.credential_id as credentialId",
    "credential.tenant_id as tenantId",
    "tenant.slug as tenantSlug",
    "credential.user_id as userId",
    "user_row.display_name as displayName",
    "credential.role as role",
    "credential.secret_sha256 as secretSha256",
    "credential.expires_at as expiresAt",
    "credential.revoked_at as revokedAt",
    "policy.default_model_profile_id as defaultModelProfileId",
  ] as const;
}

export class PostgresTenantApiAuthenticator implements TenantApiAuthenticator {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async authenticate(token: string): Promise<TenantRequestIdentity | undefined> {
    const now = validDate(this.#clock(), "tenant authenticator clock");
    const credentialId = parsedCredentialId(token);
    const candidateDigest = credentialId === undefined ? DUMMY_DIGEST : tokenDigestBuffer(token);

    const row = await this.#database
      .selectFrom("tenant_api_credentials as credential")
      .innerJoin("tenants as tenant", "tenant.id", "credential.tenant_id")
      .innerJoin("users as user_row", (join) =>
        join
          .onRef("user_row.tenant_id", "=", "credential.tenant_id")
          .onRef("user_row.id", "=", "credential.user_id"),
      )
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "credential.tenant_id")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select(credentialSelect())
      .where("credential.credential_id", "=", credentialId ?? DUMMY_CREDENTIAL_ID)
      .executeTakeFirst();

    const digestMatches = timingSafeEqual(candidateDigest, digestBuffer(row?.secretSha256));
    const expiresAt =
      row?.expiresAt === null || row?.expiresAt === undefined ? undefined : new Date(row.expiresAt);
    if (
      credentialId === undefined ||
      row === undefined ||
      !digestMatches ||
      row.revokedAt !== null ||
      (expiresAt !== undefined && (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= now))
    ) {
      return undefined;
    }

    const staleUsageBoundary = new Date(now.valueOf() - LAST_USED_WRITE_INTERVAL_MS);
    // Usage metadata is intentionally best-effort. A burst of requests sharing
    // one browser credential must not turn row-update contention into an auth
    // outage after the digest and revocation checks already succeeded.
    await this.#database
      .updateTable("tenant_api_credentials")
      .set({ last_used_at: now })
      .where("credential_id", "=", row.credentialId)
      .where((expression) =>
        expression.or([
          expression("last_used_at", "is", null),
          expression("last_used_at", "<", staleUsageBoundary),
        ]),
      )
      .executeTakeFirst()
      .catch(() => undefined);

    return {
      credentialId: row.credentialId,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      defaultModelProfileId: row.defaultModelProfileId,
    };
  }
}

export async function issueTenantApiCredential(
  database: Kysely<Database>,
  options: IssueTenantApiCredentialOptions,
): Promise<GeneratedTenantApiCredential> {
  const tenantId = validUuid(options.tenantId, "tenantId");
  const userId = validUuid(options.userId, "userId");
  const now = validDate((options.clock ?? (() => new Date()))(), "credential clock");
  const expiresAt =
    options.expiresAt === null || options.expiresAt === undefined
      ? null
      : validDate(options.expiresAt, "expiresAt");
  if (expiresAt !== null && expiresAt <= now) {
    throw new TypeError("expiresAt must be in the future");
  }
  const generated = generateTenantApiCredential(options.credentialId, options.randomSecret?.());
  await database
    .insertInto("tenant_api_credentials")
    .values({
      credential_id: generated.credentialId,
      tenant_id: tenantId,
      user_id: userId,
      label: boundedLabel(options.label),
      role: validRole(options.role),
      secret_sha256: generated.secretSha256,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: null,
    })
    .executeTakeFirstOrThrow();
  return generated;
}

export async function revokeTenantApiCredential(
  database: Kysely<Database>,
  options: { tenantId: string; credentialId: string; revokedAt?: Date },
): Promise<boolean> {
  const revokedAt = validDate(options.revokedAt ?? new Date(), "revokedAt");
  const result = await database
    .updateTable("tenant_api_credentials")
    .set({ revoked_at: revokedAt })
    .where("tenant_id", "=", validUuid(options.tenantId, "tenantId"))
    .where("credential_id", "=", validUuid(options.credentialId, "credentialId"))
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
