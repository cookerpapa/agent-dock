import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrivateTenant,
  normalizeCubeUpstreamProxyUrl,
  PlatformRuntimeSettingsError,
  PlatformRuntimeSettingsService,
  type TenantRequestIdentity,
} from "../src/index.ts";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
});

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

function ownerIdentity(
  tenant: Awaited<ReturnType<typeof createPrivateTenant>>,
): TenantRequestIdentity {
  return {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: `${tenant.tenantSlug} owner`,
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
}

describe.sequential("hot platform runtime settings", () => {
  it("normalizes only credential-free HTTP(S) proxy origins", () => {
    expect(normalizeCubeUpstreamProxyUrl("http://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890");
    for (const value of [
      "socks5://127.0.0.1:7890",
      "http://user:password@127.0.0.1:7890",
      "http://127.0.0.1:7890/private",
      "http://127.0.0.1:7890/?token=secret",
    ]) {
      expect(() => normalizeCubeUpstreamProxyUrl(value)).toThrow(PlatformRuntimeSettingsError);
    }
  });

  it("versions operator changes and serves them only to the trusted gateway", async () => {
    const operator = await createPrivateTenant(database, {
      slug: "runtime-settings-operator",
      ownerDisplayName: "Runtime Settings Operator",
    });
    const other = await createPrivateTenant(database, {
      slug: "runtime-settings-other",
      ownerDisplayName: "Runtime Settings Other",
    });
    const operatorIdentity = ownerIdentity(operator);
    const service = new PlatformRuntimeSettingsService({
      database,
      platformOperatorTenantId: operator.tenantId,
      internalServiceToken: "t".repeat(48),
      clock: () => new Date("2026-07-26T06:00:00.000Z"),
      idGenerator: () => "10000000-0000-4000-8000-000000000099",
    });

    await expect(service.get(operatorIdentity)).resolves.toMatchObject({
      enabled: false,
      configured: false,
      revision: 0,
    });
    await expect(
      service.replace(operatorIdentity, {
        enabled: true,
        proxyUrl: "http://127.0.0.1:7890/",
      }),
    ).resolves.toEqual({
      enabled: true,
      configured: true,
      proxyUrl: "http://127.0.0.1:7890",
      revision: 1,
      updatedAt: "2026-07-26T06:00:00.000Z",
    });
    await expect(service.internal("t".repeat(48))).resolves.toEqual({
      enabled: true,
      upstreamProxyUrl: "http://127.0.0.1:7890",
      revision: 1,
    });
    await expect(service.internal("x".repeat(48))).rejects.toMatchObject({
      code: "authorization_denied",
    });
    await expect(
      service.replace(ownerIdentity(other), {
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    const changes = await database
      .selectFrom("platform_runtime_setting_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      revision: "1",
      actor_tenant_id: operator.tenantId,
      cube_proxy_enabled: true,
    });
    expect(changes[0]?.cube_proxy_url_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
