import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downProductAuthAndEmptyWorkspaces,
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
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

describe("product authentication and empty Workspace migration", () => {
  it("enforces hashed account/session rows and a clean empty source, then rolls back safely", async () => {
    const postgres = await fixture();
    try {
      const tenant = "10000000-0000-4000-8000-000000000001";
      const user = "20000000-0000-4000-8000-000000000001";
      const binding = "30000000-0000-4000-8000-000000000001";
      const profile = "40000000-0000-4000-8000-000000000001";
      const project = "50000000-0000-4000-8000-000000000001";
      const workspace = "60000000-0000-4000-8000-000000000001";
      const webSession = "70000000-0000-4000-8000-000000000001";
      await postgres.query("insert into tenants (id, slug) values ($1, 'product-user')", [tenant]);
      await postgres.query(
        "insert into users (id, tenant_id, display_name) values ($1, $2, 'Product User')",
        [user, tenant],
      );
      await postgres.query(
        `insert into credential_bindings
          (id, tenant_id, provider, kind, secret_ref, version, status)
         values ($1, $2, 'agent-dock-fake', 'brokered', 'fixture', 1, 'active')`,
        [binding, tenant],
      );
      await postgres.query(
        `insert into model_profiles
          (id, tenant_id, name, provider, model_id, default_thinking_level,
           allowed_thinking_levels, credential_binding_id, credential_binding_version)
         values ($1, $2, 'default', 'agent-dock-fake', 'agent-dock-fake', 'off',
                 array['off'], $3, 1)`,
        [profile, tenant, binding],
      );
      await postgres.query(
        "insert into tenant_runtime_policies (tenant_id, default_model_profile_id) values ($1, $2)",
        [tenant, profile],
      );
      await postgres.query(
        `insert into user_password_credentials
          (username, tenant_id, user_id, role, password_salt, password_hash,
           scrypt_n, scrypt_r, scrypt_p)
         values ('alice.dev', $1, $2, 'owner', $3, $4, 16384, 8, 1)`,
        [tenant, user, "a".repeat(22), "b".repeat(43)],
      );
      await postgres.query(
        `insert into web_sessions
          (session_id, tenant_id, user_id, role, secret_sha256, expires_at)
         values ($1, $2, $3, 'owner', $4, now() + interval '1 day')`,
        [webSession, tenant, user, "c".repeat(64)],
      );
      await expect(
        postgres.query(
          `insert into user_password_credentials
            (username, tenant_id, user_id, role, password_salt, password_hash,
             scrypt_n, scrypt_r, scrypt_p)
           values ('Bad User', $1, $2, 'owner', 'plaintext', 'plaintext', 1, 1, 1)`,
          [tenant, user],
        ),
      ).rejects.toThrow();

      await postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Chat')", [
        project,
        tenant,
      ]);
      await postgres.query(
        "insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)",
        [workspace, tenant, project],
      );
      await postgres.query(
        "insert into workspace_sources (tenant_id, workspace_id, kind, status) values ($1, $2, 'empty', 'ready')",
        [tenant, workspace],
      );
      expect(
        (
          await postgres.query<{ kind: string }>(
            "select kind from workspace_sources where tenant_id = $1 and workspace_id = $2",
            [tenant, workspace],
          )
        ).rows,
      ).toEqual([{ kind: "empty" }]);

      await applyCompiledQueries(
        postgres,
        await compileMigration(downProductAuthAndEmptyWorkspaces),
      );
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('user_password_credentials', 'web_sessions')`,
      );
      expect(tables.rows).toEqual([]);
      expect(
        (
          await postgres.query<{ kind: string }>(
            "select kind from workspace_sources where tenant_id = $1 and workspace_id = $2",
            [tenant, workspace],
          )
        ).rows,
      ).toEqual([{ kind: "sample_java" }]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
