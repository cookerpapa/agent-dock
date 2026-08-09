import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@agent-dock/database";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresSandboxActivationStateRepository } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("PostgreSQL Sandbox Manager ownership", () => {
  it("fences an expired replica before a surviving owner stays Ready", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());
    await runMigrations(database, "up");

    let now = new Date("2026-08-09T00:00:00.000Z");
    const first = new PostgresSandboxActivationStateRepository({
      database,
      cellId: "cell-0001",
      instanceId: "10000000-0000-4000-8000-000000000101",
      ownerBaseUrl: "http://sandbox-manager-0:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
    });
    resources.push(async () => first.close());
    await first.start();
    await expect(first.checkHealth()).resolves.toBeUndefined();

    now = new Date("2026-08-09T00:00:04.000Z");
    const second = new PostgresSandboxActivationStateRepository({
      database,
      cellId: "cell-0001",
      instanceId: "10000000-0000-4000-8000-000000000102",
      ownerBaseUrl: "http://sandbox-manager-1:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
    });
    resources.push(async () => second.close());
    await second.start();

    await expect(first.checkHealth()).rejects.toMatchObject({ code: "ownership_lost" });
    await expect(second.checkHealth()).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("sandbox_manager_instances")
        .select(["instance_id", "state"])
        .orderBy("instance_id")
        .execute(),
    ).resolves.toEqual([
      { instance_id: "10000000-0000-4000-8000-000000000101", state: "lost" },
      { instance_id: "10000000-0000-4000-8000-000000000102", state: "ready" },
    ]);
  });
});
