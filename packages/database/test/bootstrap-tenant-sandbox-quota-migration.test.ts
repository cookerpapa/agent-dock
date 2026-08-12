import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/index.ts";
import { up as upgradeBootstrapTenantQuota } from "../src/migrations/051_bootstrap_tenant_sandbox_quota.ts";

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
  await pglite.exec(`
    create table tenant_runtime_policies (
      tenant_id text primary key,
      maximum_active_sandboxes integer not null,
      updated_at timestamptz not null default now()
    );
    create table tenant_api_credentials (
      tenant_id text not null,
      label text not null,
      role text not null,
      revoked_at timestamptz
    );
  `);
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("bootstrap tenant Sandbox quota migration", () => {
  it("upgrades only the untouched self-hosted owner quota", async () => {
    await pglite.exec(`
      insert into tenant_runtime_policies (tenant_id, maximum_active_sandboxes)
      values ('owner', 16), ('public', 16), ('customized', 32);
      insert into tenant_api_credentials (tenant_id, label, role, revoked_at)
      values
        ('owner', 'production bootstrap owner', 'owner', null),
        ('public', 'web owner', 'owner', null),
        ('customized', 'production bootstrap owner', 'owner', null);
    `);

    await upgradeBootstrapTenantQuota(database as unknown as Kysely<unknown>);

    const result = await pglite.query<{
      tenant_id: string;
      maximum_active_sandboxes: number;
    }>(`
      select tenant_id, maximum_active_sandboxes
        from tenant_runtime_policies
       order by tenant_id
    `);
    expect(result.rows).toEqual([
      { tenant_id: "customized", maximum_active_sandboxes: 32 },
      { tenant_id: "owner", maximum_active_sandboxes: 64 },
      { tenant_id: "public", maximum_active_sandboxes: 16 },
    ]);
  });
});
