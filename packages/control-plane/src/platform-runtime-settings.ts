import type { Database } from "@agent-dock/database";
import type {
  CubeProxyConfigurationResource,
  InternalCubeProxyConfigurationResource,
  ReplaceCubeProxyConfigurationRequest,
} from "@agent-dock/protocol";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

export class PlatformRuntimeSettingsError extends Error {
  readonly code:
    | "authorization_denied"
    | "cube_proxy_configuration_invalid"
    | "platform_runtime_settings_unavailable";

  constructor(code: PlatformRuntimeSettingsError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "PlatformRuntimeSettingsError";
    this.code = code;
  }
}

export type PlatformRuntimeSettingsServiceOptions = {
  database: Kysely<Database>;
  platformOperatorTenantId?: string;
  internalServiceToken?: string;
  clock?: () => Date;
  idGenerator?: () => string;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validRevision(value: string | number | bigint): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new PlatformRuntimeSettingsError(
      "platform_runtime_settings_unavailable",
      "Platform runtime settings revision is invalid",
    );
  }
  return revision;
}

function validClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("Platform runtime settings clock must return a valid Date");
  }
  return now;
}

export function normalizeCubeUpstreamProxyUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlatformRuntimeSettingsError(
      "cube_proxy_configuration_invalid",
      "CubeSandbox upstream proxy URL is invalid",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    value.length > 2_048
  ) {
    throw new PlatformRuntimeSettingsError(
      "cube_proxy_configuration_invalid",
      "CubeSandbox upstream proxy URL must be an HTTP(S) origin without credentials",
    );
  }
  return parsed.origin;
}

export class PlatformRuntimeSettingsService {
  readonly #database: Kysely<Database>;
  readonly #platformOperatorTenantId: string | undefined;
  readonly #internalServiceTokenDigest: Buffer | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PlatformRuntimeSettingsServiceOptions) {
    this.#database = options.database;
    this.#platformOperatorTenantId = options.platformOperatorTenantId;
    this.#internalServiceTokenDigest =
      options.internalServiceToken === undefined ? undefined : digest(options.internalServiceToken);
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  isPlatformAdministrator(identity: TenantRequestIdentity): boolean {
    return (
      identity.role === "owner" &&
      this.#platformOperatorTenantId !== undefined &&
      identity.tenantId === this.#platformOperatorTenantId
    );
  }

  async get(identity: TenantRequestIdentity): Promise<CubeProxyConfigurationResource> {
    this.#requirePlatformOperator(identity);
    return this.#resource(await this.#read());
  }

  async replace(
    identity: TenantRequestIdentity,
    request: ReplaceCubeProxyConfigurationRequest,
  ): Promise<CubeProxyConfigurationResource> {
    this.#requirePlatformOperator(identity);
    const now = validClock(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("platform_runtime_settings")
        .selectAll()
        .where("settings_key", "=", "default")
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) {
        throw new PlatformRuntimeSettingsError(
          "platform_runtime_settings_unavailable",
          "Platform runtime settings are unavailable",
        );
      }
      const proxyUrl =
        request.proxyUrl === undefined
          ? current.cube_proxy_url
          : normalizeCubeUpstreamProxyUrl(request.proxyUrl);
      if (request.enabled && proxyUrl === null) {
        throw new PlatformRuntimeSettingsError(
          "cube_proxy_configuration_invalid",
          "Enable CubeSandbox egress only after configuring its upstream proxy",
        );
      }
      const currentRevision = validRevision(current.revision);
      const nextRevision = currentRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        throw new PlatformRuntimeSettingsError(
          "platform_runtime_settings_unavailable",
          "Platform runtime settings revision capacity is exhausted",
        );
      }
      await transaction
        .updateTable("platform_runtime_settings")
        .set({
          cube_proxy_enabled: request.enabled,
          cube_proxy_url: proxyUrl,
          revision: nextRevision,
          updated_by_tenant_id: identity.tenantId,
          updated_by_user_id: identity.userId,
          updated_at: now,
        })
        .where("settings_key", "=", "default")
        .where("revision", "=", current.revision)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("platform_runtime_setting_changes")
        .values({
          id: this.#idGenerator(),
          revision: nextRevision,
          actor_tenant_id: identity.tenantId,
          actor_user_id: identity.userId,
          cube_proxy_enabled: request.enabled,
          cube_proxy_url_sha256:
            proxyUrl === null ? null : createHash("sha256").update(proxyUrl).digest("hex"),
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      return {
        enabled: request.enabled,
        configured: proxyUrl !== null,
        ...(proxyUrl === null ? {} : { proxyUrl }),
        revision: nextRevision,
        updatedAt: now.toISOString(),
      };
    });
  }

  async internal(
    serviceToken: string | undefined,
  ): Promise<InternalCubeProxyConfigurationResource> {
    const expected = this.#internalServiceTokenDigest ?? Buffer.alloc(32);
    const actual = serviceToken === undefined ? Buffer.alloc(32) : digest(serviceToken);
    if (
      this.#internalServiceTokenDigest === undefined ||
      serviceToken === undefined ||
      serviceToken.length > 4_096 ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new PlatformRuntimeSettingsError(
        "authorization_denied",
        "Cube egress configuration service identity is invalid",
      );
    }
    const current = await this.#read();
    return {
      enabled: current.cube_proxy_enabled,
      ...(current.cube_proxy_url === null ? {} : { upstreamProxyUrl: current.cube_proxy_url }),
      revision: validRevision(current.revision),
    };
  }

  #requirePlatformOperator(identity: TenantRequestIdentity): void {
    if (!this.isPlatformAdministrator(identity)) {
      throw new PlatformRuntimeSettingsError(
        "authorization_denied",
        "Only the platform operator can administer CubeSandbox egress",
      );
    }
  }

  async #read() {
    const row = await this.#database
      .selectFrom("platform_runtime_settings")
      .selectAll()
      .where("settings_key", "=", "default")
      .executeTakeFirst();
    if (row === undefined) {
      throw new PlatformRuntimeSettingsError(
        "platform_runtime_settings_unavailable",
        "Platform runtime settings are unavailable",
      );
    }
    return row;
  }

  #resource(row: {
    cube_proxy_enabled: boolean;
    cube_proxy_url: string | null;
    revision: string | number | bigint;
    updated_at: Date | string;
  }): CubeProxyConfigurationResource {
    return {
      enabled: row.cube_proxy_enabled,
      configured: row.cube_proxy_url !== null,
      ...(row.cube_proxy_url === null ? {} : { proxyUrl: row.cube_proxy_url }),
      revision: validRevision(row.revision),
      updatedAt: new Date(row.updated_at).toISOString(),
    } satisfies CubeProxyConfigurationResource;
  }
}
