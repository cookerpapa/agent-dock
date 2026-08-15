import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { upInitialControlPlane } from "../src/index.ts";
import { up as upPiSessionStorage } from "../src/migrations/053_pi_session_storage.ts";
import {
  down as downPiSessionOpaqueIdentifiers,
  up as upPiSessionOpaqueIdentifiers,
} from "../src/migrations/059_pi_session_opaque_identifiers.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const ENTRY_ID = "30000000-0000-4000-8000-000000000001";

describe("Pi Session opaque identifier migration", () => {
  it("preserves product UUIDs while accepting every Pi string identifier", async () => {
    const postgres = await PGlite.create();
    try {
      await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
      await applyCompiledQueries(postgres, await compileMigration(upPiSessionStorage));
      await postgres.query("insert into tenants (id, slug) values ($1, 'pi-id-migration')", [
        TENANT_ID,
      ]);
      await postgres.query(
        `insert into pi_sessions (tenant_id, id, created_at_ms)
         values ($1, $2, 1)`,
        [TENANT_ID, SESSION_ID],
      );
      await postgres.query(
        `insert into pi_session_lanes (tenant_id, session_id, lane, leaf_id)
         values ($1, $2, 'main', $3)`,
        [TENANT_ID, SESSION_ID, ENTRY_ID],
      );
      await postgres.query(
        `insert into pi_session_entries
          (tenant_id, session_id, id, seq, parent_id, type, timestamp_ms, payload)
         values ($1, $2, $3, 1, null, 'custom', 1, '{"id":"legacy"}')`,
        [TENANT_ID, SESSION_ID, ENTRY_ID],
      );

      await applyCompiledQueries(postgres, await compileMigration(upPiSessionOpaqueIdentifiers));

      const columns = await postgres.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type
           from information_schema.columns
          where table_name = 'pi_session_entries'
            and column_name in ('session_id', 'id', 'parent_id')
          order by column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: "id", data_type: "text" },
        { column_name: "parent_id", data_type: "text" },
        { column_name: "session_id", data_type: "text" },
      ]);
      expect(
        (
          await postgres.query<{ id: string }>(
            "select id from pi_sessions where tenant_id = $1 and id = $2",
            [TENANT_ID, SESSION_ID],
          )
        ).rows,
      ).toEqual([{ id: SESSION_ID }]);

      await postgres.query(
        `insert into pi_sessions (tenant_id, id, created_at_ms)
         values ($1, 'session.with-opaque-id', 2)`,
        [TENANT_ID],
      );
      await postgres.query(
        `insert into pi_session_lanes (tenant_id, session_id, lane, leaf_id)
         values ($1, 'session.with-opaque-id', 'main', null)`,
        [TENANT_ID],
      );
      await postgres.query(
        `insert into pi_session_records
          (tenant_id, session_id, id, seq, lane, type, run_id, timestamp_ms, payload)
         values ($1, 'session.with-opaque-id', 'record-A', 1, 'main',
                 'operation_finished', 'run-A', 2, '{"id":"record-A"}')`,
        [TENANT_ID],
      );
      await postgres.query(
        "delete from pi_sessions where tenant_id = $1 and id = 'session.with-opaque-id'",
        [TENANT_ID],
      );

      await applyCompiledQueries(postgres, await compileMigration(downPiSessionOpaqueIdentifiers));
      expect(
        (
          await postgres.query<{ id: string }>(
            "select id::text as id from pi_sessions where tenant_id = $1",
            [TENANT_ID],
          )
        ).rows,
      ).toEqual([{ id: SESSION_ID }]);
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
