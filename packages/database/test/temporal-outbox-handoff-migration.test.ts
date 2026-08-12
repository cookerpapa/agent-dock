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

describe("Temporal Outbox handoff migration", () => {
  it("records scheduler handoff independently from Worker execution", async () => {
    const columns = await pglite.query<{ column_name: string; is_nullable: string }>(`
      select column_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'outbox'
         and column_name in ('temporal_handed_off_at', 'published_at')
       order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "published_at", is_nullable: "YES" },
      { column_name: "temporal_handed_off_at", is_nullable: "YES" },
    ]);
    const indexes = await pglite.query<{ indexname: string }>(`
      select indexname
        from pg_indexes
       where schemaname = 'public'
         and indexname = 'outbox_pending_temporal_handoff'
    `);
    expect(indexes.rows).toEqual([{ indexname: "outbox_pending_temporal_handoff" }]);
  });
});
