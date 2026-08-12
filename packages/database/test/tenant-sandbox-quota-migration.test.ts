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

describe("tenant Sandbox quota migration", () => {
  it("adds a bounded tenant policy and an index for live activation admission", async () => {
    const columns = await pglite.query<{
      column_default: string;
      is_nullable: string;
    }>(`
      select column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'tenant_runtime_policies'
        and column_name = 'maximum_active_sandboxes'
    `);
    const indexes = await pglite.query<{ indexname: string; indexdef: string }>(`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'tool_broker_activations_tenant_live_idx',
          'tool_broker_workspace_live_unique'
        )
      order by indexname
    `);

    expect(columns.rows).toEqual([{ column_default: "16", is_nullable: "NO" }]);
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows[0]?.indexdef).toContain("tenant_id");
    expect(indexes.rows[0]?.indexdef).toContain("sandbox_domain_id");
    expect(indexes.rows.every((index) => index.indexdef.includes("unknown"))).toBe(true);
  });
});
