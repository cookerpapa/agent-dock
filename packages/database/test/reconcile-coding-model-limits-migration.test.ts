import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
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
  upReconcileCodingModelLimits,
  upRemovePerRunTokenBudget,
  upSupervisorBootCredentials,
  upSupervisorConnectionHealth,
  upVersionedWorkspacesAndGitHubDelivery,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("coding model limit reconciliation", () => {
  it("repairs exact legacy defaults even when another policy field was edited", async () => {
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
        `insert into tenants (id, slug)
         values ('10000000-0000-4000-8000-000000000001', 'edited-policy')`,
      );
      await postgres.query(
        `insert into credential_bindings
          (id, tenant_id, provider, kind, secret_ref, status)
         values ('10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001', 'pi-cloud-fake', 'brokered',
          'fixture', 'active')`,
      );
      await postgres.query(
        `insert into model_profiles
          (id, tenant_id, name, provider, model_id, default_thinking_level,
           allowed_thinking_levels, credential_binding_id, credential_binding_version)
         values ('10000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001', 'default', 'pi-cloud-fake',
          'pi-cloud-fake', 'off', array['off'],
          '10000000-0000-4000-8000-000000000003', 1)`,
      );
      await postgres.query(
        `insert into tenant_runtime_policies (tenant_id, default_model_profile_id)
         values ('10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000002')`,
      );
      await postgres.query(
        `update tenant_runtime_policies
            set maximum_concurrent_turns = 2,
                updated_at = updated_at + interval '1 second'
          where tenant_id = '10000000-0000-4000-8000-000000000001'`,
      );

      await applyCompiledQueries(postgres, await compileMigration(upReconcileCodingModelLimits));
      const result = await postgres.query<{
        daily_token_budget: number;
        maximum_model_requests_per_run: number;
        maximum_concurrent_turns: number;
      }>(
        `select daily_token_budget, maximum_model_requests_per_run, maximum_concurrent_turns
           from tenant_runtime_policies`,
      );
      expect(result.rows).toEqual([
        {
          daily_token_budget: 1_000_000_000_000,
          maximum_model_requests_per_run: 128,
          maximum_concurrent_turns: 2,
        },
      ]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
