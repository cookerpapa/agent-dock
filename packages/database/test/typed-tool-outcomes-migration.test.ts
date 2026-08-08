import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downTypedToolOutcomes, upTypedToolOutcomes } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("typed Tool outcome migration", () => {
  it("normalizes historical Tool completion events without runtime compatibility", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table session_events (
          id integer primary key,
          type text not null,
          payload jsonb not null
        );
        insert into session_events (id, type, payload) values
          (1, 'tool.completed', '{"toolCallId":"ok","isError":false}'),
          (2, 'tool.completed', '{"toolCallId":"bad","isError":true}'),
          (3, 'text.delta', '{"delta":"unchanged"}');
      `);

      await applyCompiledQueries(postgres, await compileMigration(upTypedToolOutcomes));
      const upgraded = await postgres.query<{ id: number; payload: Record<string, unknown> }>(
        "select id, payload from session_events order by id",
      );
      expect(upgraded.rows).toEqual([
        { id: 1, payload: { toolCallId: "ok", outcome: "completed" } },
        { id: 2, payload: { toolCallId: "bad", outcome: "failed" } },
        { id: 3, payload: { delta: "unchanged" } },
      ]);

      await applyCompiledQueries(postgres, await compileMigration(downTypedToolOutcomes));
      const downgraded = await postgres.query<{ id: number; payload: Record<string, unknown> }>(
        "select id, payload from session_events order by id",
      );
      expect(downgraded.rows).toEqual([
        { id: 1, payload: { toolCallId: "ok", isError: false } },
        { id: 2, payload: { toolCallId: "bad", isError: true } },
        { id: 3, payload: { delta: "unchanged" } },
      ]);
    } finally {
      await postgres.close();
    }
  }, 10_000);
});
