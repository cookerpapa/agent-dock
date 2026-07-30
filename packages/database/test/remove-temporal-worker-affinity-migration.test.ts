import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  downRemoveTemporalWorkerAffinity,
  runMigrations,
  upRemoveTemporalWorkerAffinity,
} from "../src/index.ts";
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

describe("remove Temporal Worker affinity migration", () => {
  it("deletes the private queues' reservation state and Session hints", async () => {
    await applyCompiledQueries(pglite, await compileMigration(downRemoveTemporalWorkerAffinity));

    const restored = await pglite.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'sessions'
          and column_name like 'worker_affinity_%'
        order by column_name`,
    );
    expect(restored.rows.map((row) => row.column_name)).toEqual([
      "worker_affinity_expires_at",
      "worker_affinity_sandbox_id",
    ]);

    await applyCompiledQueries(pglite, await compileMigration(upRemoveTemporalWorkerAffinity));

    const removedColumns = await pglite.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'sessions'
          and column_name like 'worker_affinity_%'`,
    );
    expect(removedColumns.rows).toEqual([]);
    const removedTable = await pglite.query<{ relation: string | null }>(
      `select to_regclass('public.temporal_worker_affinity_reservations')::text as relation`,
    );
    expect(removedTable.rows).toEqual([{ relation: null }]);
  });
});
