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
} from "../src/index.ts";

const CONTROL_PLANE_ID = "90000000-0000-4000-8000-000000000001";
const SUPERVISOR_ID = "supervisor-host-runtime-test";
const ENROLLMENT_TOKEN = `enrollment-${"e".repeat(48)}`;
const MANAGEMENT_TOKEN = `management-${"m".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let connectionString: string;

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
    operationUrl: "http://sandbox-manager.test/internal/v1/tool-operation",
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
      allowedSupervisorId: SUPERVISOR_ID,
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
      maxConcurrentSessions: 2,
      sandboxManagerBaseUrl: "http://sandbox-manager.test:4300/",
      sandboxManagerRequestTimeoutMs: 300_000,
      trustedWorkspaceDirectory: root,
      bootStateDirectory: join(root, "boot"),
      eventSpoolDirectory: join(root, "spool"),
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
    let first: SupervisorHostRuntime | undefined;
    let second: SupervisorHostRuntime | undefined;
    try {
      first = new SupervisorHostRuntime({
        config: baseConfig,
        database,
        objectStore: objectStore(),
        sandboxManager: sandboxManager(),
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
