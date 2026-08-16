import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downRemovePerRunTokenBudget,
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

describe("unlimited per-Run tokens migration", () => {
  it("removes the obsolete limit while preserving independent governance controls", async () => {
    const postgres = await fixture();
    try {
      const tenant = "10000000-0000-4000-8000-000000000001";
      const credential = "20000000-0000-4000-8000-000000000001";
      const profile = "30000000-0000-4000-8000-000000000001";
      await postgres.query("insert into tenants (id, slug) values ($1, 'unlimited-run')", [tenant]);
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

      const columns = await postgres.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public'
            and table_name = 'tenant_runtime_policies'
            and column_name = 'maximum_tokens_per_run'`,
      );
      expect(columns.rows).toEqual([]);
      await expect(
        postgres.query(
          `update tenant_runtime_policies
              set compaction_reserve_tokens = 150000,
                  compaction_keep_recent_tokens = 150000
            where tenant_id = $1`,
          [tenant],
        ),
      ).resolves.toBeDefined();
      await expect(
        postgres.query(
          `update tenant_runtime_policies
              set maximum_model_requests_per_run = 0
            where tenant_id = $1`,
          [tenant],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downRemovePerRunTokenBudget));
      const restored = await postgres.query<{ maximum_tokens_per_run: number }>(
        `select maximum_tokens_per_run
           from tenant_runtime_policies
          where tenant_id = $1`,
        [tenant],
      );
      expect(restored.rows).toEqual([{ maximum_tokens_per_run: 300_000 }]);
      await expect(
        postgres.query(
          `update tenant_runtime_policies
              set maximum_tokens_per_run = 1000
            where tenant_id = $1`,
          [tenant],
        ),
      ).rejects.toThrow();
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
