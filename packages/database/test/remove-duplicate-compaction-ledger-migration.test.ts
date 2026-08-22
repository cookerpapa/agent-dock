import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downRemoveDuplicateCompactionLedger,
  upRemoveDuplicateCompactionLedger,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("duplicate compaction ledger cleanup", () => {
  it("removes the obsolete second source of compaction truth", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec("create table context_compactions (id uuid primary key)");
      await applyCompiledQueries(
        postgres,
        await compileMigration(upRemoveDuplicateCompactionLedger),
      );
      const result = await postgres.query<{ relation: string | null }>(
        "select to_regclass('public.context_compactions')::text as relation",
      );
      expect(result.rows).toEqual([{ relation: null }]);
      await expect(compileMigration(downRemoveDuplicateCompactionLedger)).rejects.toThrow(
        "intentional destructive cleanup",
      );
    } finally {
      await postgres.close();
    }
  });
});
