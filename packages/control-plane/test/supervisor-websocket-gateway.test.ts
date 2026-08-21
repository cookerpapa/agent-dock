import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { parseSupervisorToControlMessage } from "@pi-cloud/protocol";
import { AgentRunSupervisor, SupervisorWebSocketClient } from "@pi-cloud/sandbox-supervisor";
import Fastify from "fastify";
import { type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AssignmentReconciler,
  HashedBearerSupervisorAuthorizer,
  SUPERVISOR_WEBSOCKET_PATH,
  SupervisorConnectionManager,
  SupervisorWebSocketGateway,
  createControlPlaneApplication,
  type SupervisorBootIdentity,
  type SupervisorOwnerBoundary,
} from "../src/index.ts";

const CONTROL_PLANE_1 = "20000000-0000-4000-8000-000000000001";
const CONTROL_PLANE_2 = "20000000-0000-4000-8000-000000000002";
const TOKEN = `pi-cloud-${"a".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function identity(): SupervisorBootIdentity {
  return {
    supervisorId: `supervisor-${uuid()}`,
    bootId: uuid(),
    sandboxId: uuid(),
  };
}

async function provision(value: SupervisorBootIdentity): Promise<void> {
  await database
    .insertInto("sandboxes")
    .values({
      id: value.sandboxId,
      supervisor_id: value.supervisorId,
      boot_id: value.bootId,
      state: "provisioning",
      max_concurrent_sessions: 1,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
}

function emptyInventory() {
  return {
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {
      throw new Error("empty inventory cannot terminate a runtime");
    },
  };
}

async function startGateway(options: {
  identity: SupervisorBootIdentity;
  token?: string;
  controlPlaneInstanceId?: string;
  clock?: () => Date;
  ownerBoundary?: SupervisorOwnerBoundary;
  maxPayloadBytes?: number;
  registrationTimeoutMs?: number;
  useNestApplication?: boolean;
}): Promise<{
  server: { close(): Promise<unknown> };
  url: string;
  gateway: SupervisorWebSocketGateway;
  manager: SupervisorConnectionManager;
}> {
  const clock = options.clock ?? (() => new Date());
  const manager = new SupervisorConnectionManager({
    database,
    controlPlaneInstanceId: options.controlPlaneInstanceId ?? CONTROL_PLANE_1,
    ownerBoundary:
      options.ownerBoundary ??
      ({
        async stopAndConfirm() {
          return undefined;
        },
      } satisfies SupervisorOwnerBoundary),
    assignmentRetirerFactory: (retirementIdentity) =>
      new AssignmentReconciler({
        database,
        sandboxId: retirementIdentity.sandboxId,
        inventory: emptyInventory(),
        clock,
      }),
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 2_000,
    leaseDurationMs: 3_000,
    retirementClaimDurationMs: 5_000,
    retirementRetryDelayMs: 100,
    clock,
  });
  const gateway = new SupervisorWebSocketGateway({
    manager,
    authorizer: new HashedBearerSupervisorAuthorizer({
      token: options.token ?? TOKEN,
      identity: options.identity,
    }),
    maxPayloadBytes: options.maxPayloadBytes ?? 1024 * 1024,
    maxPendingFrames: 4,
    registrationTimeoutMs: options.registrationTimeoutMs ?? 500,
  });
  if (options.useNestApplication) {
    const tenantId = uuid();
    const credentialId = uuid();
    const profileId = uuid();
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: `gateway-${tenantId}` })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("credential_bindings")
      .values({
        id: credentialId,
        tenant_id: tenantId,
        provider: "pi-cloud-fake",
        kind: "brokered",
        secret_ref: `broker://${tenantId}/fake`,
        version: 1,
        status: "active",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "default",
        provider: "pi-cloud-fake",
        model_id: "pi-cloud-fake",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: credentialId,
        credential_binding_version: 1,
        enabled: true,
      })
      .executeTakeFirstOrThrow();
    const application = await createControlPlaneApplication({
      database,
      tenantId,
      defaultModelProfileId: profileId,
      supervisorWebSocketGateway: gateway,
    });
    await application.listen(0, "127.0.0.1");
    const address = await application.getUrl();
    return {
      server: application,
      gateway,
      manager,
      url: `${address.replace(/^http/, "ws")}${SUPERVISOR_WEBSOCKET_PATH}`,
    };
  }
  const server = Fastify({ logger: false });
  gateway.install(server);
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  return {
    server,
    gateway,
    manager,
    url: `${address.replace(/^http/, "ws")}${SUPERVISOR_WEBSOCKET_PATH}`,
  };
}

function client(url: string, token: string, value: SupervisorBootIdentity) {
  const runtime = new AgentRunSupervisor({
    runner: {
      async run() {
        return { stopReason: "unused" };
      },
    },
    maxConcurrentSessions: 1,
  });
  return new SupervisorWebSocketClient({
    url,
    authorizationHeader: `Bearer ${token}`,
    registration: {
      ...value,
      maxConcurrentSessions: 1,
    },
    runtime,
    connectTimeoutMs: 2_000,
    closeTimeoutMs: 200,
  });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for WebSocket condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function openRaw(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    perMessageDeflate: false,
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once("open", resolvePromise);
    socket.once("error", rejectPromise);
  });
  return socket;
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise) => {
    socket.once("close", (code, reason) => {
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("authenticated supervisor WebSocket transport", () => {
  it("rejects a bad bearer credential before registration without exposing it", async () => {
    const supervisorIdentity = identity();
    await provision(supervisorIdentity);
    const gateway = await startGateway({ identity: supervisorIdentity });
    const wrongToken = `wrong-${"b".repeat(48)}`;
    const unauthorized = client(gateway.url, wrongToken, supervisorIdentity);
    try {
      await expect(unauthorized.start()).rejects.toMatchObject({
        code: "supervisor_authentication_rejected",
      });
      const result = await unauthorized.waitUntilClosed();
      expect(result).toMatchObject({
        failureCode: "supervisor_authentication_rejected",
        retryable: false,
      });
      expect(JSON.stringify(result)).not.toContain(wrongToken);
      expect(gateway.gateway.activeConnectionCount).toBe(0);
      expect(
        await database
          .selectFrom("supervisor_connections")
          .select("connection_id")
          .where("sandbox_id", "=", supervisorIdentity.sandboxId)
          .execute(),
      ).toEqual([]);
    } finally {
      await unauthorized.stop();
      await gateway.server.close();
    }
  });

  it("registers and heartbeats over a real socket, while clean disconnect waits for durable expiry", async () => {
    let now = new Date();
    let ownerStops = 0;
    const supervisorIdentity = identity();
    await provision(supervisorIdentity);
    const gateway = await startGateway({
      identity: supervisorIdentity,
      clock: () => new Date(now),
      ownerBoundary: {
        async stopAndConfirm() {
          ownerStops += 1;
        },
      },
      useNestApplication: true,
    });
    const connected = client(gateway.url, TOKEN, supervisorIdentity);
    try {
      const registered = await connected.start();
      expect(connected.connectionId).toBe(registered.payload.connectionId);
      connected.setAcceptingAssignments(false);
      await waitFor(async () => {
        const row = await database
          .selectFrom("supervisor_connections")
          .select("accepting_assignments")
          .where("connection_id", "=", registered.payload.connectionId)
          .executeTakeFirst();
        return row?.accepting_assignments === false;
      });
      expect(gateway.gateway.activeConnectionCount).toBe(1);

      const stopped = await connected.stop();
      expect(stopped).toMatchObject({ initiatedByClient: true, code: 1_000 });
      await waitFor(() => gateway.gateway.activeConnectionCount === 0);
      expect(
        await database
          .selectFrom("supervisor_connections")
          .select("state")
          .where("connection_id", "=", registered.payload.connectionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "active" });
      expect(
        await database
          .selectFrom("sandboxes")
          .select("state")
          .where("id", "=", supervisorIdentity.sandboxId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "ready" });
      expect(ownerStops).toBe(0);

      now = new Date(now.valueOf() + 2_001);
      const sweep = await gateway.manager.expireConnections();
      expect(sweep.expiredConnectionIds).toContain(registered.payload.connectionId);
      expect(ownerStops).toBe(0);
      expect(
        await database
          .selectFrom("sandboxes")
          .select("state")
          .where("id", "=", supervisorIdentity.sandboxId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "failed" });
    } finally {
      await connected.stop();
      await gateway.server.close();
    }
  });

  it("uses PostgreSQL to reject an old socket after reconnecting through another replica", async () => {
    const supervisorIdentity = identity();
    await provision(supervisorIdentity);
    const firstGateway = await startGateway({
      identity: supervisorIdentity,
      controlPlaneInstanceId: CONTROL_PLANE_1,
    });
    const secondGateway = await startGateway({
      identity: supervisorIdentity,
      controlPlaneInstanceId: CONTROL_PLANE_2,
    });
    const first = client(firstGateway.url, TOKEN, supervisorIdentity);
    const second = client(secondGateway.url, TOKEN, supervisorIdentity);
    try {
      const firstRegistration = await first.start();
      const secondRegistration = await second.start();
      expect(secondRegistration.payload.connectionId).not.toBe(
        firstRegistration.payload.connectionId,
      );
      const oldClose = await first.waitUntilClosed();
      expect(oldClose).toMatchObject({ initiatedByClient: false, code: 1_008 });
      expect(second.state).toBe("registered");

      const connections = await database
        .selectFrom("supervisor_connections")
        .select(["connection_id", "control_plane_instance_id", "state", "close_reason"])
        .where("sandbox_id", "=", supervisorIdentity.sandboxId)
        .orderBy("registered_at", "asc")
        .execute();
      expect(connections).toEqual([
        {
          connection_id: firstRegistration.payload.connectionId,
          control_plane_instance_id: CONTROL_PLANE_1,
          state: "superseded",
          close_reason: "reconnected",
        },
        {
          connection_id: secondRegistration.payload.connectionId,
          control_plane_instance_id: CONTROL_PLANE_2,
          state: "active",
          close_reason: null,
        },
      ]);
    } finally {
      await first.stop();
      await second.stop();
      await firstGateway.server.close();
      await secondGateway.server.close();
    }
  });

  it("closes active sockets and rejects new upgrades during idempotent shutdown", async () => {
    const supervisorIdentity = identity();
    await provision(supervisorIdentity);
    const hosted = await startGateway({ identity: supervisorIdentity });
    const connected = client(hosted.url, TOKEN, supervisorIdentity);
    const blocked = client(hosted.url, TOKEN, supervisorIdentity);
    try {
      await connected.start();
      expect(hosted.gateway.activeConnectionCount).toBe(1);

      hosted.gateway.shutdown();
      hosted.gateway.shutdown();
      expect(hosted.gateway.shuttingDown).toBe(true);
      expect(await connected.waitUntilClosed()).toMatchObject({
        initiatedByClient: false,
        code: 1_012,
        reason: "control plane shutting down",
        retryable: true,
      });
      expect(hosted.gateway.activeConnectionCount).toBe(0);
      await expect(blocked.start()).rejects.toMatchObject({
        code: "websocket_handshake_rejected",
        retryable: true,
      });
    } finally {
      await connected.stop();
      await blocked.stop();
      await hosted.server.close();
    }
  });

  it("enforces registration-first, text-only, timeout, and frame-size boundaries", async () => {
    const supervisorIdentity = identity();
    await provision(supervisorIdentity);
    const gateway = await startGateway({
      identity: supervisorIdentity,
      maxPayloadBytes: 1_024,
      registrationTimeoutMs: 100,
    });
    try {
      const earlyHeartbeat = await openRaw(gateway.url);
      const earlyClose = closed(earlyHeartbeat);
      earlyHeartbeat.send(
        JSON.stringify(
          parseSupervisorToControlMessage({
            protocolVersion: 1,
            messageId: uuid(),
            sentAt: new Date().toISOString(),
            type: "supervisor.heartbeat",
            payload: {
              supervisorId: supervisorIdentity.supervisorId,
              bootId: supervisorIdentity.bootId,
              connectionId: uuid(),
              acceptingAssignments: true,
              maxConcurrentSessions: 1,
              sessions: [],
            },
          }),
        ),
      );
      expect(await earlyClose).toMatchObject({ code: 1_008, reason: "registration required" });

      const binary = await openRaw(gateway.url);
      const binaryClose = closed(binary);
      binary.send(Buffer.from("not-json"), { binary: true });
      expect(await binaryClose).toMatchObject({ code: 1_003, reason: "binary frames unsupported" });

      const silent = await openRaw(gateway.url);
      expect(await closed(silent)).toMatchObject({ code: 1_008, reason: "registration timeout" });

      const oversized = await openRaw(gateway.url);
      const oversizedClose = closed(oversized);
      oversized.send("x".repeat(2_048));
      expect((await oversizedClose).code).toBe(1_009);
      await waitFor(() => gateway.gateway.activeConnectionCount === 0);
    } finally {
      await gateway.server.close();
    }
  });
});
