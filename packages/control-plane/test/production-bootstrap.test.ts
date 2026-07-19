import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ProductionBootstrapError,
  bootstrapProductionDatabase,
  loadProductionApiToken,
  loadProductionControlPlaneConfig,
  type ProductionBootstrapConfig,
} from "../src/index.ts";

const CONFIG: ProductionBootstrapConfig = {
  tenantId: "a0000000-0000-4000-8000-000000000001",
  tenantSlug: "production-bootstrap",
  userId: "a0000000-0000-4000-8000-000000000002",
  apiCredentialId: "a0000000-0000-4000-8000-000000000005",
  credentialBindingId: "a0000000-0000-4000-8000-000000000003",
  modelProfileId: "a0000000-0000-4000-8000-000000000004",
  modelProfileName: "deterministic-production",
  maximumProjects: 100,
  maximumSessions: 1_000,
  maximumUnsettledTurns: 100,
  maximumConcurrentTurns: 2,
};
const API_TOKEN = `api-${"a".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
const roots: string[] = [];

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 2,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function secret(root: string, name: string, value: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return path;
}

describe.sequential("production bootstrap and configuration", () => {
  it("idempotently creates the exact single-user deterministic profile", async () => {
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).resolves.toEqual({
      tenantId: CONFIG.tenantId,
      userId: CONFIG.userId,
      apiCredentialId: CONFIG.apiCredentialId,
      credentialBindingId: CONFIG.credentialBindingId,
      modelProfileId: CONFIG.modelProfileId,
    });
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).resolves.toBeDefined();
    const counts = await Promise.all([
      database.selectFrom("tenants").selectAll().where("id", "=", CONFIG.tenantId).execute(),
      database.selectFrom("users").selectAll().where("id", "=", CONFIG.userId).execute(),
      database
        .selectFrom("model_profiles")
        .selectAll()
        .where("id", "=", CONFIG.modelProfileId)
        .execute(),
      database
        .selectFrom("tenant_runtime_policies")
        .selectAll()
        .where("tenant_id", "=", CONFIG.tenantId)
        .execute(),
      database
        .selectFrom("tenant_api_credentials")
        .selectAll()
        .where("credential_id", "=", CONFIG.apiCredentialId)
        .execute(),
    ]);
    expect(counts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1]);

    await database
      .updateTable("tenant_api_credentials")
      .set({ revoked_at: new Date("2100-01-01T00:00:00.000Z") })
      .where("credential_id", "=", CONFIG.apiCredentialId)
      .execute();
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).resolves.toBeDefined();

    await database
      .updateTable("model_profiles")
      .set({ name: "changed-outside-bootstrap" })
      .where("id", "=", CONFIG.modelProfileId)
      .execute();
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).rejects.toBeInstanceOf(
      ProductionBootstrapError,
    );
  });

  it("keeps the runtime tenant-neutral while bootstrap reads its private API token", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-control-config-"));
    roots.push(root);
    const environment = {
      DATABASE_URL_FILE: await secret(root, "database", "postgresql://db.invalid/agentdock"),
      AGENT_DOCK_API_TOKEN_FILE: await secret(root, "api", `api-${"a".repeat(48)}`),
      AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN_FILE: await secret(
        root,
        "enrollment",
        `enroll-${"e".repeat(48)}`,
      ),
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
        root,
        "management",
        `manage-${"m".repeat(48)}`,
      ),
      AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL: "http://supervisor-host:4100",
      AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP: "true",
      HOST: "0.0.0.0",
    };
    const runtime = await loadProductionControlPlaneConfig(environment);
    expect(runtime).toMatchObject({
      supervisorManagementBaseUrl: "http://supervisor-host:4100/",
      host: "0.0.0.0",
      port: 3000,
    });
    expect(runtime).not.toHaveProperty("tenantId");
    expect(runtime).not.toHaveProperty("defaultModelProfileId");
    expect(runtime).not.toHaveProperty("apiToken");
    await expect(loadProductionApiToken(environment)).resolves.toBe(`api-${"a".repeat(48)}`);

    const apiPath = environment.AGENT_DOCK_API_TOKEN_FILE;
    await chmod(apiPath, 0o644);
    await expect(loadProductionApiToken(environment)).rejects.toThrow(
      "not a private bounded regular file",
    );
  });
});
