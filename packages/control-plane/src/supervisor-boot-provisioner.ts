import type { Database } from "@agent-dock/database";
import {
  parseSupervisorBootProvisionRequest,
  type SupervisorBootProvisionRequest,
  type SupervisorBootProvisionResponse,
} from "@agent-dock/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";
import {
  SupervisorUpgradeAuthorizationError,
  type SupervisorUpgradeAuthorizer,
  type SupervisorUpgradeRequest,
} from "./supervisor-websocket-gateway.ts";

export const SUPERVISOR_BOOT_PROVISION_PATH = "/internal/v1/supervisor/boots";

const DEFAULT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1_024;

export type SupervisorBootProvisionerOptions = {
  database: Kysely<Database>;
  allowedSupervisorIdPrefix: string;
  managementBaseUrlTemplates: readonly string[];
  maximumCapacity: number;
  enrollmentToken: string;
  credentialTtlMs?: number;
  clock?: () => Date;
};

export type SupervisorProvisioningGatewayOptions = {
  provisioner: SupervisorBootProvisioner;
  path?: string;
  maxBodyBytes?: number;
};

export type PostgresSupervisorCredentialAuthorizerOptions = {
  database: Kysely<Database>;
  clock?: () => Date;
};

type CredentialRow = {
  credential_id: string;
  credential_sha256: string;
  provision_request_id: string;
  sandbox_id: string;
  supervisor_id: string;
  boot_id: string;
  expires_at: Date;
  revoked_at: Date | null;
};

export class SupervisorBootProvisionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, statusCode: number, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorBootProvisionError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Supervisor provisioner clock must return a valid Date");
  }
  return value;
}

function supervisorIdPrefix(value: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62})-$/.test(value)) {
    throw new TypeError(
      "allowedSupervisorIdPrefix must be a lowercase DNS-label prefix ending in a hyphen",
    );
  }
  return value;
}

function supervisorId(value: string, prefix: string): string {
  if (
    !value.startsWith(prefix) ||
    !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value) ||
    value.length > 63
  ) {
    throw new SupervisorBootProvisionError(
      "provision_policy_rejected",
      "Supervisor provision request is outside deployment policy",
      403,
      false,
    );
  }
  return value;
}

function managementUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Supervisor management base URL is invalid");
  }
  return parsed.toString();
}

function managementUrlTemplate(value: string): string {
  if (value.split("{supervisorId}").length !== 2) {
    throw new TypeError("managementBaseUrlTemplate must contain {supervisorId} exactly once");
  }
  managementUrl(value.replace("{supervisorId}", "pi-worker-validation"));
  return value;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function boundedToken(value: string, name: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError(`${name} must contain 32-4096 bounded ASCII bytes`);
  }
  return value;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || authorization.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(authorization)?.[1];
}

function credentialParts(
  authorization: string | undefined,
): { credentialId: string; secret: string } | undefined {
  const token = bearerToken(authorization);
  if (token === undefined) return undefined;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43,128})$/i.exec(
      token,
    );
  if (match === null) return undefined;
  return { credentialId: match[1]!, secret: match[2]! };
}

function validPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("Supervisor provision path must be an absolute path");
  }
  return value;
}

function sameProvision(
  request: SupervisorBootProvisionRequest,
  credential: CredentialRow,
  sandbox: { max_concurrent_sessions: number } | undefined,
  host: { management_base_url: string } | undefined,
): boolean {
  return (
    credential.credential_id === request.credentialId &&
    credential.credential_sha256 === request.credentialSha256 &&
    credential.provision_request_id === request.requestId &&
    credential.sandbox_id === request.sandboxId &&
    credential.supervisor_id === request.supervisorId &&
    credential.boot_id === request.bootId &&
    sandbox?.max_concurrent_sessions === request.maxConcurrentSessions &&
    host?.management_base_url === managementUrl(request.managementBaseUrl)
  );
}

export class SupervisorBootProvisioner {
  readonly #database: Kysely<Database>;
  readonly #allowedSupervisorIdPrefix: string;
  readonly #managementBaseUrlTemplates: readonly string[];
  readonly #maximumCapacity: number;
  readonly #enrollmentDigest: Buffer;
  readonly #credentialTtlMs: number;
  readonly #clock: () => Date;

  constructor(options: SupervisorBootProvisionerOptions) {
    this.#database = options.database;
    this.#allowedSupervisorIdPrefix = supervisorIdPrefix(options.allowedSupervisorIdPrefix);
    if (
      options.managementBaseUrlTemplates.length < 1 ||
      options.managementBaseUrlTemplates.length > 64
    ) {
      throw new TypeError("managementBaseUrlTemplates must contain 1-64 templates");
    }
    this.#managementBaseUrlTemplates = options.managementBaseUrlTemplates.map((template) =>
      managementUrlTemplate(template),
    );
    if (
      new Set(this.#managementBaseUrlTemplates).size !== this.#managementBaseUrlTemplates.length
    ) {
      throw new TypeError("managementBaseUrlTemplates must contain unique templates");
    }
    this.#maximumCapacity = positiveInteger(options.maximumCapacity, "maximumCapacity", 256);
    this.#enrollmentDigest = tokenDigest(boundedToken(options.enrollmentToken, "enrollmentToken"));
    this.#credentialTtlMs = positiveInteger(
      options.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS,
      "credentialTtlMs",
      7 * 24 * 60 * 60 * 1_000,
    );
    this.#clock = options.clock ?? (() => new Date());
  }

  authorize(authorization: string | undefined): void {
    const token = bearerToken(authorization);
    const candidate = token === undefined ? Buffer.alloc(32) : tokenDigest(token);
    if (token === undefined || !timingSafeEqual(this.#enrollmentDigest, candidate)) {
      throw new SupervisorBootProvisionError(
        "invalid_enrollment_credential",
        "Supervisor enrollment is not authorized",
        401,
        false,
      );
    }
  }

  async provision(value: unknown): Promise<SupervisorBootProvisionResponse> {
    let request: SupervisorBootProvisionRequest;
    try {
      request = parseSupervisorBootProvisionRequest(value);
    } catch {
      throw new SupervisorBootProvisionError(
        "invalid_provision_request",
        "Supervisor provision request is invalid",
        400,
        false,
      );
    }
    const provisionedSupervisorId = supervisorId(
      request.supervisorId,
      this.#allowedSupervisorIdPrefix,
    );
    const provisionedManagementBaseUrl = managementUrl(request.managementBaseUrl);
    const matchesAllowedManagementRoute = this.#managementBaseUrlTemplates.some(
      (template) =>
        managementUrl(template.replace("{supervisorId}", provisionedSupervisorId)) ===
        provisionedManagementBaseUrl,
    );
    if (!matchesAllowedManagementRoute || request.maxConcurrentSessions > this.#maximumCapacity) {
      throw new SupervisorBootProvisionError(
        "provision_policy_rejected",
        "Supervisor provision request is outside deployment policy",
        403,
        false,
      );
    }
    const now = validDate(this.#clock);
    const expiresAt = new Date(now.valueOf() + this.#credentialTtlMs);
    return this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("supervisor_hosts")
        .values({
          supervisor_id: provisionedSupervisorId,
          maximum_capacity: this.#maximumCapacity,
          management_base_url: provisionedManagementBaseUrl,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column("supervisor_id").doNothing())
        .executeTakeFirst();
      const host = await transaction
        .selectFrom("supervisor_hosts")
        .select(["maximum_capacity", "management_base_url"])
        .where("supervisor_id", "=", provisionedSupervisorId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        host.maximum_capacity < this.#maximumCapacity ||
        host.management_base_url !== provisionedManagementBaseUrl
      ) {
        throw new SupervisorBootProvisionError(
          "provision_host_policy_conflict",
          "Stored Supervisor host policy does not match deployment configuration",
          409,
          false,
        );
      }
      if (host.maximum_capacity > this.#maximumCapacity) {
        await transaction
          .updateTable("supervisor_hosts")
          .set({
            maximum_capacity: this.#maximumCapacity,
            updated_at: now,
          })
          .where("supervisor_id", "=", provisionedSupervisorId)
          .where("maximum_capacity", "=", host.maximum_capacity)
          .executeTakeFirstOrThrow();
      }
      const conflict = await this.#findConflict(transaction, request);
      if (conflict !== undefined) {
        const sandbox = await transaction
          .selectFrom("sandboxes")
          .select(["max_concurrent_sessions"])
          .where("id", "=", conflict.sandbox_id)
          .executeTakeFirst();
        const conflictingHost = await transaction
          .selectFrom("supervisor_hosts")
          .select("management_base_url")
          .where("supervisor_id", "=", request.supervisorId)
          .executeTakeFirst();
        if (
          sameProvision(request, conflict, sandbox, conflictingHost) &&
          conflict.revoked_at === null &&
          new Date(conflict.expires_at).valueOf() > now.valueOf()
        ) {
          return this.#response(request, new Date(conflict.expires_at), true);
        }
        throw new SupervisorBootProvisionError(
          "provision_identity_conflict",
          "Supervisor provision identity was already used differently",
          409,
          false,
        );
      }

      await transaction
        .insertInto("sandboxes")
        .values({
          id: request.sandboxId,
          supervisor_id: request.supervisorId,
          boot_id: request.bootId,
          state: "provisioning",
          max_concurrent_sessions: request.maxConcurrentSessions,
          active_sessions: 0,
          created_at: now,
          updated_at: now,
          terminated_at: null,
        })
        .executeTakeFirstOrThrow();

      await transaction
        .updateTable("supervisor_boot_credentials")
        .set({ revoked_at: now })
        .where("supervisor_id", "=", request.supervisorId)
        .where("revoked_at", "is", null)
        .execute();

      await transaction
        .insertInto("supervisor_boot_credentials")
        .values({
          credential_id: request.credentialId,
          credential_sha256: request.credentialSha256,
          provision_request_id: request.requestId,
          sandbox_id: request.sandboxId,
          supervisor_id: request.supervisorId,
          boot_id: request.bootId,
          created_at: now,
          expires_at: expiresAt,
          revoked_at: null,
        })
        .executeTakeFirstOrThrow();
      return this.#response(request, expiresAt, false);
    });
  }

  async #findConflict(
    transaction: Transaction<Database>,
    request: SupervisorBootProvisionRequest,
  ): Promise<CredentialRow | undefined> {
    return transaction
      .selectFrom("supervisor_boot_credentials")
      .select([
        "credential_id",
        "credential_sha256",
        "provision_request_id",
        "sandbox_id",
        "supervisor_id",
        "boot_id",
        "expires_at",
        "revoked_at",
      ])
      .where((expression) =>
        expression.or([
          expression("credential_id", "=", request.credentialId),
          expression("provision_request_id", "=", request.requestId),
          expression("sandbox_id", "=", request.sandboxId),
          expression.and([
            expression("supervisor_id", "=", request.supervisorId),
            expression("boot_id", "=", request.bootId),
          ]),
        ]),
      )
      .forUpdate()
      .executeTakeFirst();
  }

  #response(
    request: SupervisorBootProvisionRequest,
    expiresAt: Date,
    idempotent: boolean,
  ): SupervisorBootProvisionResponse {
    return {
      protocolVersion: 1,
      type: "supervisor.boot.provisioned",
      requestId: request.requestId,
      supervisorId: request.supervisorId,
      bootId: request.bootId,
      sandboxId: request.sandboxId,
      credentialId: request.credentialId,
      maxConcurrentSessions: request.maxConcurrentSessions,
      expiresAt: expiresAt.toISOString(),
      idempotent,
    };
  }
}

export class PostgresSupervisorCredentialAuthorizer implements SupervisorUpgradeAuthorizer {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: PostgresSupervisorCredentialAuthorizerOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async authorize(request: SupervisorUpgradeRequest) {
    const parts = credentialParts(request.authorization);
    const row =
      parts === undefined
        ? undefined
        : await this.#database
            .selectFrom("supervisor_boot_credentials")
            .select([
              "credential_sha256",
              "supervisor_id",
              "boot_id",
              "sandbox_id",
              "expires_at",
              "revoked_at",
            ])
            .where("credential_id", "=", parts.credentialId)
            .executeTakeFirst();
    const expected =
      row !== undefined && /^[0-9a-f]{64}$/.test(row.credential_sha256)
        ? Buffer.from(row.credential_sha256, "hex")
        : Buffer.alloc(32);
    const candidate = parts === undefined ? Buffer.alloc(32) : tokenDigest(parts.secret);
    const now = validDate(this.#clock);
    if (
      parts === undefined ||
      row === undefined ||
      !timingSafeEqual(expected, candidate) ||
      row.revoked_at !== null ||
      new Date(row.expires_at).valueOf() <= now.valueOf()
    ) {
      throw new SupervisorUpgradeAuthorizationError(
        "invalid_supervisor_credential",
        "Supervisor upgrade is not authorized",
        false,
      );
    }
    return {
      supervisorId: row.supervisor_id,
      bootId: row.boot_id,
      sandboxId: row.sandbox_id,
    };
  }
}

export class SupervisorProvisioningGateway {
  readonly #provisioner: SupervisorBootProvisioner;
  readonly #path: string;
  readonly #maxBodyBytes: number;
  #installed = false;

  constructor(options: SupervisorProvisioningGatewayOptions) {
    this.#provisioner = options.provisioner;
    this.#path = validPath(options.path ?? SUPERVISOR_BOOT_PROVISION_PATH);
    this.#maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "maxBodyBytes",
      1024 * 1024,
    );
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Supervisor provisioning gateway is already installed");
    this.#installed = true;
    fastify.post(
      this.#path,
      { bodyLimit: this.#maxBodyBytes },
      async (request: FastifyRequest, reply) => {
        try {
          this.#provisioner.authorize(request.headers.authorization);
          const response = await this.#provisioner.provision(request.body);
          await reply.code(201).send(response);
        } catch (error: unknown) {
          const failure =
            error instanceof SupervisorBootProvisionError
              ? error
              : new SupervisorBootProvisionError(
                  "provision_service_unavailable",
                  "Supervisor provision service is unavailable",
                  503,
                  true,
                );
          await reply.code(failure.statusCode).send({
            error: {
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
            },
          });
        }
      },
    );
  }
}
