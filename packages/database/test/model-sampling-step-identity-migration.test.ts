import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downModelSamplingStepIdentity, upModelSamplingStepIdentity } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("model sampling Step identity migration", () => {
  it("adds one optional historical identity and a unique live Step attempt", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table model_requests (
          id uuid primary key,
          run_id uuid not null,
          attempt_id uuid not null
        );
      `);
      await applyCompiledQueries(postgres, await compileMigration(upModelSamplingStepIdentity));

      await postgres.exec(`
        insert into model_requests (
          id, run_id, attempt_id,
          step_context_sequence, step_context_sha256, sampling_attempt
        ) values (
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          1, repeat('a', 64), 1
        );
      `);
      await expect(
        postgres.exec(`
          insert into model_requests (
            id, run_id, attempt_id,
            step_context_sequence, step_context_sha256, sampling_attempt
          ) values (
            '10000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            1, repeat('a', 64), 1
          );
        `),
      ).rejects.toThrow();
      await expect(
        postgres.exec(`
          insert into model_requests (
            id, run_id, attempt_id,
            step_context_sequence, step_context_sha256, sampling_attempt
          ) values (
            '10000000-0000-4000-8000-000000000003',
            '20000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            0, repeat('b', 64), 1
          );
        `),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downModelSamplingStepIdentity));
      const columns = await postgres.query<{ column_name: string }>(`
        select column_name from information_schema.columns
         where table_name = 'model_requests' and column_name like '%step_context%'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  });
});
