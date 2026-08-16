import type { Database, TenantApiCredentialRole } from "@pi-cloud/database";
import type {
  AuthSessionResource,
  LoginAccountRequest,
  RegisterAccountRequest,
  TenantIdentityResource,
} from "@pi-cloud/protocol";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import {
  createPrivateTenant,
  TenantAdministrationError,
  type PrivateTenantInitialModel,
  type TenantQuotaConfiguration,
} from "./tenant-administration.ts";
import type { TenantApiAuthenticator, TenantRequestIdentity } from "./tenant-identity.ts";

export const WEB_SESSION_COOKIE_NAME = "pi_cloud_session";
const SESSION_SECRET_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1_024 * 1_024;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const MAXIMUM_ACTIVE_SESSIONS = 10;
const SESSION_PATTERN =
  /^ads_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;
const DUMMY_PASSWORD_SALT = Buffer.alloc(PASSWORD_SALT_BYTES, 0x5a).toString("base64url");
const DUMMY_PASSWORD_HASH = Buffer.alloc(PASSWORD_HASH_BYTES, 0xa5);

export type WebAuthenticationOptions = {
  database: Kysely<Database>;
  enabled: boolean;
  maximumTenants: number;
  tenantQuotas: TenantQuotaConfiguration;
  initialModel?:
    | PrivateTenantInitialModel
    | (() =>
        PrivateTenantInitialModel | undefined | Promise<PrivateTenantInitialModel | undefined>);
  secureCookie?: boolean;
  platformOperatorTenantId?: string;
  sessionTtlMs?: number;
  idGenerator?: () => string;
  randomBytes?: (size: number) => Buffer;
  clock?: () => Date;
};

export type WebAuthenticationConfiguration = Omit<WebAuthenticationOptions, "database">;

export type IssuedWebSession = Readonly<{
  resource: AuthSessionResource;
  token: string;
}>;

export class WebAuthenticationError extends Error {
  readonly code:
    | "registration_disabled"
    | "username_unavailable"
    | "registration_capacity_reached"
    | "invalid_credentials"
    | "session_unavailable";

  constructor(code: WebAuthenticationError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "WebAuthenticationError";
    this.code = code;
  }
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function accountTenantSlug(username: string): string {
  const readable = username.replace(/[._]+/g, "-").replace(/-+/g, "-").slice(0, 46);
  return `u-${readable}-${sha256(username).slice(0, 8)}`;
}

function derivePassword(
  password: string,
  salt: string,
  parameters: { n: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    scrypt(
      password,
      salt,
      PASSWORD_HASH_BYTES,
      { N: parameters.n, r: parameters.r, p: parameters.p, maxmem: SCRYPT_MAX_MEMORY },
      (error, derivedKey) => {
        if (error) rejectPromise(error);
        else resolvePromise(derivedKey);
      },
    );
  });
}

function sessionToken(sessionId: string, secret: Buffer): string {
  if (secret.length !== SESSION_SECRET_BYTES) {
    throw new TypeError("Web session secret generator returned an invalid value");
  }
  return `ads_${sessionId}.${secret.toString("base64url")}`;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new WebAuthenticationError("session_unavailable", "Web session metadata is invalid");
  }
  return parsed.toISOString();
}

function identityResource(
  identity: TenantRequestIdentity,
  platformOperatorTenantId: string | undefined,
): TenantIdentityResource {
  return {
    tenantId: identity.tenantId,
    tenantSlug: identity.tenantSlug,
    userId: identity.userId,
    displayName: identity.displayName,
    role: identity.role,
    platformAdministrator:
      identity.role === "owner" &&
      platformOperatorTenantId !== undefined &&
      identity.tenantId === platformOperatorTenantId,
  };
}

function parseSessionCandidate(value: string): {
  sessionId?: string;
  digest: Buffer;
  bounded: boolean;
} {
  const bounded = value.length >= 84 && value.length <= 256 && !/[\r\n\0]/.test(value);
  const match = bounded ? SESSION_PATTERN.exec(value) : null;
  return {
    ...(match === null ? {} : { sessionId: match[1]!.toLowerCase() }),
    digest: createHash("sha256").update(value, "utf8").digest(),
    bounded,
  };
}

function digestBuffer(value: string | undefined): Buffer {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) return Buffer.alloc(32);
  return Buffer.from(value, "hex");
}

export function readWebSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 8_192 || /[\r\n\0]/.test(header)) return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(WEB_SESSION_COOKIE_NAME.length + 1));
  if (values.length !== 1 || !SESSION_PATTERN.test(values[0]!)) return undefined;
  return values[0];
}

export function createWebSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  if (!SESSION_PATTERN.test(token)) throw new TypeError("Web session token is invalid");
  const maxAge = Math.max(0, Math.floor((expiresAt.valueOf() - Date.now()) / 1_000));
  return `${WEB_SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}${secure ? "; Secure" : ""}`;
}

export function clearWebSessionCookie(secure: boolean): string {
  return `${WEB_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export class WebAuthenticationService implements TenantApiAuthenticator {
  readonly #options: WebAuthenticationOptions;
  readonly #sessionTtlMs: number;

  constructor(options: WebAuthenticationOptions) {
    this.#options = options;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(this.#sessionTtlMs) ||
      this.#sessionTtlMs < 60_000 ||
      this.#sessionTtlMs > 365 * 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError("Web session TTL is invalid");
    }
  }

  get secureCookie(): boolean {
    return this.#options.secureCookie ?? false;
  }

  async register(request: RegisterAccountRequest): Promise<IssuedWebSession> {
    if (!this.#options.enabled) {
      throw new WebAuthenticationError(
        "registration_disabled",
        "Account registration is not enabled",
      );
    }
    const salt = (this.#options.randomBytes ?? randomBytes)(PASSWORD_SALT_BYTES);
    if (!Buffer.isBuffer(salt) || salt.length !== PASSWORD_SALT_BYTES) {
      throw new WebAuthenticationError(
        "session_unavailable",
        "Password credential generation failed",
      );
    }
    const passwordHash = await derivePassword(request.password, salt.toString("base64url"), {
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    const configuredInitialModel = this.#options.initialModel;
    const initialModel =
      typeof configuredInitialModel === "function"
        ? await configuredInitialModel()
        : configuredInitialModel;
    try {
      const created = await createPrivateTenant(this.#options.database, {
        slug: accountTenantSlug(request.username),
        ownerDisplayName: request.displayName,
        ownerCredentialLabel: "web account owner",
        quotas: this.#options.tenantQuotas,
        maximumTenants: this.#options.maximumTenants,
        ...(initialModel === undefined ? {} : { initialModel }),
        webAccount: {
          username: request.username,
          role: "owner",
          passwordSalt: salt.toString("base64url"),
          passwordHash: passwordHash.toString("base64url"),
          scryptN: SCRYPT_N,
          scryptR: SCRYPT_R,
          scryptP: SCRYPT_P,
        },
        ...(this.#options.idGenerator === undefined
          ? {}
          : { idGenerator: this.#options.idGenerator }),
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      });
      return this.#issue({
        credentialId: created.credential.credentialId,
        tenantId: created.tenantId,
        tenantSlug: created.tenantSlug,
        userId: created.ownerUserId,
        displayName: request.displayName,
        role: "owner",
        defaultModelProfileId: created.defaultModelProfileId,
      });
    } catch (error: unknown) {
      if (error instanceof TenantAdministrationError) {
        if (error.code === "tenant_conflict") {
          throw new WebAuthenticationError("username_unavailable", "Username is unavailable");
        }
        if (error.code === "tenant_capacity_reached") {
          throw new WebAuthenticationError(
            "registration_capacity_reached",
            "Account registration capacity has been reached",
          );
        }
      }
      throw error;
    }
  }

  async login(request: LoginAccountRequest): Promise<IssuedWebSession> {
    const row = await this.#options.database
      .selectFrom("user_password_credentials as credential")
      .innerJoin("users as user_row", (join) =>
        join
          .onRef("user_row.tenant_id", "=", "credential.tenant_id")
          .onRef("user_row.id", "=", "credential.user_id"),
      )
      .innerJoin("tenants as tenant", "tenant.id", "credential.tenant_id")
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "credential.tenant_id")
      .select([
        "credential.username",
        "credential.tenant_id as tenantId",
        "credential.user_id as userId",
        "credential.role",
        "credential.password_salt as passwordSalt",
        "credential.password_hash as passwordHash",
        "credential.scrypt_n as scryptN",
        "credential.scrypt_r as scryptR",
        "credential.scrypt_p as scryptP",
        "user_row.display_name as displayName",
        "tenant.slug as tenantSlug",
        "policy.default_model_profile_id as defaultModelProfileId",
        "policy.enabled",
      ])
      .where("credential.username", "=", request.username)
      .executeTakeFirst();
    const salt = row?.passwordSalt ?? DUMMY_PASSWORD_SALT;
    const candidate = await derivePassword(request.password, salt, {
      n: row?.scryptN ?? SCRYPT_N,
      r: row?.scryptR ?? SCRYPT_R,
      p: row?.scryptP ?? SCRYPT_P,
    });
    const expected =
      row === undefined || !/^[A-Za-z0-9_-]{43}$/.test(row.passwordHash)
        ? DUMMY_PASSWORD_HASH
        : Buffer.from(row.passwordHash, "base64url");
    if (row === undefined || !row.enabled || !timingSafeEqual(candidate, expected)) {
      throw new WebAuthenticationError("invalid_credentials", "Username or password is incorrect");
    }
    return this.#issue({
      credentialId: row.userId,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      defaultModelProfileId: row.defaultModelProfileId,
    });
  }

  async authenticate(token: string): Promise<TenantRequestIdentity | undefined> {
    const candidate = parseSessionCandidate(token);
    const row = await this.#options.database
      .selectFrom("web_sessions as session")
      .innerJoin("users as user_row", (join) =>
        join
          .onRef("user_row.tenant_id", "=", "session.tenant_id")
          .onRef("user_row.id", "=", "session.user_id"),
      )
      .innerJoin("tenants as tenant", "tenant.id", "session.tenant_id")
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "session.tenant_id")
      .select([
        "session.session_id as sessionId",
        "session.tenant_id as tenantId",
        "session.user_id as userId",
        "session.role",
        "session.secret_sha256 as secretSha256",
        "session.expires_at as expiresAt",
        "session.revoked_at as revokedAt",
        "user_row.display_name as displayName",
        "tenant.slug as tenantSlug",
        "policy.default_model_profile_id as defaultModelProfileId",
        "policy.enabled",
      ])
      .where("session.session_id", "=", candidate.sessionId ?? randomUUID())
      .executeTakeFirst();
    const now = validDate((this.#options.clock ?? (() => new Date()))(), "web session clock");
    const expiresAt = row === undefined ? undefined : new Date(row.expiresAt);
    if (
      !candidate.bounded ||
      row === undefined ||
      !timingSafeEqual(candidate.digest, digestBuffer(row.secretSha256)) ||
      row.revokedAt !== null ||
      !row.enabled ||
      expiresAt === undefined ||
      !Number.isFinite(expiresAt.valueOf()) ||
      expiresAt <= now
    ) {
      return undefined;
    }
    const staleBoundary = new Date(now.valueOf() - LAST_USED_WRITE_INTERVAL_MS);
    await this.#options.database
      .updateTable("web_sessions")
      .set({ last_used_at: now })
      .where("session_id", "=", row.sessionId)
      .where((expression) =>
        expression.or([
          expression("last_used_at", "is", null),
          expression("last_used_at", "<", staleBoundary),
        ]),
      )
      .executeTakeFirst()
      .catch(() => undefined);
    return {
      credentialId: row.sessionId,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      defaultModelProfileId: row.defaultModelProfileId,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const candidate = parseSessionCandidate(token);
    if (candidate.sessionId === undefined) return;
    const now = validDate((this.#options.clock ?? (() => new Date()))(), "web session clock");
    await this.#options.database
      .updateTable("web_sessions")
      .set({ revoked_at: now })
      .where("session_id", "=", candidate.sessionId)
      .where("secret_sha256", "=", candidate.digest.toString("hex"))
      .where("revoked_at", "is", null)
      .executeTakeFirst();
  }

  cookie(issued: IssuedWebSession): string {
    return createWebSessionCookie(
      issued.token,
      new Date(issued.resource.expiresAt),
      this.secureCookie,
    );
  }

  clearCookie(): string {
    return clearWebSessionCookie(this.secureCookie);
  }

  async #issue(identity: TenantRequestIdentity): Promise<IssuedWebSession> {
    const now = validDate((this.#options.clock ?? (() => new Date()))(), "web session clock");
    const expiresAt = new Date(now.valueOf() + this.#sessionTtlMs);
    const sessionId = (this.#options.idGenerator ?? randomUUID)();
    const secret = (this.#options.randomBytes ?? randomBytes)(SESSION_SECRET_BYTES);
    const token = sessionToken(sessionId, secret);
    await this.#options.database.transaction().execute(async (transaction) => {
      const active = await transaction
        .selectFrom("web_sessions")
        .select("session_id")
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .orderBy("created_at", "desc")
        .execute();
      const surplus = active.slice(MAXIMUM_ACTIVE_SESSIONS - 1);
      if (surplus.length > 0) {
        await transaction
          .updateTable("web_sessions")
          .set({ revoked_at: now })
          .where(
            "session_id",
            "in",
            surplus.map((entry) => entry.session_id),
          )
          .execute();
      }
      await transaction
        .insertInto("web_sessions")
        .values({
          session_id: sessionId,
          tenant_id: identity.tenantId,
          user_id: identity.userId,
          role: identity.role as TenantApiCredentialRole,
          secret_sha256: sha256(token),
          created_at: now,
          expires_at: expiresAt,
          revoked_at: null,
          last_used_at: null,
        })
        .executeTakeFirstOrThrow();
    });
    return {
      token,
      resource: {
        identity: identityResource(identity, this.#options.platformOperatorTenantId),
        expiresAt: timestamp(expiresAt),
      },
    };
  }
}
