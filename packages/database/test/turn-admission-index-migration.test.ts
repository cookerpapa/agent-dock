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

describe("Turn admission index migration", () => {
  it("indexes only tenant Turns that consume unsettled quota", async () => {
    const indexes = await pglite.query<{ indexdef: string }>(`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'turns_tenant_unsettled'
    `);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toContain("tenant_id");
    expect(indexes.rows[0]?.indexdef).toContain("queued");
    expect(indexes.rows[0]?.indexdef).toContain("cancelling");
  });
});
