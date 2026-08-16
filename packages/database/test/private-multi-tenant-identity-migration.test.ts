import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  downInitialControlPlane,
  downPrivateMultiTenantIdentity,
  upInitialControlPlane,
  upPrivateMultiTenantIdentity,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const IDS = {
  tenantA: "00000000-0000-4000-8000-0000000000a1",
  tenantB: "00000000-0000-4000-8000-0000000000b1",
  userA: "10000000-0000-4000-8000-0000000000a1",
  userB: "10000000-0000-4000-8000-0000000000b1",
  bindingA: "20000000-0000-4000-8000-0000000000a1",
  bindingB: "20000000-0000-4000-8000-0000000000b1",
  profileA: "30000000-0000-4000-8000-0000000000a1",
  profileB: "30000000-0000-4000-8000-0000000000b1",
  apiA: "40000000-0000-4000-8000-0000000000a1",
};

let postgres: PGlite;

async function seedTenant(
  tenantId: string,
  slug: string,
  userId: string,
  bindingId: string,
  profileId: string,
): Promise<void> {
  await postgres.query("insert into tenants (id, slug) values ($1, $2)", [tenantId, slug]);
  await postgres.query("insert into users (id, tenant_id, display_name) values ($1, $2, $3)", [
    userId,
    tenantId,
    `${slug} owner`,
  ]);
  await postgres.query(
    `insert into credential_bindings
       (id, tenant_id, provider, kind, secret_ref, version, status)
     values ($1, $2, 'pi-cloud-fake', 'brokered', $3, 1, 'active')`,
    [bindingId, tenantId, `broker://${slug}/fixture`],
  );
  await postgres.query(
    `insert into model_profiles
       (id, tenant_id, name, provider, model_id, default_thinking_level,
        allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'default', 'pi-cloud-fake', 'pi-cloud-fake', 'off',
             array['off'], $3, 1)`,
    [profileId, tenantId, bindingId],
  );
}

describe("private multi-tenant identity migration", () => {
  beforeAll(async () => {
    postgres = new PGlite();
    await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
    await applyCompiledQueries(postgres, await compileMigration(upPrivateMultiTenantIdentity));
    await seedTenant(IDS.tenantA, "tenant-a", IDS.userA, IDS.bindingA, IDS.profileA);
    await seedTenant(IDS.tenantB, "tenant-b", IDS.userB, IDS.bindingB, IDS.profileB);
  }, 30_000);

  afterAll(async () => {
    await postgres.close();
  });

  it("stores a tenant-consistent runtime policy with positive quota bounds", async () => {
    await postgres.query(
      `insert into tenant_runtime_policies
         (tenant_id, default_model_profile_id, maximum_projects, maximum_sessions,
          maximum_unsettled_turns, maximum_concurrent_turns)
       values ($1, $2, 5, 20, 4, 2)`,
      [IDS.tenantA, IDS.profileA],
    );
    const result = await postgres.query<{
      tenant_id: string;
      maximum_unsettled_turns: number;
      maximum_concurrent_turns: number;
    }>(
      `select tenant_id, maximum_unsettled_turns, maximum_concurrent_turns
         from tenant_runtime_policies where tenant_id = $1`,
      [IDS.tenantA],
    );
    expect(result.rows).toEqual([
      {
        tenant_id: IDS.tenantA,
        maximum_unsettled_turns: 4,
        maximum_concurrent_turns: 2,
      },
    ]);

    await expect(
      postgres.query(
        `insert into tenant_runtime_policies
           (tenant_id, default_model_profile_id)
         values ($1, $2)`,
        [IDS.tenantB, IDS.profileA],
      ),
    ).rejects.toThrow();
    await expect(
      postgres.query(
        `update tenant_runtime_policies
            set maximum_concurrent_turns = 5, maximum_unsettled_turns = 4
          where tenant_id = $1`,
        [IDS.tenantA],
      ),
    ).rejects.toThrow();
  });

  it("stores only bounded credential metadata for an exact tenant-local user", async () => {
    const digest = "a".repeat(64);
    await postgres.query(
      `insert into tenant_api_credentials
         (credential_id, tenant_id, user_id, label, role, secret_sha256)
       values ($1, $2, $3, 'primary owner', 'owner', $4)`,
      [IDS.apiA, IDS.tenantA, IDS.userA, digest],
    );
    const result = await postgres.query<{
      credential_id: string;
      tenant_id: string;
      user_id: string;
      role: string;
      secret_sha256: string;
      revoked_at: Date | null;
    }>(
      `select credential_id, tenant_id, user_id, role, secret_sha256, revoked_at
         from tenant_api_credentials where credential_id = $1`,
      [IDS.apiA],
    );
    expect(result.rows).toEqual([
      {
        credential_id: IDS.apiA,
        tenant_id: IDS.tenantA,
        user_id: IDS.userA,
        role: "owner",
        secret_sha256: digest,
        revoked_at: null,
      },
    ]);

    await expect(
      postgres.query(
        `insert into tenant_api_credentials
           (credential_id, tenant_id, user_id, label, role, secret_sha256)
         values (gen_random_uuid(), $1, $2, 'cross tenant', 'member', $3)`,
        [IDS.tenantB, IDS.userA, "b".repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      postgres.query(
        `insert into tenant_api_credentials
           (credential_id, tenant_id, user_id, label, role, secret_sha256)
         values (gen_random_uuid(), $1, $2, 'invalid role', 'administrator', $3)`,
        [IDS.tenantA, IDS.userA, "c".repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      postgres.query(
        `insert into tenant_api_credentials
           (credential_id, tenant_id, user_id, label, role, secret_sha256)
         values (gen_random_uuid(), $1, $2, 'plaintext-like', 'member', 'not-a-digest')`,
        [IDS.tenantA, IDS.userA],
      ),
    ).rejects.toThrow();
  });

  it("drops the identity tables without weakening the initial schema", async () => {
    const isolated = new PGlite();
    try {
      await applyCompiledQueries(isolated, await compileMigration(upInitialControlPlane));
      await applyCompiledQueries(isolated, await compileMigration(upPrivateMultiTenantIdentity));
      await applyCompiledQueries(isolated, await compileMigration(downPrivateMultiTenantIdentity));
      const tables = await isolated.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).not.toContain("tenant_api_credentials");
      expect(tables.rows.map((row) => row.table_name)).not.toContain("tenant_runtime_policies");
      expect(tables.rows.map((row) => row.table_name)).toContain("tenants");
      await applyCompiledQueries(isolated, await compileMigration(downInitialControlPlane));
    } finally {
      await isolated.close();
    }
  });
});
