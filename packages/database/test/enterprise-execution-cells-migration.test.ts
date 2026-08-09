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

describe("enterprise execution Cell migration", () => {
  it("creates one routable Cell and makes Workspace placement mandatory", async () => {
    const cells = await database
      .selectFrom("execution_cells")
      .select([
        "id",
        "state",
        "temporal_task_queue",
        "sandbox_manager_base_url",
        "workspace_storage_key",
      ])
      .execute();
    expect(cells).toEqual([
      {
        id: "cell-0001",
        state: "active",
        temporal_task_queue: "agent-dock-pi-runs-cell-0001-v1",
        sandbox_manager_base_url: "http://sandbox-manager:4300",
        workspace_storage_key: "workspace-cell-0001",
      },
    ]);

    const column = await pglite.query<{ is_nullable: string }>(`
      select is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'workspaces'
        and column_name = 'cell_id'
    `);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);

    const foreignKey = await pglite.query<{ constraint_name: string }>(`
      select constraint_name
      from information_schema.table_constraints
      where table_schema = 'public'
        and constraint_name = 'workspaces_execution_cell_fk'
    `);
    expect(foreignKey.rows).toEqual([{ constraint_name: "workspaces_execution_cell_fk" }]);
  });

  it("rejects a Workspace that is not bound to a registered Cell", async () => {
    await expect(
      pglite.exec(`
        insert into workspaces (id, tenant_id, project_id, cell_id)
        values (
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          'cell-missing'
        )
      `),
    ).rejects.toThrow();
  });
});
