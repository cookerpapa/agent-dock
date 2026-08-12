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

describe("remove Temporal Worker affinity migration", () => {
  it("leaves capacity matching to the shared Temporal Cell queue", async () => {
    const columns = await pglite.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sessions'
        and column_name like 'worker_affinity_%'
    `);
    const reservationTable = await pglite.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'temporal_worker_affinity_reservations'
    `);

    expect(columns.rows).toEqual([]);
    expect(reservationTable.rows).toEqual([]);
  });
});
