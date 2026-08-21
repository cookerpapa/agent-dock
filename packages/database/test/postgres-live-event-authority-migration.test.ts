import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations, upRemoveLegacyEventIdTrigger } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("PostgreSQL live-event authority migration", () => {
  it("keeps one persisted cursor and removes external projection state", async () => {
    const columns = await pglite.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'session_event_cursors'
         and column_name in ('last_projected_seq', 'acknowledged_through_seq')
    `);
    expect(columns.rows).toEqual([]);
    const tables = await pglite.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_name in ('worker_event_projection_offsets', 'session_event_ids')
    `);
    expect(tables.rows).toEqual([]);
    const triggers = await pglite.query<{ trigger_name: string }>(`
      select trigger_name
        from information_schema.triggers
       where event_object_table = 'session_events'
         and trigger_name = 'session_events_register_event_id'
    `);
    expect(triggers.rows).toEqual([]);
    const constraints = await pglite.query<{ conname: string }>(`
      select conname
        from pg_constraint
       where conrelid = 'session_event_cursors'::regclass
         and conname = 'session_event_cursors_bounds_valid'
    `);
    expect(constraints.rows).toEqual([{ conname: "session_event_cursors_bounds_valid" }]);
  });

  it("removes the pre-rename trigger from an occupied AgentDock database", async () => {
    const legacy = await PGlite.create();
    try {
      await legacy.exec(`
        create table session_event_ids (event_id uuid primary key);
        create table session_events (event_id uuid not null);
        create function agent_dock_register_session_event_id()
        returns trigger language plpgsql as $$
        begin
          insert into session_event_ids (event_id) values (new.event_id);
          return new;
        end;
        $$;
        create trigger session_events_register_event_id
        before insert on session_events
        for each row execute function agent_dock_register_session_event_id();
      `);
      await applyCompiledQueries(legacy, await compileMigration(upRemoveLegacyEventIdTrigger));
      expect(
        (
          await legacy.query<{ count: number }>(`
            select count(*)::int as count
              from information_schema.triggers
             where trigger_name = 'session_events_register_event_id'
          `)
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await legacy.query<{ count: number }>(`
            select count(*)::int as count
              from information_schema.tables
             where table_name = 'session_event_ids'
          `)
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await legacy.close();
    }
  });
});
