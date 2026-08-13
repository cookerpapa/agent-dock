import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  upCodingRunModelRequestLimit,
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

describe("coding Run model request limit migration", () => {
  it("raises only the legacy default to match multi-step Tool execution", async () => {
    const postgres = await PGlite.create();
    try {
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
      await postgres.query(
        `insert into tenants (id, slug) values
          ('10000000-0000-4000-8000-000000000001', 'legacy-default'),
          ('20000000-0000-4000-8000-000000000001', 'managed')`,
      );
      await postgres.query(
        `insert into credential_bindings
          (id, tenant_id, provider, kind, secret_ref, status)
         values
          ('10000000-0000-4000-8000-000000000003',
           '10000000-0000-4000-8000-000000000001', 'agent-dock-fake', 'brokered',
           'fixture-a', 'active'),
          ('20000000-0000-4000-8000-000000000003',
           '20000000-0000-4000-8000-000000000001', 'agent-dock-fake', 'brokered',
           'fixture-b', 'active')`,
      );
      await postgres.query(
        `insert into model_profiles (id, tenant_id, name, provider, model_id,
          default_thinking_level, allowed_thinking_levels, credential_binding_id,
          credential_binding_version)
         values
          ('10000000-0000-4000-8000-000000000002',
           '10000000-0000-4000-8000-000000000001', 'default', 'agent-dock-fake',
           'agent-dock-fake', 'off', array['off'],
           '10000000-0000-4000-8000-000000000003', 1),
          ('20000000-0000-4000-8000-000000000002',
           '20000000-0000-4000-8000-000000000001', 'default', 'agent-dock-fake',
           'agent-dock-fake', 'off', array['off'],
           '20000000-0000-4000-8000-000000000003', 1)`,
      );
      await postgres.query(
        `insert into tenant_runtime_policies (tenant_id, default_model_profile_id)
         values
          ('10000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000002'),
          ('20000000-0000-4000-8000-000000000001',
           '20000000-0000-4000-8000-000000000002')`,
      );
      await postgres.query(
        `update tenant_runtime_policies
            set maximum_model_requests_per_run = 48,
                updated_at = updated_at + interval '1 second'
          where tenant_id = '20000000-0000-4000-8000-000000000001'`,
      );

      await applyCompiledQueries(postgres, await compileMigration(upCodingRunModelRequestLimit));
      const rows = await postgres.query<{
        maximum_model_requests_per_run: number;
        tenant_id: string;
      }>(
        `select tenant_id, maximum_model_requests_per_run
           from tenant_runtime_policies order by tenant_id`,
      );
      expect(rows.rows).toEqual([
        {
          tenant_id: "10000000-0000-4000-8000-000000000001",
          maximum_model_requests_per_run: 128,
        },
        {
          tenant_id: "20000000-0000-4000-8000-000000000001",
          maximum_model_requests_per_run: 48,
        },
      ]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
