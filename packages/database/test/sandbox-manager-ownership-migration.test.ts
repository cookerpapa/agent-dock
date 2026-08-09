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

describe("Sandbox Manager ownership migration", () => {
  it("creates durable replica, activation and operation ownership tables", async () => {
    const tables = await pglite.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'sandbox_manager_instances',
          'sandbox_manager_activations',
          'sandbox_manager_operations'
        )
      order by table_name
    `);
    expect(tables.rows).toEqual([
      { table_name: "sandbox_manager_activations" },
      { table_name: "sandbox_manager_instances" },
      { table_name: "sandbox_manager_operations" },
    ]);

    const indexes = await pglite.query<{ indexname: string }>(`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'sandbox_manager_ready_owner_url_unique',
          'sandbox_manager_workspace_live_unique'
        )
      order by indexname
    `);
    expect(indexes.rows).toEqual([
      { indexname: "sandbox_manager_ready_owner_url_unique" },
      { indexname: "sandbox_manager_workspace_live_unique" },
    ]);
  });

  it("enforces one live Sandbox activation per Workspace", async () => {
    const definition = await pglite.query<{ indexdef: string }>(`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'sandbox_manager_workspace_live_unique'
    `);
    expect(definition.rows[0]?.indexdef).toContain("cleaning");
    expect(definition.rows[0]?.indexdef).toContain("workspace_id");
  });

  it("allows a persistent activation to outlive its authorizing Run lease", async () => {
    const constraint = await pglite.query<{ conname: string }>(`
      select conname
        from pg_constraint
       where conrelid = 'sandbox_manager_activations'::regclass
         and conname = 'sandbox_manager_activations_lease_id_fkey'
    `);
    expect(constraint.rows).toEqual([]);

    const column = await pglite.query<{ is_nullable: string }>(`
      select is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'sandbox_manager_activations'
         and column_name = 'lease_id'
    `);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);
  });
});
