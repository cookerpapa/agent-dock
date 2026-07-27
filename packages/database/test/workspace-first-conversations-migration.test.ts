import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downWorkspaceFirstConversations, upWorkspaceFirstConversations } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("Workspace-first conversations migration", () => {
  it("backfills independent conversation titles and enforces the title boundary", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table projects (
          id uuid not null,
          tenant_id uuid not null,
          name text not null,
          primary key (tenant_id, id)
        );
        create table sessions (
          id uuid primary key,
          tenant_id uuid not null,
          project_id uuid not null
        );
      `);
      const tenant = "10000000-0000-4000-8000-000000000001";
      const project = "20000000-0000-4000-8000-000000000001";
      const session = "30000000-0000-4000-8000-000000000001";
      await postgres.query(
        `insert into projects (id, tenant_id, name) values ($1, $2, 'Order service')`,
        [project, tenant],
      );
      await postgres.query(`insert into sessions (id, tenant_id, project_id) values ($1, $2, $3)`, [
        session,
        tenant,
        project,
      ]);

      await applyCompiledQueries(postgres, await compileMigration(upWorkspaceFirstConversations));
      expect(
        (
          await postgres.query<{ title: string }>("select title from sessions where id = $1", [
            session,
          ])
        ).rows,
      ).toEqual([{ title: "Order service" }]);
      await expect(
        postgres.query("update sessions set title = '' where id = $1", [session]),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downWorkspaceFirstConversations));
      const columns = await postgres.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sessions'
            and column_name = 'title'`,
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 20_000);
});
