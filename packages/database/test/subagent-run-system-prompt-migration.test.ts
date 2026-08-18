import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downSubagentRunSystemPrompt, upSubagentRunSystemPrompt } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("Subagent Run system-prompt migration", () => {
  it("stores one bounded immutable Run prompt without changing ordinary Runs", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table runs (id uuid primary key);
        insert into runs values ('00000000-0000-4000-8000-000000000001');
      `);
      await applyCompiledQueries(postgres, await compileMigration(upSubagentRunSystemPrompt));
      const initial = await postgres.query<{ agent_system_prompt: string | null }>(`
        select agent_system_prompt from runs
      `);
      expect(initial.rows).toEqual([{ agent_system_prompt: null }]);
      await postgres.exec(`update runs set agent_system_prompt = 'Review only'`);
      await expect(postgres.exec(`update runs set agent_system_prompt = ''`)).rejects.toThrow();
      await applyCompiledQueries(postgres, await compileMigration(downSubagentRunSystemPrompt));
    } finally {
      await postgres.close();
    }
  });
});
