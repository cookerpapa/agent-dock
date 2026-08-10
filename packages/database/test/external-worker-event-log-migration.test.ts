import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../src/index.ts";

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

describe("external Worker event log migration", () => {
  it("separates the ACK and replay projection watermarks", async () => {
    const columns = await pglite.query<{ column_name: string; is_nullable: string }>(`
      select column_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'session_event_cursors'
         and column_name = 'last_projected_seq'
    `);
    expect(columns.rows).toEqual([{ column_name: "last_projected_seq", is_nullable: "NO" }]);
    const constraints = await pglite.query<{ conname: string }>(`
      select conname
        from pg_constraint
       where conrelid = 'session_event_cursors'::regclass
         and conname = 'session_event_cursors_projection_valid'
    `);
    expect(constraints.rows).toEqual([{ conname: "session_event_cursors_projection_valid" }]);
  });

  it("uses Kafka-first projection offsets without a PostgreSQL payload Outbox", async () => {
    const tables = await pglite.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_name in ('worker_event_outbox', 'worker_event_projection_offsets')
       order by table_name
    `);
    expect(tables.rows).toEqual([{ table_name: "worker_event_projection_offsets" }]);
    const columns = await pglite.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'worker_event_projection_offsets'
       order by ordinal_position
    `);
    expect(columns.rows).toEqual([
      { column_name: "consumer_group" },
      { column_name: "topic" },
      { column_name: "partition" },
      { column_name: "last_offset" },
      { column_name: "updated_at" },
    ]);
  });
});
