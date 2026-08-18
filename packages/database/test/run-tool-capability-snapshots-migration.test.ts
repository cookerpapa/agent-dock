import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downRunToolCapabilitySnapshots, upRunToolCapabilitySnapshots } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("Run Tool capability snapshots migration", () => {
  it("adds bounded Session grants and independent Run snapshots", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (id uuid primary key);
        create table runs (id uuid primary key);
        insert into sessions values ('00000000-0000-4000-8000-000000000001');
        insert into runs values ('00000000-0000-4000-8000-000000000002');
      `);
      await applyCompiledQueries(postgres, await compileMigration(upRunToolCapabilitySnapshots));

      const defaults = await postgres.query<{
        session_tools: string[];
        run_tools: string[];
      }>(`
        select session.tool_capabilities as session_tools,
               run.tool_capability_snapshot as run_tools
        from sessions session cross join runs run
      `);
      expect(defaults.rows).toEqual([
        {
          session_tools: ["read", "write", "edit", "bash"],
          run_tools: ["read", "write", "edit", "bash"],
        },
      ]);

      await postgres.exec(`
        update sessions set tool_capabilities = '["read"]'::jsonb;
        update runs set tool_capability_snapshot = '["read","bash"]'::jsonb;
      `);
      await expect(
        postgres.exec(`update runs set tool_capability_snapshot = '["mcp.admin"]'::jsonb`),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downRunToolCapabilitySnapshots));
      const columns = await postgres.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_name in ('sessions','runs') and column_name like 'tool_%'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  });
});
