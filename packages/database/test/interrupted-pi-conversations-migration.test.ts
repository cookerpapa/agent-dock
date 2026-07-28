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

describe("interrupted Pi conversation migration", () => {
  it("admits the explicit interrupted Session artifact without weakening other artifact kinds", async () => {
    const constraint = await pglite.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'artifacts_kind_valid'
    `);
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0]!.definition).toContain("pi_interrupted_session_snapshot");
    expect(constraint.rows[0]!.definition).toContain("workspace_snapshot");
    expect(constraint.rows[0]!.definition).toContain("crash_bundle");
  });
});
