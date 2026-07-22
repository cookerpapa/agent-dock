import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downMultiRepositorySourceSets,
  upContextAndModelGovernance,
  upControlledWorkspaceSources,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upEncryptedTenantModelCredentials,
  upEnvironmentRecipesAndOperations,
  upExplicitSessionMailbox,
  upInitialControlPlane,
  upMultiRepositorySourceSets,
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

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  profile: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
  turn: "70000000-0000-4000-8000-000000000001",
  command: "80000000-0000-4000-8000-000000000001",
  outbox: "90000000-0000-4000-8000-000000000001",
  setProject: "20000000-0000-4000-8000-000000000002",
  setWorkspace: "30000000-0000-4000-8000-000000000002",
} as const;

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
  await applyCompiledQueries(postgres, await compileMigration(upDurableEventDelivery));

  await postgres.query("insert into tenants (id, slug) values ($1, 'source-set-owner')", [
    IDS.tenant,
  ]);
  await postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Legacy')", [
    IDS.project,
    IDS.tenant,
  ]);
  await postgres.query("insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)", [
    IDS.workspace,
    IDS.tenant,
    IDS.project,
  ]);
  await postgres.query(
    `insert into credential_bindings
       (id, tenant_id, provider, kind, secret_ref, version, status)
     values ($1, $2, 'agent-dock-fake', 'brokered', 'fixture', 1, 'active')`,
    [IDS.credential, IDS.tenant],
  );
  await postgres.query(
    `insert into model_profiles
       (id, tenant_id, name, provider, model_id, default_thinking_level,
        allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'default', 'agent-dock-fake', 'agent-dock-fake', 'off',
             array['off'], $3, 1)`,
    [IDS.profile, IDS.tenant, IDS.credential],
  );
  await postgres.query(
    `insert into sessions
       (id, tenant_id, project_id, workspace_id, desired_model_profile_id, state)
     values ($1, $2, $3, $4, $5, 'idle')`,
    [IDS.session, IDS.tenant, IDS.project, IDS.workspace, IDS.profile],
  );
  await postgres.query(
    `insert into turns
       (id, tenant_id, session_id, state, input_kind, input_text, model_profile_id,
        provider, model_id, thinking_level, credential_binding_id,
        credential_binding_version, stop_reason, started_at, settled_at)
     values ($1, $2, $3, 'completed', 'prompt', 'legacy run', $4,
             'agent-dock-fake', 'agent-dock-fake', 'off', $5, 1,
             'stop', now() - interval '1 second', now())`,
    [IDS.turn, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
  );
  await postgres.query(
    `insert into commands
       (id, tenant_id, session_id, turn_id, idempotency_key, kind, state, payload,
        dispatched_at, acknowledged_at, completed_at)
     values ($1::uuid, $2, $3, $4, 'legacy-run', 'turn.execute', 'completed',
             jsonb_build_object('commandId', ($1::uuid)::text), now(), now(), now())`,
    [IDS.command, IDS.tenant, IDS.session, IDS.turn],
  );
  await postgres.query(
    `insert into outbox
       (id, tenant_id, aggregate_type, aggregate_id, topic, payload, attempts, published_at)
     values ($1, $2, 'session', $3, 'turn.command.requested',
             jsonb_build_object('commandId', $4::text), 1, now())`,
    [IDS.outbox, IDS.tenant, IDS.session, IDS.command],
  );

  for (const migration of [
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
    upVersionedProjectEnvironments,
    upEnvironmentRecipesAndOperations,
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

describe("multi-repository source-set migration", () => {
  it("backfills immutable Run input, constrains repository roots, and refuses lossy rollback", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(upMultiRepositorySourceSets));

      const legacy = await postgres.query<{ source_set_snapshot: unknown }>(
        "select source_set_snapshot from runs where id = $1",
        [IDS.turn],
      );
      expect(legacy.rows).toEqual([
        {
          source_set_snapshot: {
            schemaVersion: 1,
            entries: [{ root: ".", kind: "sample_java" }],
          },
        },
      ]);

      await postgres.query(
        "insert into projects (id, tenant_id, name) values ($1, $2, 'Repository Set')",
        [IDS.setProject, IDS.tenant],
      );
      await postgres.query(
        "insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)",
        [IDS.setWorkspace, IDS.tenant, IDS.setProject],
      );
      await postgres.query(
        `insert into workspace_sources (tenant_id, workspace_id, kind, status)
         values ($1, $2, 'repository_set', 'pending')`,
        [IDS.tenant, IDS.setWorkspace],
      );
      await postgres.query(
        `insert into workspace_repository_sources
          (tenant_id, workspace_id, ordinal, root_path, kind, repository, commit_sha)
         values
          ($1, $2, 1, 'web', 'github_public', 'octocat/frontend', $3),
          ($1, $2, 2, 'api', 'github_public', 'octocat/backend', $4)`,
        [IDS.tenant, IDS.setWorkspace, "a".repeat(40), "b".repeat(40)],
      );
      const repositories = await postgres.query<{
        root_path: string;
        repository: string;
      }>(
        `select root_path, repository from workspace_repository_sources
          where tenant_id = $1 and workspace_id = $2 order by ordinal`,
        [IDS.tenant, IDS.setWorkspace],
      );
      expect(repositories.rows).toEqual([
        { root_path: "web", repository: "octocat/frontend" },
        { root_path: "api", repository: "octocat/backend" },
      ]);

      await expect(
        postgres.query(
          `insert into workspace_repository_sources
            (tenant_id, workspace_id, ordinal, root_path, kind, repository, commit_sha)
           values ($1, $2, 3, 'web', 'github_public', 'octocat/duplicate-root', $3)`,
          [IDS.tenant, IDS.setWorkspace, "c".repeat(40)],
        ),
      ).rejects.toThrow();
      await expect(
        applyCompiledQueries(postgres, await compileMigration(downMultiRepositorySourceSets)),
      ).rejects.toThrow(/cannot roll back multi-repository source sets/);

      await postgres.query(
        "delete from workspace_sources where tenant_id = $1 and workspace_id = $2",
        [IDS.tenant, IDS.setWorkspace],
      );
      await applyCompiledQueries(postgres, await compileMigration(downMultiRepositorySourceSets));
      const residual = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name = 'workspace_repository_sources'`,
      );
      expect(residual.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
