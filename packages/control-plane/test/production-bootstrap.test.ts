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
const API_TOKEN = `adk_${CONFIG.apiCredentialId}.${"a".repeat(43)}`;

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
  it("idempotently preserves the bootstrap profile and owner-configured model mode", async () => {
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
      .insertInto("credential_bindings")
      .values({
        id: CONFIG.credentialBindingId,
        tenant_id: CONFIG.tenantId,
        provider: "deepseek",
        kind: "api_key",
        secret_ref: `sealed://tenant-model-credentials/${CONFIG.tenantId}/${CONFIG.credentialBindingId}/2`,
        version: 2,
        status: "active",
      })
      .execute();
    await database
      .insertInto("tenant_model_credentials")
      .values({
        tenant_id: CONFIG.tenantId,
        credential_binding_id: CONFIG.credentialBindingId,
        credential_binding_version: 2,
        key_version: 1,
        nonce: "n".repeat(16),
        ciphertext: "c".repeat(16),
        auth_tag: "t".repeat(22),
        secret_sha256: "a".repeat(64),
      })
      .execute();
    await database
      .updateTable("model_profiles")
      .set({
        provider: "deepseek",
        model_id: "deepseek-v4-flash",
        credential_binding_version: 2,
      })
      .where("id", "=", CONFIG.modelProfileId)
      .execute();
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).resolves.toBeDefined();

    await database
      .deleteFrom("tenant_model_credentials")
      .where("tenant_id", "=", CONFIG.tenantId)
      .where("credential_binding_id", "=", CONFIG.credentialBindingId)
      .where("credential_binding_version", "=", "2")
      .execute();
    await expect(bootstrapProductionDatabase(database, CONFIG, API_TOKEN)).rejects.toThrow(
      "Existing active model credential ciphertext does not match production bootstrap configuration",
    );
    await database
      .insertInto("tenant_model_credentials")
      .values({
        tenant_id: CONFIG.tenantId,
        credential_binding_id: CONFIG.credentialBindingId,
        credential_binding_version: 2,
        key_version: 1,
        nonce: "n".repeat(16),
        ciphertext: "c".repeat(16),
        auth_tag: "t".repeat(22),
        secret_sha256: "a".repeat(64),
      })
      .execute();

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
      AGENT_DOCK_DATABASE_NOTIFICATION_URL_FILE: await secret(
        root,
        "database-notifications",
        "postgresql://postgres-direct.invalid/agentdock",
      ),
      AGENT_DOCK_API_TOKEN_FILE: await secret(
        root,
        "api",
        `adk_40000000-0000-4000-8000-000000000003.${"a".repeat(43)}`,
      ),
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
      AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
        root,
        "model-master-key",
        Buffer.alloc(32, 5).toString("base64url"),
      ),
      AGENT_DOCK_CUBE_EGRESS_CONFIG_TOKEN_FILE: await secret(
        root,
        "cube-egress-config-token",
        `cube-egress-${"c".repeat(48)}`,
      ),
      AGENT_DOCK_SANDBOX_MANAGER_URLS: "http://sandbox-manager:4300",
      AGENT_DOCK_SANDBOX_MATERIALIZER_TOKEN_FILE: await secret(
        root,
        "sandbox-materializer-token",
        `materializer-${"s".repeat(48)}`,
      ),
      AGENT_DOCK_SUPERVISOR_ID_PREFIX: "pi-worker-",
      AGENT_DOCK_TEMPORAL_ADDRESS: "temporal:7233",
      AGENT_DOCK_PLATFORM_MODEL_SOURCE_TENANT_ID: CONFIG.tenantId,
      AGENT_DOCK_API_CREDENTIAL_ID: "40000000-0000-4000-8000-000000000003",
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE: "http://{supervisorId}:4100",
      AGENT_DOCK_IMAGE_REVISION: "sha-0123456789abcdef",
      AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP: "true",
      HOST: "0.0.0.0",
    };
    const runtime = await loadProductionControlPlaneConfig(environment);
    expect(runtime).toMatchObject({
      databaseUrl: "postgresql://db.invalid/agentdock",
      databaseNotificationUrl: "postgresql://postgres-direct.invalid/agentdock",
      supervisorIdPrefix: "pi-worker-",
      supervisorManagementBaseUrlTemplate: "http://{supervisorId}:4100",
      sandboxManagerBaseUrls: ["http://sandbox-manager:4300/"],
      host: "0.0.0.0",
      port: 3000,
      temporalAddress: "temporal:7233",
      temporalNamespace: "agent-dock",
      temporalTaskQueue: "agent-dock-pi-runs-v1",
      advancedModulesEnabled: false,
      platformModelSourceTenantId: CONFIG.tenantId,
      platformOperatorTenantId: CONFIG.tenantId,
      webSessionCookieSecure: false,
      webSessionTtlMs: 2_592_000_000,
      publicRegistration: {
        enabled: false,
        maximumTenants: 32,
        tenantQuotas: {
          maximumProjects: 10,
          maximumSessions: 100,
          maximumUnsettledTurns: 10,
          maximumConcurrentTurns: 2,
        },
      },
    });
    expect(runtime).not.toHaveProperty("tenantId");
    expect(runtime).not.toHaveProperty("defaultModelProfileId");
    expect(runtime).not.toHaveProperty("apiToken");
    await expect(loadProductionApiToken(environment)).resolves.toBe(
      `adk_40000000-0000-4000-8000-000000000003.${"a".repeat(43)}`,
    );

    const apiPath = environment.AGENT_DOCK_API_TOKEN_FILE;
    await chmod(apiPath, 0o644);
    await expect(loadProductionApiToken(environment)).rejects.toThrow(
      "not a private bounded regular file",
    );
  });
});
