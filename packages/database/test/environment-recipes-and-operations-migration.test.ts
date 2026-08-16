import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downEnvironmentRecipesAndOperations,
  upContextAndModelGovernance,
  upControlledWorkspaceSources,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upEncryptedTenantModelCredentials,
  upEnvironmentRecipesAndOperations,
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

describe("environment recipes and operations migration", () => {
  it("backfills immutable recipes, audits operations, and preserves the prior environment plane on rollback", async () => {
    const postgres = await fixture();
    const tenant = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const project = "30000000-0000-4000-8000-000000000001";
    const failedEnvironment = "40000000-0000-4000-8000-000000000001";
    try {
      await postgres.query("insert into tenants (id, slug) values ($1, 'environment-recipes')", [
        tenant,
      ]);
      await postgres.query(
        "insert into users (id, tenant_id, display_name) values ($1, $2, 'Environment Owner')",
        [user, tenant],
      );
      await postgres.query(
        "insert into projects (id, tenant_id, name) values ($1, $2, 'Environment Recipes')",
        [project, tenant],
      );
      await applyCompiledQueries(postgres, await compileMigration(upVersionedProjectEnvironments));
      await postgres.query(
        `insert into environment_versions
          (id, tenant_id, project_id, version_number, profile_key, profile_version,
           image_revision, spec_sha256, state, active)
         values ($1, $2, $3, 2, 'pi-cloud-fullstack', '1', 'development',
                 'e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630',
                 'failed', false)`,
        [failedEnvironment, tenant, project],
      );

      await applyCompiledQueries(
        postgres,
        await compileMigration(upEnvironmentRecipesAndOperations),
      );

      const environments = await postgres.query<{
        id: string;
        recipe: unknown;
        recipe_sha256: string;
        failure_code: string | null;
      }>(
        `select id, recipe, recipe_sha256, failure_code
           from environment_versions
          where tenant_id = $1 and project_id = $2
          order by version_number`,
        [tenant, project],
      );
      expect(environments.rows).toMatchObject([
        {
          id: project,
          recipe: {
            schemaVersion: 1,
            setupCommands: [],
            verificationCommands: [{ id: "git-worktree" }],
          },
          recipe_sha256: "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d",
          failure_code: null,
        },
        {
          id: failedEnvironment,
          failure_code: "legacy_environment_validation_failed",
        },
      ]);

      const operation = "50000000-0000-4000-8000-000000000001";
      await postgres.query(
        `insert into environment_operations
          (id, tenant_id, project_id, actor_user_id, kind,
           from_environment_version_id, to_environment_version_id,
           idempotency_key, request_fingerprint)
         values ($1, $2, $3, $4, 'rollback', $5, $6, 'rollback-1', $7)`,
        [operation, tenant, project, user, failedEnvironment, project, "a".repeat(64)],
      );
      await expect(
        postgres.query(
          `insert into environment_operations
            (id, tenant_id, project_id, actor_user_id, kind,
             from_environment_version_id, to_environment_version_id,
             idempotency_key, request_fingerprint)
           values ('50000000-0000-4000-8000-000000000002', $1, $2, $3,
                   'activate', $4, $5, 'rollback-1', $6)`,
          [tenant, project, user, project, failedEnvironment, "b".repeat(64)],
        ),
      ).rejects.toThrow();
      await expect(
        postgres.query("update environment_versions set state = 'pending' where id = $1", [
          failedEnvironment,
        ]),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downEnvironmentRecipesAndOperations),
      );
      const operationTables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name = 'environment_operations'`,
      );
      expect(operationTables.rows).toEqual([]);
      const environmentColumns = await postgres.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'environment_versions'
            and column_name in ('recipe', 'recipe_sha256', 'failure_code', 'created_by_user_id')`,
      );
      expect(environmentColumns.rows).toEqual([]);
      const environmentTable = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name = 'environment_versions'`,
      );
      expect(environmentTable.rows).toEqual([{ table_name: "environment_versions" }]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
