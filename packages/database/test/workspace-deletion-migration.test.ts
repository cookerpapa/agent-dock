import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downWorkspaceDeletion, migrationProvider, upWorkspaceDeletion } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const REPLACEMENT_PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";

describe("Workspace deletion migration", () => {
  it("adds tombstones, idempotent deletion records, and reusable live project names", async () => {
    const postgres = await PGlite.create();
    try {
      const migrations = await migrationProvider.getMigrations();
      const initial = migrations["001_initial_control_plane"];
      if (initial === undefined) throw new Error("Initial migration was unavailable");
      await applyCompiledQueries(postgres, await compileMigration(initial.up));
      await applyCompiledQueries(postgres, await compileMigration(upWorkspaceDeletion));
      await postgres.query("insert into tenants (id, slug) values ($1, 'workspace-delete')", [
        TENANT_ID,
      ]);
      await postgres.query(
        "insert into projects (id, tenant_id, name) values ($1, $2, 'Disposable')",
        [PROJECT_ID, TENANT_ID],
      );
      await postgres.query(
        `insert into workspaces (id, tenant_id, project_id)
         values ($1, $2, $3)`,
        [WORKSPACE_ID, TENANT_ID, PROJECT_ID],
      );

      await expect(
        postgres.query("update workspaces set storage_purged_at = now() where id = $1", [
          WORKSPACE_ID,
        ]),
      ).rejects.toThrow(/workspaces_storage_purge_shape/);
      await postgres.query("update projects set deleted_at = now() where id = $1", [PROJECT_ID]);
      await postgres.query("update workspaces set deleted_at = now() where id = $1", [
        WORKSPACE_ID,
      ]);
      await expect(
        postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Disposable')", [
          REPLACEMENT_PROJECT_ID,
          TENANT_ID,
        ]),
      ).resolves.toBeDefined();
      await expect(
        postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Disposable')", [
          "20000000-0000-4000-8000-000000000003",
          TENANT_ID,
        ]),
      ).rejects.toThrow(/projects_tenant_live_name_unique/);

      await postgres.query(
        `insert into workspace_delete_operations
          (operation_id, tenant_id, workspace_id, idempotency_key, deleted_at)
         values ($1, $2, $3, 'delete-once', now())`,
        [OPERATION_ID, TENANT_ID, WORKSPACE_ID],
      );
      await expect(
        postgres.query(
          `insert into workspace_delete_operations
            (operation_id, tenant_id, workspace_id, idempotency_key, deleted_at)
           values ($1, $2, $3, 'delete-once', now())`,
          ["40000000-0000-4000-8000-000000000002", TENANT_ID, WORKSPACE_ID],
        ),
      ).rejects.toThrow(/workspace_delete_operations_scope_key_unique/);

      await postgres.query("delete from workspace_delete_operations");
      await postgres.query("delete from projects where id = $1", [REPLACEMENT_PROJECT_ID]);
      await applyCompiledQueries(postgres, await compileMigration(downWorkspaceDeletion));
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
