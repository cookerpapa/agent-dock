import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downUnlimitedDefaultDailyTokens,
  upContextAndModelGovernance,
  upControlledWorkspaceSources,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upEncryptedTenantModelCredentials,
  upExplicitSessionMailbox,
  upInitialControlPlane,
  upObservabilityTraceIdentity,
  upPrivateMultiTenantIdentity,
  upProductAuthAndEmptyWorkspaces,
  upRemovePerRunTokenBudget,
  upSupervisorBootCredentials,
  upSupervisorConnectionHealth,
  upUnlimitedDefaultDailyTokens,
  upVersionedWorkspacesAndGitHubDelivery,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  for (const migration of [
    upInitialControlPlane,
    upDurableEventDelivery,
    upExplicitSessionMailbox,
    upSupervisorConnectionHealth,
    upSupervisorBootCredentials,
    upPrivateMultiTenantIdentity,
    upEncryptedTenantModelCredentials,
    upControlledWorkspaceSources,
    upDurableRunsAndAttempts,
    upVersionedWorkspacesAndGitHubDelivery,
    upContextAndModelGovernance,
    upObservabilityTraceIdentity,
    upProductAuthAndEmptyWorkspaces,
    upRemovePerRunTokenBudget,
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

async function insertTenant(postgres: PGlite, suffix: string): Promise<string> {
  const tenant = `${suffix}0000000-0000-4000-8000-000000000001`;
  const profile = `${suffix}0000000-0000-4000-8000-000000000002`;
  const credential = `${suffix}0000000-0000-4000-8000-000000000003`;
  await postgres.query("insert into tenants (id, slug) values ($1, $2)", [
    tenant,
    `tenant-${suffix}`,
  ]);
  await postgres.query(
    `insert into credential_bindings
      (id, tenant_id, provider, kind, secret_ref, status)
     values ($1, $2, 'pi-cloud-fake', 'brokered', 'fixture', 'active')`,
    [credential, tenant],
  );
  await postgres.query(
    `insert into model_profiles
      (id, tenant_id, name, provider, model_id, default_thinking_level,
       allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'default', 'pi-cloud-fake', 'pi-cloud-fake', 'off',
             array['off'], $3, 1)`,
    [profile, tenant, credential],
  );
  await postgres.query(
    `insert into tenant_runtime_policies (tenant_id, default_model_profile_id)
     values ($1, $2)`,
    [tenant, profile],
  );
  return tenant;
}

describe("effectively unlimited default daily tokens migration", () => {
  it("removes the legacy default without overwriting an administrator-managed quota", async () => {
    const postgres = await fixture();
    try {
      const legacyTenant = await insertTenant(postgres, "1");
      const managedTenant = await insertTenant(postgres, "2");
      await postgres.query(
        `update tenant_runtime_policies
            set daily_token_budget = 3000000,
                updated_at = updated_at + interval '1 second'
          where tenant_id = $1`,
        [managedTenant],
      );

      await applyCompiledQueries(postgres, await compileMigration(upUnlimitedDefaultDailyTokens));
      const newTenant = await insertTenant(postgres, "3");
      const rows = await postgres.query<{ daily_token_budget: number; tenant_id: string }>(
        `select tenant_id, daily_token_budget
           from tenant_runtime_policies
          order by tenant_id`,
      );
      expect(rows.rows).toEqual([
        { tenant_id: legacyTenant, daily_token_budget: 1_000_000_000_000 },
        { tenant_id: managedTenant, daily_token_budget: 3_000_000 },
        { tenant_id: newTenant, daily_token_budget: 1_000_000_000_000 },
      ]);

      await applyCompiledQueries(postgres, await compileMigration(downUnlimitedDefaultDailyTokens));
      const reverted = await insertTenant(postgres, "4");
      const revertedRow = await postgres.query<{ daily_token_budget: number }>(
        `select daily_token_budget from tenant_runtime_policies where tenant_id = $1`,
        [reverted],
      );
      expect(revertedRow.rows).toEqual([{ daily_token_budget: 2_000_000 }]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
