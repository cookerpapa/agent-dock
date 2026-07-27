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

describe("shared Workspace head migration", () => {
  it("makes the Workspace the durable directory authority without coupling Pi conversations", async () => {
    const columns = await pglite.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'workspaces'
        and column_name in ('current_workspace_version_id', 'row_version')
      order by column_name
    `);
    expect(columns.rows).toEqual([
      {
        column_name: "current_workspace_version_id",
        data_type: "uuid",
        is_nullable: "YES",
      },
      { column_name: "row_version", data_type: "bigint", is_nullable: "NO" },
    ]);

    const constraints = await pglite.query<{
      constraint_name: string;
      constraint_type: string;
    }>(`
      select constraint_name, constraint_type
      from information_schema.table_constraints
      where table_schema = 'public'
        and constraint_name in (
          'sessions_current_workspace_version_fk',
          'workspaces_current_workspace_version_fk'
        )
      order by constraint_name
    `);
    expect(constraints.rows).toEqual([
      {
        constraint_name: "sessions_current_workspace_version_fk",
        constraint_type: "FOREIGN KEY",
      },
      {
        constraint_name: "workspaces_current_workspace_version_fk",
        constraint_type: "FOREIGN KEY",
      },
    ]);
  });
});
