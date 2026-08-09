import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { AgentTurnScenarioContext } from "@agent-dock/sandbox-supervisor";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorConnectionManager,
  SupervisorProvisioningGateway,
  SupervisorWebSocketGateway,
} from "@agent-dock/control-plane";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRODUCTION_CANCELLATION_PROBE_PROMPT,
  resolveProductionSandboxScenario,
  SupervisorHostRuntime,
  type SupervisorHostConfig,
  type SupervisorSandboxManager,
  type SupervisorTemporalWorker,
  type TemporalPiWorkerOptions,
} from "../src/index.ts";

const CONTROL_PLANE_ID = "90000000-0000-4000-8000-000000000001";
const SUPERVISOR_ID = "supervisor-host-runtime-test";
const ENROLLMENT_TOKEN = `enrollment-${"e".repeat(48)}`;
const MANAGEMENT_TOKEN = `management-${"m".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let connectionString: string;

function temporalWorker(): SupervisorTemporalWorker {
  let state: SupervisorTemporalWorker["state"] = "idle";
  return {
    get state() {
      return state;
    },
    async start() {
      state = "running";
    },
    async stop() {
      state = "stopped";
    },
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 6,
  });
  await socketServer.start();
  connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  database = createDatabase({ connectionString, maxConnections: 6 });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

function objectStore() {
  let destroyed = false;
  return {
    async checkHealth() {
      if (destroyed) throw new Error("destroyed");
    },
    async put() {
      throw new Error("unused");
    },
    async get() {
      throw new Error("unused");
    },
    async delete() {
      throw new Error("unused");
    },
    destroy() {
      destroyed = true;
    },
  };
}

function sandboxManager(): SupervisorSandboxManager {
  return {
    operationUrlFor: () => "http://sandbox-manager.test/internal/v1/tool-operation",
    async checkHealth() {},
    async create() {
      throw new Error("unused");
    },
    async capture() {
      throw new Error("unused");
    },
    async release() {
      throw new Error("unused");
    },
    async stop() {},
    async importGitHub() {
      throw new Error("unused");
    },
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {
      throw new Error("No assignments exist");
    },
    async confirmAbsent() {},
  };
}

describe("SupervisorHostRuntime", () => {
  it("keeps the production fixture closed while providing a deterministic cancellation probe", () => {
    const context = (text: string, restoring = false) =>
      ({
        restoring,
        command: { payload: { input: { kind: "prompt", text } } },
      }) as AgentTurnScenarioContext;

    expect(resolveProductionSandboxScenario(context("repair the Java fixture"))).toBe(
      "java_repair",
    );
    expect(resolveProductionSandboxScenario(context(PRODUCTION_CANCELLATION_PROBE_PROMPT))).toBe(
      "tool_hold",
    );
    expect(
      resolveProductionSandboxScenario(context(PRODUCTION_CANCELLATION_PROBE_PROMPT, true)),
    ).toBe("java_followup");
  });

  it("provisions a fresh generation, registers after recovery, and never reuses boot identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-host-runtime-"));
    const server = Fastify({ logger: false });
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "supervisor-host-runtime-",
      managementBaseUrlTemplate: "http://{supervisorId}:4100",
      maximumCapacity: 2,
      enrollmentToken: ENROLLMENT_TOKEN,
    });
    new SupervisorProvisioningGateway({ provisioner }).install(server);
    const manager = new SupervisorConnectionManager({
      database,
      controlPlaneInstanceId: CONTROL_PLANE_ID,
      ownerBoundary: { async stopAndConfirm() {} },
      assignmentRetirerFactory: () => ({
        async retireSandbox() {
          return {
            inspectedRuntimes: 0,
            terminatedRuntimes: 0,
            orphanRuntimes: 0,
            settledAssignments: 0,
            requeuedAssignments: 0,
            sandboxState: "terminated" as const,
          };
        },
      }),
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 500,
    });
    const gateway = new SupervisorWebSocketGateway({
      manager,
      authorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
    });
    gateway.install(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const temporalWorkerOptions: TemporalPiWorkerOptions[] = [];
    const temporalWorkerFactory = (options: TemporalPiWorkerOptions): SupervisorTemporalWorker => {
      temporalWorkerOptions.push(options);
      return temporalWorker();
    };
    const baseConfig: SupervisorHostConfig = {
      supervisorId: SUPERVISOR_ID,
      controlPlaneBaseUrl: address,
      supervisorWebSocketUrl: `${address.replace(/^http/, "ws")}/internal/v1/supervisor`,
      allowInsecureInternalHttp: true,
      enrollmentToken: ENROLLMENT_TOKEN,
      managementToken: MANAGEMENT_TOKEN,
      sandboxManagerServiceToken: `sandbox-manager-${"s".repeat(48)}`,
      modelCredentialMasterKey: Buffer.alloc(32, 7).toString("base64url"),
      databaseUrl: connectionString,
      managementHost: "127.0.0.1",
      managementPort: 0,
      managementAdvertisedBaseUrl: `http://${SUPERVISOR_ID}:4100`,
      maxConcurrentSessions: 1,
      temporalAddress: "temporal.test:7233",
      temporalNamespace: "agent-dock-test",
      executionCellId: "cell-test",
      temporalTaskQueue: "agent-dock-pi-runs-test",
      temporalWorkerDeploymentName: "agent-dock-pi-workers",
      temporalWorkerBuildId: "runtime-test-build",
      sandboxManagerBaseUrls: ["http://sandbox-manager.test:4300/"],
      sandboxManagerRequestTimeoutMs: 300_000,
      trustedWorkspaceDirectory: root,
      bootStateDirectory: join(root, "boot"),
      eventSpoolDirectory: join(root, "spool"),
      checkpointReadCacheTtlMs: 600_000,
      checkpointReadCacheMaximumEntries: 512,
      checkpointReadCacheMaximumBytes: 32 * 1_024 * 1_024,
      modelGatewayHost: "127.0.0.1",
      modelGatewayPort: 0,
      modelGatewayAdvertisedBaseUrl: "http://model-gateway.test:4200",
      modelGatewayCapabilityTtlMs: 60_000,
      modelGatewayMaximumRequestsPerTurn: 8,
      modelGatewayUpstreamRequestTimeoutMs: 10_000,
      piModelRequestTimeoutMs: 15_000,
      piTurnTimeoutMs: 60_000,
      repositoryImportLeaseMs: 240_000,
      repositoryImportWaitMs: 300_000,
    };
    expect(
      () =>
        new SupervisorHostRuntime({
          config: {
            ...baseConfig,
            maxConcurrentSessions: 2,
          },
          database,
          objectStore: objectStore(),
          sandboxManager: sandboxManager(),
          temporalWorkerFactory,
        }),
    ).toThrow("Pi SDK Workers require exactly one concurrent Session");
    let first: SupervisorHostRuntime | undefined;
    let second: SupervisorHostRuntime | undefined;
    try {
      first = new SupervisorHostRuntime({
        config: baseConfig,
        database,
        objectStore: objectStore(),
        sandboxManager: sandboxManager(),
        temporalWorkerFactory,
      });
      await first.start();
      expect(first.state).toBe("ready");
      const firstIdentity = first.identity!;
      expect(gateway.activeConnectionCount).toBe(1);
      await first.close();
      expect(first.state).toBe("stopped");

      second = new SupervisorHostRuntime({
        config: baseConfig,
        database,
        objectStore: objectStore(),
        sandboxManager: sandboxManager(),
        temporalWorkerFactory,
      });
      await second.start();
      expect(second.state).toBe("ready");
      const secondIdentity = second.identity!;
      expect(secondIdentity.bootId).not.toBe(firstIdentity.bootId);
      expect(secondIdentity.sandboxId).not.toBe(firstIdentity.sandboxId);

      const oldSandbox = await database
        .selectFrom("sandboxes")
        .select("state")
        .where("id", "=", firstIdentity.sandboxId)
        .executeTakeFirstOrThrow();
      expect(oldSandbox.state).toBe("failed");
      const activeCredential = await database
        .selectFrom("supervisor_boot_credentials")
        .select("boot_id")
        .where("supervisor_id", "=", SUPERVISOR_ID)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow();
      expect(activeCredential.boot_id).toBe(secondIdentity.bootId);
      expect(temporalWorkerOptions).toHaveLength(2);
      expect(temporalWorkerOptions.map((options) => options.sandboxId)).toEqual([
        firstIdentity.sandboxId,
        secondIdentity.sandboxId,
      ]);
      expect(temporalWorkerOptions.map((options) => options.affinityTtlMs)).toEqual([
        600_000, 600_000,
      ]);
      expect(temporalWorkerOptions.map((options) => options.shutdownGraceMs)).toEqual([
        660_000, 660_000,
      ]);
      expect(temporalWorkerOptions.map((options) => options.workerDeployment)).toEqual([
        {
          deploymentName: "agent-dock-pi-workers",
          buildId: "runtime-test-build",
        },
        {
          deploymentName: "agent-dock-pi-workers",
          buildId: "runtime-test-build",
        },
      ]);

      const ledger = JSON.parse(await readFile(join(root, "boot", "boot-ledger.json"), "utf8")) as {
        state: { history: Array<{ bootId: string; status: string }> };
      };
      expect(ledger.state.history).toContainEqual(
        expect.objectContaining({ bootId: firstIdentity.bootId, status: "exited" }),
      );
    } finally {
      await second?.close().catch(() => undefined);
      await first?.close().catch(() => undefined);
      gateway.shutdown();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
