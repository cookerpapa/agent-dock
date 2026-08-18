import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downToollessRunCapabilities,
  upRunToolCapabilitySnapshots,
  upToollessRunCapabilities,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("Tool-free Run capabilities migration", () => {
  it("allows an explicit empty grant while preserving the bounded allowlist", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (id uuid primary key);
        create table runs (id uuid primary key);
        insert into sessions values ('00000000-0000-4000-8000-000000000001');
        insert into runs values ('00000000-0000-4000-8000-000000000002');
      `);
      await applyCompiledQueries(postgres, await compileMigration(upRunToolCapabilitySnapshots));
      await applyCompiledQueries(postgres, await compileMigration(upToollessRunCapabilities));

      await postgres.exec(`
        update sessions set tool_capabilities = '[]'::jsonb;
        update runs set tool_capability_snapshot = '[]'::jsonb;
      `);
      await expect(
        postgres.exec(`update runs set tool_capability_snapshot = '["admin"]'::jsonb`),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downToollessRunCapabilities));
      const restored = await postgres.query<{ session_tools: string[]; run_tools: string[] }>(`
        select session.tool_capabilities as session_tools,
               run.tool_capability_snapshot as run_tools
        from sessions session cross join runs run
      `);
      expect(restored.rows).toEqual([
        {
          session_tools: ["read", "write", "edit", "bash"],
          run_tools: ["read", "write", "edit", "bash"],
        },
      ]);
    } finally {
      await postgres.close();
    }
  });
});
