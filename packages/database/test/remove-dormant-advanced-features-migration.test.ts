import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downRemoveDormantAdvancedFeatures,
  migrationProvider,
  upRemoveDormantAdvancedFeatures,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const RETIRED_TABLES = [
  "run_rewinds",
  "review_bundles",
  "orchestration_runs",
  "orchestration_candidates",
  "orchestration_dispatches",
  "orchestration_acceptance_results",
  "orchestration_decision_gates",
  "candidate_promotions",
] as const;

describe("dormant advanced-feature retirement", () => {
  it("removes candidate-race, rewind, and review tables", async () => {
    const postgres = await PGlite.create();
    try {
      const migrations = await migrationProvider.getMigrations();
      for (const [name, migration] of Object.entries(migrations).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        if (name.localeCompare("022_horizontal_supervisor_pool") >= 0) continue;
        await applyCompiledQueries(postgres, await compileMigration(migration.up));
      }

      await applyCompiledQueries(postgres, await compileMigration(upRemoveDormantAdvancedFeatures));
      const result = await postgres.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = any($1::text[])`,
        [RETIRED_TABLES],
      );
      expect(result.rows).toEqual([]);
      await expect(compileMigration(downRemoveDormantAdvancedFeatures)).rejects.toThrow(
        /intentional destructive cleanup/,
      );
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
