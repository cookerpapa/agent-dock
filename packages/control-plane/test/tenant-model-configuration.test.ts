import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresTenantModelCredentialResolver,
  TenantModelConfigurationError,
  TenantModelConfigurationService,
  TenantModelCredentialError,
  TenantModelCredentialVault,
  createControlPlaneApplication,
  createPrivateTenant,
  type TenantRequestIdentity,
} from "../src/index.ts";

const MASTER_KEY = Buffer.alloc(32, 11).toString("base64url");
const OTHER_MASTER_KEY = Buffer.alloc(32, 12).toString("base64url");
const FIRST_SECRET = `sk-${"a".repeat(48)}`;
const ROTATED_SECRET = `sk-${"b".repeat(48)}`;

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

describe.sequential("tenant model configuration", () => {
  it("authenticates ciphertext against the exact tenant binding identity", () => {
    const identity = {
      tenantId: "10000000-0000-4000-8000-000000000001",
      credentialBindingId: "20000000-0000-4000-8000-000000000001",
      credentialBindingVersion: 2,
      provider: "deepseek",
    };
    const vault = new TenantModelCredentialVault(MASTER_KEY, {
      randomBytes: () => Buffer.alloc(12, 7),
    });
    const sealed = vault.seal(identity, FIRST_SECRET);
    expect(JSON.stringify(sealed)).not.toContain(FIRST_SECRET);
    expect(vault.open(identity, sealed)).toBe(FIRST_SECRET);
    expect(() => vault.open({ ...identity, credentialBindingVersion: 3 }, sealed)).toThrow(
      TenantModelCredentialError,
    );
    expect(() => new TenantModelCredentialVault(OTHER_MASTER_KEY).open(identity, sealed)).toThrow(
      TenantModelCredentialError,
    );
    expect(() =>
      vault.open(identity, {
        ...sealed,
        ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}`,
      }),
    ).toThrow(TenantModelCredentialError);
  });

  it("isolates safe metadata, content-idempotently updates, and rotates immutable versions", async () => {
    const tenantA = await createPrivateTenant(database, {
      slug: "model-tenant-a",
      ownerDisplayName: "Model Tenant A",
    });
    const tenantB = await createPrivateTenant(database, {
      slug: "model-tenant-b",
      ownerDisplayName: "Model Tenant B",
    });
    const identityA = ownerIdentity(tenantA);
    const identityB = ownerIdentity(tenantB);
    let tick = 0;
    const vault = new TenantModelCredentialVault(MASTER_KEY);
    const service = new TenantModelConfigurationService({
      database,
      vault,
      clock: () => new Date(Date.UTC(2026, 6, 19, 14, 0, tick++)),
    });

    await expect(service.get(identityA)).resolves.toMatchObject({
      mode: "deterministic",
      configured: false,
      credentialVersion: 1,
    });
    const configured = await service.replace(identityA, {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey: FIRST_SECRET,
    });
    expect(configured).toMatchObject({
      mode: "real",
      modelId: "deepseek-v4-flash",
      credentialVersion: 2,
    });
    await expect(service.get(identityB)).resolves.toMatchObject({
      mode: "deterministic",
      configured: false,
    });

    const persisted = await database
      .selectFrom("tenant_model_credentials")
      .selectAll()
      .where("tenant_id", "=", tenantA.tenantId)
      .execute();
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(FIRST_SECRET);

    await expect(
      service.replace(identityA, {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: FIRST_SECRET,
      }),
    ).resolves.toMatchObject({ credentialVersion: 2 });
    await expect(
      service.replace(identityA, {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        apiKey: FIRST_SECRET,
      }),
    ).resolves.toMatchObject({ credentialVersion: 2, modelId: "deepseek-v4-pro" });
    await expect(
      service.replace(identityA, {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: ROTATED_SECRET,
      }),
    ).resolves.toMatchObject({ credentialVersion: 3 });

    const versions = await database
      .selectFrom("tenant_model_credentials")
      .select("credential_binding_version as version")
      .where("tenant_id", "=", tenantA.tenantId)
      .orderBy("credential_binding_version")
      .execute();
    expect(versions.map((row) => Number(row.version))).toEqual([2, 3]);

    const resolver = new PostgresTenantModelCredentialResolver({ database, vault });
    await expect(
      resolver.resolve({
        tenantId: tenantA.tenantId,
        credentialBindingId: tenantA.credentialBindingId,
        credentialBindingVersion: 2,
        provider: "deepseek",
      }),
    ).resolves.toMatchObject({ secret: FIRST_SECRET });
    await expect(
      resolver.resolve({
        tenantId: tenantA.tenantId,
        credentialBindingId: tenantA.credentialBindingId,
        credentialBindingVersion: 3,
        provider: "deepseek",
      }),
    ).resolves.toMatchObject({ secret: ROTATED_SECRET });

    await expect(
      service.replace(
        { ...identityA, role: "member" },
        { provider: "deepseek", modelId: "deepseek-v4-flash", apiKey: FIRST_SECRET },
      ),
    ).rejects.toBeInstanceOf(TenantModelConfigurationError);
  });

  it("exposes only the authenticated tenant's safe configuration over HTTP", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "model-http-tenant",
      ownerDisplayName: "Model HTTP Owner",
    });
    const application = await createControlPlaneApplication({
      database,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
      modelCredentialVault: new TenantModelCredentialVault(MASTER_KEY),
    });
    try {
      await application.listen(0, "127.0.0.1");
      const baseUrl = await application.getUrl();
      const initial = await fetch(`${baseUrl}/v1/model-configuration`);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({ mode: "deterministic", configured: false });
      const replaced = await fetch(`${baseUrl}/v1/model-configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          modelId: "deepseek-v4-flash",
          apiKey: FIRST_SECRET,
        }),
      });
      expect(replaced.status).toBe(200);
      const body = await replaced.json();
      expect(body).toMatchObject({
        mode: "real",
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        configured: true,
        credentialVersion: 2,
      });
      expect(JSON.stringify(body)).not.toContain(FIRST_SECRET);
    } finally {
      await application.close();
    }
  });
});
