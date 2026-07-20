import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downVersionedWorkspacesAndGitHubDelivery,
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
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

describe("versioned Workspace and GitHub delivery migration", () => {
  it("creates the immutable history, integration, result and audit tables", async () => {
    const postgres = await fixture();
    try {
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'workspace_versions', 'workspace_operations', 'test_results',
              'github_app_installations', 'github_repositories',
              'github_pull_request_deliveries', 'github_webhook_deliveries'
            )
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "github_app_installations",
        "github_pull_request_deliveries",
        "github_repositories",
        "github_webhook_deliveries",
        "test_results",
        "workspace_operations",
        "workspace_versions",
      ]);
      const columns = await postgres.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'sessions'
            and column_name in ('current_workspace_version_id', 'forked_from_session_id', 'archived_at')
          order by column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "archived_at",
        "current_workspace_version_id",
        "forked_from_session_id",
      ]);
    } finally {
      await postgres.close();
    }
  }, 30_000);

  it("enforces global installation ownership and rolls back only milestone tables", async () => {
    const postgres = await fixture();
    try {
      const tenantOne = "10000000-0000-4000-8000-000000000001";
      const tenantTwo = "10000000-0000-4000-8000-000000000002";
      await postgres.query(
        "insert into tenants (id, slug) values ($1, 'github-one'), ($2, 'github-two')",
        [tenantOne, tenantTwo],
      );
      await postgres.query(
        `insert into github_app_installations
          (tenant_id, installation_id, account_id, account_login, target_type,
           repository_selection, permissions)
         values ($1, 7, 9, 'acme', 'Organization', 'selected', '{}'::jsonb)`,
        [tenantOne],
      );
      await expect(
        postgres.query(
          `insert into github_app_installations
            (tenant_id, installation_id, account_id, account_login, target_type,
             repository_selection, permissions)
           values ($1, 7, 10, 'other', 'Organization', 'selected', '{}'::jsonb)`,
          [tenantTwo],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downVersionedWorkspacesAndGitHubDelivery),
      );
      const remaining = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('sessions', 'workspace_versions', 'github_app_installations')
          order by table_name`,
      );
      expect(remaining.rows.map((row) => row.table_name)).toEqual(["sessions"]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
