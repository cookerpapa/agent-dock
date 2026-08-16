import type { Database } from "@pi-cloud/database";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";

const MASTER_KEY_VERSION = 1;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export type TenantModelCredentialIdentity = Readonly<{
  tenantId: string;
  credentialBindingId: string;
  credentialBindingVersion: number;
  provider: string;
}>;

export type SealedTenantModelCredential = Readonly<{
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  secretSha256: string;
}>;

export type ResolvedTenantModelCredential = TenantModelCredentialIdentity &
  Readonly<{
    secret: string;
  }>;

export class TenantModelCredentialError extends Error {
  readonly code:
    | "invalid_master_key"
    | "invalid_credential_identity"
    | "invalid_credential_secret"
    | "credential_unavailable"
    | "credential_integrity_failed";

  constructor(code: TenantModelCredentialError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantModelCredentialError";
    this.code = code;
  }
}

function positiveVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TenantModelCredentialError(
      "invalid_credential_identity",
      "Model credential version is invalid",
    );
  }
  return value;
}

function boundedIdentity(value: string, name: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TenantModelCredentialError("invalid_credential_identity", `${name} is invalid`);
  }
  return value;
}

function associatedData(identity: TenantModelCredentialIdentity, keyVersion: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: "pi-cloud.tenant-model-credential.v1",
      tenantId: boundedIdentity(identity.tenantId, "Tenant ID"),
      credentialBindingId: boundedIdentity(identity.credentialBindingId, "Credential binding ID"),
      credentialBindingVersion: positiveVersion(identity.credentialBindingVersion),
      provider: boundedIdentity(identity.provider, "Provider"),
      keyVersion: positiveVersion(keyVersion),
    }),
    "utf8",
  );
}

function credentialSecret(value: string): string {
  if (
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    /[\r\n\0]/.test(value)
  ) {
    throw new TenantModelCredentialError(
      "invalid_credential_secret",
      "Model credential secret is invalid",
    );
  }
  return value;
}

function parseMasterKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TenantModelCredentialError(
      "invalid_master_key",
      "Model credential master key is invalid",
    );
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new TenantModelCredentialError(
      "invalid_master_key",
      "Model credential master key is invalid",
    );
  }
  return key;
}

function sealedField(value: string, pattern: RegExp): Buffer {
  if (!pattern.test(value)) {
    throw new TenantModelCredentialError(
      "credential_integrity_failed",
      "Encrypted model credential is invalid",
    );
  }
  return Buffer.from(value, "base64url");
}

export function tenantModelCredentialDigest(secret: string): string {
  return createHash("sha256").update(credentialSecret(secret), "utf8").digest("hex");
}

export class TenantModelCredentialVault {
  readonly #masterKey: Buffer;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(masterKey: string, options: { randomBytes?: (size: number) => Buffer } = {}) {
    this.#masterKey = parseMasterKey(masterKey);
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  seal(identity: TenantModelCredentialIdentity, secretValue: string): SealedTenantModelCredential {
    const secret = credentialSecret(secretValue);
    const nonce = this.#randomBytes(AES_GCM_NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.length !== AES_GCM_NONCE_BYTES) {
      throw new TenantModelCredentialError(
        "credential_integrity_failed",
        "Model credential nonce generation failed",
      );
    }
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(associatedData(identity, MASTER_KEY_VERSION));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      keyVersion: MASTER_KEY_VERSION,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      secretSha256: tenantModelCredentialDigest(secret),
    };
  }

  open(identity: TenantModelCredentialIdentity, sealed: SealedTenantModelCredential): string {
    if (sealed.keyVersion !== MASTER_KEY_VERSION) {
      throw new TenantModelCredentialError(
        "credential_integrity_failed",
        "Encrypted model credential key version is unavailable",
      );
    }
    const nonce = sealedField(sealed.nonce, /^[A-Za-z0-9_-]{16}$/);
    const ciphertext = sealedField(sealed.ciphertext, /^[A-Za-z0-9_-]{16,16384}$/);
    const authTag = sealedField(sealed.authTag, /^[A-Za-z0-9_-]{22}$/);
    if (nonce.length !== AES_GCM_NONCE_BYTES || authTag.length !== AES_GCM_TAG_BYTES) {
      throw new TenantModelCredentialError(
        "credential_integrity_failed",
        "Encrypted model credential is invalid",
      );
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#masterKey, nonce, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(associatedData(identity, sealed.keyVersion));
      decipher.setAuthTag(authTag);
      const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
      if (tenantModelCredentialDigest(secret) !== sealed.secretSha256) {
        throw new Error("digest mismatch");
      }
      return credentialSecret(secret);
    } catch {
      throw new TenantModelCredentialError(
        "credential_integrity_failed",
        "Encrypted model credential could not be authenticated",
      );
    }
  }
}

export class PostgresTenantModelCredentialResolver {
  readonly #database: Kysely<Database>;
  readonly #vault: TenantModelCredentialVault;

  constructor(options: { database: Kysely<Database>; vault: TenantModelCredentialVault }) {
    this.#database = options.database;
    this.#vault = options.vault;
  }

  async resolve(identity: TenantModelCredentialIdentity): Promise<ResolvedTenantModelCredential> {
    const row = await this.#database
      .selectFrom("credential_bindings as binding")
      .innerJoin("tenant_model_credentials as credential", (join) =>
        join
          .onRef("credential.tenant_id", "=", "binding.tenant_id")
          .onRef("credential.credential_binding_id", "=", "binding.id")
          .onRef("credential.credential_binding_version", "=", "binding.version"),
      )
      .select([
        "binding.provider",
        "binding.status",
        "credential.key_version as keyVersion",
        "credential.nonce",
        "credential.ciphertext",
        "credential.auth_tag as authTag",
        "credential.secret_sha256 as secretSha256",
      ])
      .where("binding.tenant_id", "=", identity.tenantId)
      .where("binding.id", "=", identity.credentialBindingId)
      .where("binding.version", "=", String(identity.credentialBindingVersion))
      .executeTakeFirst();
    if (row === undefined || row.status !== "active" || row.provider !== identity.provider) {
      throw new TenantModelCredentialError(
        "credential_unavailable",
        "Model credential binding is unavailable",
      );
    }
    const secret = this.#vault.open(identity, {
      keyVersion: row.keyVersion,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.authTag,
      secretSha256: row.secretSha256,
    });
    return { ...identity, secret };
  }
}
