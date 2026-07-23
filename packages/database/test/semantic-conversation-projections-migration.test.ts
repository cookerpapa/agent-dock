import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downSemanticConversationProjections,
  upSemanticConversationProjections,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("semantic conversation projection migration", () => {
  it("binds a versioned projection to one tenant/session/turn and validates its watermark", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table turns (
          id uuid primary key,
          tenant_id uuid not null,
          session_id uuid not null,
          unique (tenant_id, session_id, id)
        );
      `);
      const tenant = "10000000-0000-4000-8000-000000000001";
      const session = "20000000-0000-4000-8000-000000000001";
      const turn = "30000000-0000-4000-8000-000000000001";
      await postgres.query("insert into turns (id, tenant_id, session_id) values ($1, $2, $3)", [
        turn,
        tenant,
        session,
      ]);

      await applyCompiledQueries(
        postgres,
        await compileMigration(upSemanticConversationProjections),
      );
      const transcript = {
        schemaVersion: 1,
        throughSequence: 7,
        items: [],
        startedSequence: 1,
        terminalSequence: 7,
        stopReason: "stop",
        failure: null,
        cancellation: null,
        workspacePatch: null,
      };
      await postgres.query(
        `insert into conversation_turn_projections
          (turn_id, tenant_id, session_id, through_seq, source_event_count, transcript)
         values ($1, $2, $3, 7, 4, $4)`,
        [turn, tenant, session, JSON.stringify(transcript)],
      );
      const rows = await postgres.query<{
        through_seq: number;
        source_event_count: number;
        transcript: Record<string, unknown>;
      }>(
        `select through_seq, source_event_count, transcript
           from conversation_turn_projections`,
      );
      expect(rows.rows).toEqual([{ through_seq: 7, source_event_count: 4, transcript }]);

      await expect(
        postgres.query(
          `update conversation_turn_projections
              set through_seq = 8
            where turn_id = $1`,
          [turn],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downSemanticConversationProjections),
      );
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'conversation_turn_projections'`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  });
});
