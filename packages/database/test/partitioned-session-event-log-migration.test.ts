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

describe("partitioned Session event log migration", () => {
  it("hash-partitions events by Session across 32 physical tables", async () => {
    const parent = await pglite.query<{ relkind: string }>(`
      select relkind
        from pg_class
       where oid = 'session_events'::regclass
    `);
    expect(parent.rows).toEqual([{ relkind: "p" }]);
    const children = await pglite.query<{ count: string }>(`
      select count(*)::text as count
        from pg_inherits
       where inhparent = 'session_events'::regclass
    `);
    expect(children.rows).toEqual([{ count: "32" }]);
  });

  it("retains a global event-ID registry and registration trigger", async () => {
    const registry = await pglite.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_name = 'session_event_ids'
    `);
    expect(registry.rows).toEqual([{ table_name: "session_event_ids" }]);
    const trigger = await pglite.query<{ tgname: string }>(`
      select tgname
        from pg_trigger
       where tgrelid = 'session_events'::regclass
         and not tgisinternal
    `);
    expect(trigger.rows).toEqual([{ tgname: "session_events_register_event_id" }]);
  });
});
