import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downContextAndModelGovernance,
  upContextAndModelGovernance,
  upControlledWorkspaceSources,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upEncryptedTenantModelCredentials,
  upExplicitSessionMailbox,
  upInitialControlPlane,
  upPrivateMultiTenantIdentity,
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
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

describe("context and model governance migration", () => {
  it("creates durable reservations, rates, routes and compaction history", async () => {
    const postgres = await fixture();
    try {
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'model_rates', 'model_routing_policies', 'model_requests',
              'context_compactions'
            )
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "context_compactions",
        "model_rates",
        "model_requests",
        "model_routing_policies",
      ]);

      const tenant = "10000000-0000-4000-8000-000000000001";
      const credential = "20000000-0000-4000-8000-000000000001";
      const profile = "30000000-0000-4000-8000-000000000001";
      await postgres.query("insert into tenants (id, slug) values ($1, 'governed')", [tenant]);
      await postgres.query(
        `insert into credential_bindings
          (id, tenant_id, provider, kind, secret_ref, status)
         values ($1, $2, 'agent-dock-fake', 'brokered', 'fixture', 'active')`,
        [credential, tenant],
      );
      await postgres.query(
        `insert into model_profiles
          (id, tenant_id, name, provider, model_id, default_thinking_level,
           allowed_thinking_levels, credential_binding_id, credential_binding_version)
         values ($1, $2, 'default', 'agent-dock-fake', 'agent-dock-fake', 'off',
                 array['off'], $3, 1)`,
        [profile, tenant, credential],
      );
      await postgres.query(
        `insert into tenant_runtime_policies (tenant_id, default_model_profile_id)
         values ($1, $2)`,
        [tenant, profile],
      );
      const defaults = await postgres.query<{
        maximum_model_requests_per_run: number;
        maximum_tokens_per_run: number;
        maximum_tool_calls_per_run: number;
        maximum_run_duration_ms: number;
        compaction_keep_recent_tokens: number;
      }>(
        `select maximum_model_requests_per_run, maximum_tokens_per_run,
                maximum_tool_calls_per_run, maximum_run_duration_ms,
                compaction_keep_recent_tokens
           from tenant_runtime_policies where tenant_id = $1`,
        [tenant],
      );
      expect(defaults.rows).toEqual([
        {
          maximum_model_requests_per_run: 32,
          maximum_tokens_per_run: 200_000,
          maximum_tool_calls_per_run: 128,
          maximum_run_duration_ms: 900_000,
          compaction_keep_recent_tokens: 20_000,
        },
      ]);
      await expect(
        postgres.query(
          `update tenant_runtime_policies
              set maximum_tokens_per_run = 1000,
                  compaction_reserve_tokens = 1024,
                  compaction_keep_recent_tokens = 1024
            where tenant_id = $1`,
          [tenant],
        ),
      ).rejects.toThrow();
    } finally {
      await postgres.close();
    }
  }, 30_000);

  it("rolls back governance without removing durable runs or legacy usage", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(downContextAndModelGovernance));
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('runs', 'usage_ledger', 'model_requests', 'context_compactions')
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["runs", "usage_ledger"]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
