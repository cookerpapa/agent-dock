import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downCanonicalPiConversationEntries,
  upCanonicalPiConversationEntries,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("canonical Pi conversation entry migration", () => {
  it("binds Pi entries to product Turns, normalizes the Pi log and removes duplicate transcripts", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table turns (
          id uuid primary key,
          tenant_id uuid not null,
          session_id uuid not null,
          created_at timestamptz not null
        );
        create table pi_session_entries (
          tenant_id uuid not null,
          session_id text not null,
          id text not null,
          seq bigint not null,
          timestamp_ms bigint not null,
          payload jsonb not null,
          primary key (tenant_id, session_id, id)
        );
        create table pi_session_records (
          tenant_id uuid not null,
          session_id text not null,
          id text not null,
          seq bigint not null,
          timestamp_ms bigint not null,
          payload jsonb not null,
          primary key (tenant_id, session_id, id)
        );
        create table pi_session_log (
          tenant_id uuid not null,
          session_id text not null,
          seq bigint not null,
          kind text not null,
          payload jsonb not null,
          primary key (tenant_id, session_id, seq)
        );
        create table conversation_turn_projections (turn_id uuid primary key);
      `);
      const tenantId = "10000000-0000-4000-8000-000000000001";
      const sessionId = "20000000-0000-4000-8000-000000000001";
      const turnId = "30000000-0000-4000-8000-000000000001";
      const entryId = "entry-1";
      const acceptedAt = new Date("2026-08-20T08:00:00.000Z");
      await postgres.query(
        "insert into turns (id, tenant_id, session_id, created_at) values ($1, $2, $3, $4)",
        [turnId, tenantId, sessionId, acceptedAt],
      );
      const entry = {
        id: entryId,
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "one copy" }] },
      };
      await postgres.query(
        `insert into pi_session_entries
           (tenant_id, session_id, id, seq, timestamp_ms, payload)
         values ($1, $2, $3, 1, $4, $5)`,
        [tenantId, sessionId, entryId, acceptedAt.valueOf() + 1, JSON.stringify(entry)],
      );
      await postgres.query(
        `insert into pi_session_log (tenant_id, session_id, seq, kind, payload)
         values ($1, $2, 1, 'entry', $3)`,
        [tenantId, sessionId, JSON.stringify({ entry })],
      );

      await applyCompiledQueries(
        postgres,
        await compileMigration(upCanonicalPiConversationEntries),
      );
      expect(
        (
          await postgres.query<{ turn_id: string; payload: { entryId: string } }>(`
            select entry.turn_id, log.payload
              from pi_session_entries entry
              join pi_session_log log
                on log.tenant_id = entry.tenant_id
               and log.session_id = entry.session_id
               and log.seq = entry.seq
          `)
        ).rows,
      ).toEqual([{ turn_id: turnId, payload: { entryId } }]);
      expect(
        (
          await postgres.query<{ count: number }>(`
            select count(*)::int as count
              from information_schema.tables
             where table_schema = 'public'
               and table_name = 'conversation_turn_projections'
          `)
        ).rows,
      ).toEqual([{ count: 0 }]);

      await applyCompiledQueries(
        postgres,
        await compileMigration(downCanonicalPiConversationEntries),
      );
      expect(
        (
          await postgres.query<{ payload: { entry: typeof entry } }>(
            "select payload from pi_session_log where kind = 'entry'",
          )
        ).rows,
      ).toEqual([{ payload: { entry } }]);
    } finally {
      await postgres.close();
    }
  });
});
