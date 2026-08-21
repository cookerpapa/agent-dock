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

describe("Kafka-first Agent event migration", () => {
  it("stores only bounded projection boundaries and idempotent Session mutation results", async () => {
    const attemptColumns = await pglite.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_name = 'run_attempts'
         and column_name = 'last_event_seq'
    `);
    expect(attemptColumns.rows).toEqual([{ column_name: "last_event_seq" }]);
    const logColumns = await pglite.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_name = 'pi_session_log'
         and column_name in ('mutation_id', 'mutation_result')
       order by column_name
    `);
    expect(logColumns.rows).toEqual([
      { column_name: "mutation_id" },
      { column_name: "mutation_result" },
    ]);
    const results = await pglite.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_name = 'pi_session_mutation_results'
    `);
    expect(results.rows).toEqual([{ table_name: "pi_session_mutation_results" }]);
    const retired = await pglite.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_name in (
         'session_events',
         'session_event_cursors',
         'session_live_stream_compactions'
       )
    `);
    expect(retired.rows).toEqual([]);
  });
});
