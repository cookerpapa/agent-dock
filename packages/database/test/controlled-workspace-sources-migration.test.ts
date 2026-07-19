import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downControlledWorkspaceSources,
  upControlledWorkspaceSources,
  upInitialControlPlane,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
  await postgres.query("insert into tenants (id, slug) values ($1, 'workspace-owner')", [
    TENANT_ID,
  ]);
  await postgres.query(
    "insert into projects (id, tenant_id, name) values ($1, $2, 'Existing project')",
    [PROJECT_ID, TENANT_ID],
  );
  await postgres.query("insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)", [
    WORKSPACE_ID,
    TENANT_ID,
    PROJECT_ID,
  ]);
  await applyCompiledQueries(postgres, await compileMigration(upControlledWorkspaceSources));
  return postgres;
}

describe("controlled workspace source migration", () => {
  it("backfills existing workspaces as ready built-in samples", async () => {
    const postgres = await fixture();
    try {
      const result = await postgres.query<{
        kind: string;
        status: string;
        repository: string | null;
      }>(
        "select kind, status, repository from workspace_sources where tenant_id = $1 and workspace_id = $2",
        [TENANT_ID, WORKSPACE_ID],
      );
      expect(result.rows).toEqual([{ kind: "sample_java", status: "ready", repository: null }]);
    } finally {
      await postgres.close();
    }
  }, 15_000);

  it("enforces an exact public GitHub source and coherent import state", async () => {
    const postgres = await fixture();
    const projectId = "20000000-0000-4000-8000-000000000002";
    const workspaceId = "30000000-0000-4000-8000-000000000002";
    try {
      await postgres.query(
        "insert into projects (id, tenant_id, name) values ($1, $2, 'GitHub project')",
        [projectId, TENANT_ID],
      );
      await postgres.query(
        "insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)",
        [workspaceId, TENANT_ID, projectId],
      );
      await postgres.query(
        `insert into workspace_sources
           (tenant_id, workspace_id, kind, repository, commit_sha, status)
         values ($1, $2, 'github_public', 'octocat/hello-world', $3, 'pending')`,
        [TENANT_ID, workspaceId, "a".repeat(40)],
      );
      await expect(
        postgres.query(
          `update workspace_sources
              set status = 'ready'
            where tenant_id = $1 and workspace_id = $2`,
          [TENANT_ID, workspaceId],
        ),
      ).rejects.toThrow();
      await expect(
        postgres.query(
          `update workspace_sources
              set repository = 'https://github.com/octocat/hello-world'
            where tenant_id = $1 and workspace_id = $2`,
          [TENANT_ID, workspaceId],
        ),
      ).rejects.toThrow();
    } finally {
      await postgres.close();
    }
  }, 15_000);

  it("drops only the source metadata table on rollback", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(downControlledWorkspaceSources));
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name in ('workspaces', 'workspace_sources')
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["workspaces"]);
    } finally {
      await postgres.close();
    }
  }, 15_000);
});
