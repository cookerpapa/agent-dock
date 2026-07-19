import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresTenantApiAuthenticator,
  generateTenantApiCredential,
  issueTenantApiCredential,
  revokeTenantApiCredential,
  tenantApiTokenDigest,
} from "../src/index.ts";

const IDS = {
  tenant: "a0000000-0000-4000-8000-000000000001",
  user: "a0000000-0000-4000-8000-000000000002",
  binding: "a0000000-0000-4000-8000-000000000003",
  profile: "a0000000-0000-4000-8000-000000000004",
  ownerCredential: "a0000000-0000-4000-8000-000000000005",
  legacyCredential: "a0000000-0000-4000-8000-000000000006",
  expiredCredential: "a0000000-0000-4000-8000-000000000007",
};

const NOW = new Date("2026-07-19T12:00:00.000Z");
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
  await database.insertInto("tenants").values({ id: IDS.tenant, slug: "alpha" }).execute();
  await database
    .insertInto("users")
    .values({ id: IDS.user, tenant_id: IDS.tenant, display_name: "Alpha Owner" })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.binding,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "broker://alpha/fixture",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "default",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.binding,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("tenant_runtime_policies")
    .values({ tenant_id: IDS.tenant, default_model_profile_id: IDS.profile })
    .execute();
});

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("tenant API identity", () => {
  it("generates an indexed high-entropy token and stores only its digest", async () => {
    const generated = await issueTenantApiCredential(database, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      label: "primary owner",
      role: "owner",
      credentialId: IDS.ownerCredential,
      clock: () => NOW,
      randomSecret: () => "a".repeat(43),
    });
    expect(generated).toEqual(generateTenantApiCredential(IDS.ownerCredential, "a".repeat(43)));
    const row = await database
      .selectFrom("tenant_api_credentials")
      .selectAll()
      .where("credential_id", "=", IDS.ownerCredential)
      .executeTakeFirstOrThrow();
    expect(row.secret_sha256).toBe(tenantApiTokenDigest(generated.token));
    expect(JSON.stringify(row)).not.toContain(generated.token);

    const authenticator = new PostgresTenantApiAuthenticator({
      database,
      clock: () => NOW,
    });
    await expect(authenticator.authenticate(generated.token)).resolves.toEqual({
      credentialId: IDS.ownerCredential,
      tenantId: IDS.tenant,
      tenantSlug: "alpha",
      userId: IDS.user,
      displayName: "Alpha Owner",
      role: "owner",
      defaultModelProfileId: IDS.profile,
    });
    await expect(
      authenticator.authenticate(`${generated.token.slice(0, -1)}b`),
    ).resolves.toBeUndefined();
    await expect(authenticator.authenticate("short")).resolves.toBeUndefined();
  });

  it("keeps a bounded legacy production token usable during migration", async () => {
    const legacy = `legacy-${"l".repeat(48)}`;
    await database
      .insertInto("tenant_api_credentials")
      .values({
        credential_id: IDS.legacyCredential,
        tenant_id: IDS.tenant,
        user_id: IDS.user,
        label: "migrated production token",
        role: "owner",
        secret_sha256: tenantApiTokenDigest(legacy),
        created_at: NOW,
      })
      .execute();
    const authenticator = new PostgresTenantApiAuthenticator({ database, clock: () => NOW });
    await expect(authenticator.authenticate(legacy)).resolves.toMatchObject({
      credentialId: IDS.legacyCredential,
      tenantId: IDS.tenant,
      role: "owner",
    });
  });

  it("rejects expired, revoked, and unknown credentials without blocking a disabled tenant's safety access", async () => {
    const expired = generateTenantApiCredential(IDS.expiredCredential, "e".repeat(43));
    await database
      .insertInto("tenant_api_credentials")
      .values({
        credential_id: IDS.expiredCredential,
        tenant_id: IDS.tenant,
        user_id: IDS.user,
        label: "expired",
        role: "member",
        secret_sha256: expired.secretSha256,
        created_at: new Date("2026-07-18T10:00:00.000Z"),
        expires_at: new Date("2026-07-18T11:00:00.000Z"),
      })
      .execute();
    const authenticator = new PostgresTenantApiAuthenticator({ database, clock: () => NOW });
    await expect(authenticator.authenticate(expired.token)).resolves.toBeUndefined();

    const owner = generateTenantApiCredential(IDS.ownerCredential, "a".repeat(43));
    expect(
      await revokeTenantApiCredential(database, {
        tenantId: IDS.tenant,
        credentialId: IDS.ownerCredential,
        revokedAt: NOW,
      }),
    ).toBe(true);
    await expect(authenticator.authenticate(owner.token)).resolves.toBeUndefined();
    await expect(
      authenticator.authenticate(generateTenantApiCredential(undefined, "u".repeat(43)).token),
    ).resolves.toBeUndefined();

    await database
      .updateTable("tenant_runtime_policies")
      .set({ enabled: false })
      .where("tenant_id", "=", IDS.tenant)
      .execute();
    const legacy = `legacy-${"l".repeat(48)}`;
    await expect(authenticator.authenticate(legacy)).resolves.toMatchObject({
      tenantId: IDS.tenant,
      role: "owner",
    });
  });
});
