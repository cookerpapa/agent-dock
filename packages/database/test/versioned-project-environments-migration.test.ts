import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downVersionedProjectEnvironments,
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
  upVersionedProjectEnvironments,
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

describe("versioned project environments migration", () => {
  it("backfills one active immutable environment and enforces the Run snapshot column", async () => {
    const postgres = await fixture();
    try {
      const tenant = "10000000-0000-4000-8000-000000000001";
      const project = "20000000-0000-4000-8000-000000000001";
      await postgres.query("insert into tenants (id, slug) values ($1, 'environment-owner')", [
        tenant,
      ]);
      await postgres.query(
        "insert into projects (id, tenant_id, name) values ($1, $2, 'Environment')",
        [project, tenant],
      );

      await applyCompiledQueries(postgres, await compileMigration(upVersionedProjectEnvironments));

      const environments = await postgres.query<{
        id: string;
        version_number: number;
        profile_key: string;
        profile_version: string;
        image_revision: string;
        state: string;
        active: boolean;
      }>(
        `select id, version_number, profile_key, profile_version, image_revision, state, active
           from environment_versions where tenant_id = $1 and project_id = $2`,
        [tenant, project],
      );
      expect(environments.rows).toEqual([
        {
          id: project,
          version_number: 1,
          profile_key: "pi-cloud-fullstack",
          profile_version: "1",
          image_revision: "legacy",
          state: "pending",
          active: true,
        },
      ]);
      const runColumn = await postgres.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'runs'
            and column_name = 'environment_version_id'`,
      );
      expect(runColumn.rows).toEqual([{ is_nullable: "NO" }]);
      await expect(
        postgres.query(
          `insert into environment_versions
            (id, tenant_id, project_id, version_number, profile_key, profile_version,
             image_revision, spec_sha256, state, active)
           values ('30000000-0000-4000-8000-000000000001', $1, $2, 2,
                   'pi-cloud-fullstack', '1', 'next',
                   'e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630',
                   'pending', true)`,
          [tenant, project],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downVersionedProjectEnvironments),
      );
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('environment_versions', 'environment_validations')`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
