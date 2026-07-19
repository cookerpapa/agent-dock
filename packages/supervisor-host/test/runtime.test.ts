import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { DockerSandboxScenarioContext } from "@agent-dock/sandbox-supervisor";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: execFileMock,
  };
});

import {
  PRODUCTION_CANCELLATION_PROBE_PROMPT,
  resolveProductionSandboxScenario,
  SupervisorHostRuntime,
  type SupervisorHostConfig,
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

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(null, "29.4.2\n", ""));
    return {};
  });
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

function emptyInventory() {
  return {
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {
      throw new Error("No assignments exist");
    },
  };
}

describe("SupervisorHostRuntime", () => {
  it("keeps the production fixture closed while providing a deterministic cancellation probe", () => {
    const context = (text: string, restoring = false) =>
      ({
        restoring,
        command: { payload: { input: { kind: "prompt", text } } },
      }) as DockerSandboxScenarioContext;

    expect(resolveProductionSandboxScenario(context("repair the Java fixture"))).toBe(
      "java_repair",
    );
    expect(resolveProductionSandboxScenario(context(PRODUCTION_CANCELLATION_PROBE_PROMPT))).toBe(
      "timeout",
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
      modelCredentialMasterKey: Buffer.alloc(32, 7).toString("base64url"),
      databaseUrl: connectionString,
      managementHost: "127.0.0.1",
      managementPort: 0,
      maxConcurrentSessions: 2,
      sandboxImage: "agent-dock/sandbox:test",
      dockerCommand: "fake-docker",
      bootStateDirectory: join(root, "boot"),
      eventSpoolDirectory: join(root, "spool"),
      dockerProbeTimeoutMs: 1_000,
      modelGatewayHost: "127.0.0.1",
      modelGatewayPort: 0,
      modelGatewayAdvertisedBaseUrl: "http://model-gateway.test:4200",
      sandboxModelNetwork: "agent-dock-test-model-runtime",
      modelGatewayCapabilityTtlMs: 60_000,
      modelGatewayMaximumRequestsPerTurn: 8,
      modelGatewayUpstreamRequestTimeoutMs: 10_000,
      piModelRequestTimeoutMs: 15_000,
      piTurnTimeoutMs: 60_000,
      repositoryImportNetwork: "agent-dock-test-repository-egress",
      repositoryImportTimeoutMs: 180_000,
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
