import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DurableEventStore,
  HashedBearerSupervisorAuthorizer,
  SessionEventHub,
  SandboxPreviewGateway,
  SupervisorMaintenanceRuntime,
  createControlPlaneRuntime,
  type SupervisorMaintenanceActivity,
} from "../src/index.ts";

const IDS = {
  tenant: "81000000-0000-4000-8000-000000000001",
  profile: "81000000-0000-4000-8000-000000000003",
  controlPlane: "81000000-0000-4000-8000-000000000004",
  boot: "81000000-0000-4000-8000-000000000005",
  sandbox: "81000000-0000-4000-8000-000000000006",
} as const;

const SUPERVISOR_ID = "remote-runtime-test";
const TOKEN = `pi-cloud-${"w".repeat(48)}`;

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for remote control-plane runtime state");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

beforeAll(async () => {
  let connectionString = process.env.PI_CLOUD_TEST_DATABASE_URL;
  if (!connectionString) {
    pglite = await PGlite.create();
    socketServer = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 1,
    });
    await socketServer.start();
    connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  }
  database = createDatabase({
    connectionString,
    maxConnections: pglite === undefined ? 4 : 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("remote control-plane runtime composition", () => {
  it("retries maintenance without overlap or raw error disclosure", async () => {
    const activities: SupervisorMaintenanceActivity[] = [];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const runtime = new SupervisorMaintenanceRuntime({
      maintenanceRunner: {
        async runMaintenanceCycle() {
          calls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          active -= 1;
          if (calls === 1) {
            throw { code: "maintenance_probe_failed", retryable: true, secret: TOKEN };
          }
          return {
            connections: {
              scannedConnections: 0,
              expiredConnections: 0,
              expiredConnectionIds: [],
            },
            retirements: [],
          };
        },
      },
      maintenanceIntervalMs: 5,
      failurePollMs: 5,
      onActivity(activity) {
        activities.push(activity);
      },
    });

    runtime.start();
    expect(() => runtime.start()).toThrow("already started");
    await waitFor(() => calls >= 2);
    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(runtime.state).toBe("stopped");
    expect(maximumActive).toBe(1);
    expect(activities).toEqual(
      expect.arrayContaining([
        {
          type: "runtime.failure",
          component: "maintenance",
          code: "maintenance_probe_failed",
          retryable: true,
        },
        {
          type: "maintenance.completed",
          scannedConnections: 0,
          expiredConnections: 0,
          retirements: 0,
        },
      ]),
    );
    expect(JSON.stringify(activities)).not.toContain(TOKEN);
  });

  it("starts maintenance with the HTTP/WebSocket control plane and drains idempotently", async () => {
    const activities: SupervisorMaintenanceActivity[] = [];
    const sandboxPreviewGateway = new SandboxPreviewGateway({
      database,
      previewToken: `preview-${"p".repeat(48)}`,
      allowInsecureInternalHttp: true,
    });
    const runtime = await createControlPlaneRuntime({
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      controlPlaneInstanceId: IDS.controlPlane,
      supervisorAuthorizer: new HashedBearerSupervisorAuthorizer({
        token: TOKEN,
        identity: {
          supervisorId: SUPERVISOR_ID,
          bootId: IDS.boot,
          sandboxId: IDS.sandbox,
        },
      }),
      supervisorOwnerBoundary: {
        async stopAndConfirm() {
          throw new Error("No disconnected Supervisor should be retired in this test");
        },
      },
      assignmentInventoryFactory: () => ({
        async listAssignments() {
          return [];
        },
        async terminateAndConfirmAbsent() {
          throw new Error("An empty inventory cannot terminate an assignment");
        },
      }),
      sandboxPreviewGateway,
      maintenance: {
        maintenanceIntervalMs: 10,
        failurePollMs: 10,
        onActivity(activity) {
          activities.push(activity);
          if (activities.length === 1) {
            throw new Error("Observer failures must not stop maintenance");
          }
        },
      },
    });

    try {
      const address = await runtime.listen(0, "127.0.0.1");
      expect(
        (
          await fetch(
            `${address}/v1/conversations/10000000-0000-4000-8000-000000000001/preview/8000/`,
          )
        ).status,
      ).toBe(401);
      expect(runtime.application.get(DurableEventStore)).toBe(runtime.eventStore);
      expect(runtime.application.get(SessionEventHub)).toBe(runtime.eventHub);
      await waitFor(() => activities.some((activity) => activity.type === "maintenance.completed"));
      expect(runtime.maintenance.state).toBe("running");

      await Promise.all([runtime.close(), runtime.close()]);
      expect(runtime.state).toBe("closed");
      expect(runtime.maintenance.state).toBe("stopped");
      expect(runtime.gateway.activeConnectionCount).toBe(0);
    } finally {
      await runtime.close();
    }
  });
});
