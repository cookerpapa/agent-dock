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

  it("creates an ordered transactional Outbox with content hashes", async () => {
    const columns = await pglite.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'worker_event_outbox'
         and column_name in ('envelope', 'content_sha256', 'claimed_until', 'published_at')
       order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "claimed_until" },
      { column_name: "content_sha256" },
      { column_name: "envelope" },
      { column_name: "published_at" },
    ]);
    const indexes = await pglite.query<{ indexname: string }>(`
      select indexname
        from pg_indexes
       where schemaname = 'public'
         and tablename = 'worker_event_outbox'
         and indexname in ('worker_event_outbox_delivery_idx', 'worker_event_outbox_session_idx')
       order by indexname
    `);
    expect(indexes.rows).toEqual([
      { indexname: "worker_event_outbox_delivery_idx" },
      { indexname: "worker_event_outbox_session_idx" },
    ]);
  });
});
