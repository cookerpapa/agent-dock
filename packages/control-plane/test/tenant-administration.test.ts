import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresTenantApiAuthenticator,
  TenantAdministrationError,
  createPrivateTenant,
  issuePrivateTenantCredential,
  listPrivateTenantCredentials,
  revokePrivateTenantCredential,
} from "../src/index.ts";

const IDS = [
  "a0000000-0000-4000-8000-000000000001",
  "a0000000-0000-4000-8000-000000000002",
  "a0000000-0000-4000-8000-000000000003",
  "a0000000-0000-4000-8000-000000000004",
  "a0000000-0000-4000-8000-000000000005",
] as const;
const MEMBER_CREDENTIAL_ID = "a0000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-07-19T13:00:00.000Z");

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

describe.sequential("private tenant administration", () => {
  it("atomically creates a tenant, owner, model policy, and one-time credential", async () => {
    let index = 0;
    const created = await createPrivateTenant(database, {
      slug: "engineering-a",
      ownerDisplayName: "Engineering A Owner",
      quotas: {
        maximumProjects: 4,
        maximumSessions: 20,
        maximumUnsettledTurns: 6,
        maximumConcurrentTurns: 2,
        maximumActiveSandboxes: 3,
      },
      idGenerator: () => IDS[index++]!,
      randomSecret: () => "a".repeat(43),
      clock: () => NOW,
    });
    expect(created).toMatchObject({
      tenantId: IDS[0],
      ownerUserId: IDS[1],
      credentialBindingId: IDS[2],
      defaultModelProfileId: IDS[3],
      tenantSlug: "engineering-a",
      credential: { credentialId: IDS[4] },
      quotas: {
        maximumProjects: 4,
        maximumSessions: 20,
        maximumUnsettledTurns: 6,
        maximumConcurrentTurns: 2,
        maximumActiveSandboxes: 3,
      },
    });
    const counts = [];
    counts.push(await database.selectFrom("tenants").selectAll().execute());
    counts.push(await database.selectFrom("users").selectAll().execute());
    counts.push(await database.selectFrom("credential_bindings").selectAll().execute());
    counts.push(await database.selectFrom("model_profiles").selectAll().execute());
    counts.push(await database.selectFrom("tenant_runtime_policies").selectAll().execute());
    counts.push(await database.selectFrom("tenant_api_credentials").selectAll().execute());
    expect(counts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts[4]?.[0]).toMatchObject({ maximum_active_sandboxes: 3 });
    expect(JSON.stringify(counts)).not.toContain(created.credential.token);
    await expect(
      new PostgresTenantApiAuthenticator({ database, clock: () => NOW }).authenticate(
        created.credential.token,
      ),
    ).resolves.toMatchObject({ tenantId: IDS[0], userId: IDS[1], role: "owner" });
  });

  it("fails a duplicate or invalid tenant without leaving partial rows", async () => {
    let index = 0;
    await expect(
      createPrivateTenant(database, {
        slug: "engineering-a",
        ownerDisplayName: "Duplicate",
        idGenerator: () => `b0000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
        randomSecret: () => "b".repeat(43),
        clock: () => NOW,
      }),
    ).rejects.toBeInstanceOf(TenantAdministrationError);
    expect(await database.selectFrom("tenants").selectAll().execute()).toHaveLength(1);
    expect(await database.selectFrom("users").selectAll().execute()).toHaveLength(1);

    await expect(
      createPrivateTenant(database, {
        slug: "invalid-quota",
        ownerDisplayName: "Invalid",
        quotas: { maximumUnsettledTurns: 1, maximumConcurrentTurns: 2 },
      }),
    ).rejects.toThrow("cannot exceed");
    expect(await database.selectFrom("tenants").selectAll().execute()).toHaveLength(1);
  });

  it("issues, lists, and revokes tenant-scoped credentials without listing digests", async () => {
    const issued = await issuePrivateTenantCredential(database, {
      tenant: "engineering-a",
      userId: IDS[1],
      label: "automation member",
      role: "member",
      credentialId: MEMBER_CREDENTIAL_ID,
      randomSecret: () => "m".repeat(43),
      clock: () => NOW,
    });
    const listed = await listPrivateTenantCredentials(database, IDS[0]);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({
      credentialId: MEMBER_CREDENTIAL_ID,
      userId: IDS[1],
      label: "automation member",
      role: "member",
      revokedAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain("secretSha256");
    expect(JSON.stringify(listed)).not.toContain(issued.token);

    expect(
      await revokePrivateTenantCredential(database, {
        tenant: "engineering-a",
        credentialId: MEMBER_CREDENTIAL_ID,
        revokedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await revokePrivateTenantCredential(database, {
        tenant: "engineering-a",
        credentialId: MEMBER_CREDENTIAL_ID,
        revokedAt: NOW,
      }),
    ).toBe(false);
    await expect(
      new PostgresTenantApiAuthenticator({ database, clock: () => NOW }).authenticate(issued.token),
    ).resolves.toBeUndefined();
  });
});
