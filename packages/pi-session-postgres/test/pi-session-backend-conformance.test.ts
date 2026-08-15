import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { createSessionBackendConformance } from "@earendil-works/pi-agent-core/session/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgresPiSessionRepository } from "../src/index.ts";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
const externalDatabaseUrl = process.env.AGENT_DOCK_PI_SESSION_CONFORMANCE_DATABASE_URL;

beforeAll(async () => {
  if (externalDatabaseUrl !== undefined) {
    database = createDatabase({ connectionString: externalDatabaseUrl, maxConnections: 8 });
    await runMigrations(database, "up");
    return;
  }
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    // PGLite's socket adapter is single-connection. CI sets the external URL
    // above so the official concurrency case also runs against PostgreSQL.
    maxConnections: 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  if (externalDatabaseUrl === undefined) {
    await socketServer?.stop();
    await pglite?.close();
  }
});

const cases = createSessionBackendConformance(async () => {
  const tenantId = globalThis.crypto.randomUUID();
  await database
    .insertInto("tenants")
    .values({ id: tenantId, slug: `pi-contract-${tenantId}` })
    .executeTakeFirstOrThrow();
  return {
    repository: new PostgresPiSessionRepository({ database, tenantId }),
    async [Symbol.asyncDispose]() {
      await database.deleteFrom("pi_sessions").where("tenant_id", "=", tenantId).execute();
      await database.deleteFrom("tenants").where("id", "=", tenantId).execute();
    },
  };
});

describe.sequential("Pi 0.84.1 PostgreSQL Session backend conformance", () => {
  for (const contract of cases) {
    it(`${contract.group}: ${contract.name}`, async () => contract.run());
  }
});
