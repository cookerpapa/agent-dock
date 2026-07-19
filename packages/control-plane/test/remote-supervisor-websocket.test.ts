import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import {
  createAgentDockEventFactory,
  parseSupervisorToControlMessage,
  TURN_COMMAND_OUTBOX_TOPIC,
  type EventPublishMessage,
  type CancelTurnCommandMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  LocalSandboxSupervisor,
  PiRpcTurnCancelledError,
  SupervisorWebSocketClient,
  type SupervisorTurnRunner,
} from "@agent-dock/sandbox-supervisor";
import Fastify from "fastify";
import { type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssignmentReconciler,
  CancellationDispatcher,
  ControlPlaneStore,
  DurableEventStore,
  HashedBearerSupervisorAuthorizer,
  OutboxDispatcher,
  RemoteSupervisorExecutionBackend,
  SupervisorCommandRouter,
  SupervisorConnectionManager,
  SupervisorWebSocketGateway,
  type RemoteSupervisorCommandTransport,
  type SessionLeaseCoordinator,
  type SupervisorBootIdentity,
  type TurnExecutionRequest,
} from "../src/index.ts";

const CONTROL_PLANE_ID = "30000000-0000-4000-8000-000000000001";
const TOKEN = `agent-dock-${"r".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

type SeededTurn = {
  tenantId: string;
  credentialId: string;
  profileId: string;
  identity: SupervisorBootIdentity;
  store: ControlPlaneStore;
  project: Awaited<ReturnType<ControlPlaneStore["createProject"]>>;
  session: Awaited<ReturnType<ControlPlaneStore["createSession"]>>;
  accepted: Awaited<ReturnType<ControlPlaneStore["acceptTurn"]>>;
};

async function seedTurn(): Promise<SeededTurn> {
  const tenantId = uuid();
  const credentialId = uuid();
  const profileId = uuid();
  const identity = {
    supervisorId: `supervisor-${uuid()}`,
    bootId: uuid(),
    sandboxId: uuid(),
  };
  await database
    .insertInto("tenants")
    .values({ id: tenantId, slug: `remote-${tenantId}` })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: credentialId,
      tenant_id: tenantId,
      provider: "agent-dock-fake",
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
      name: "remote-test",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: credentialId,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandboxes")
    .values({
      id: identity.sandboxId,
      supervisor_id: identity.supervisorId,
      boot_id: identity.bootId,
      state: "provisioning",
      max_concurrent_sessions: 1,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
  const store = new ControlPlaneStore({ database, tenantId, defaultModelProfileId: profileId });
  const project = await store.createProject(`remote-${uuid()}`);
  const session = await store.createSession(project.projectId, project.workspaceId);
  const accepted = await store.acceptTurn(session.sessionId, `turn-${uuid()}`, {
    prompt: "verify remote two-phase delivery",
  });
  return { tenantId, credentialId, profileId, identity, store, project, session, accepted };
}

function executionRequest(seed: SeededTurn): TurnExecutionRequest {
  return {
    tenantId: seed.tenantId,
    projectId: seed.project.projectId,
    workspaceId: seed.project.workspaceId,
    sessionId: seed.session.sessionId,
    turnId: seed.accepted.turnId,
    commandId: seed.accepted.commandId,
    idempotencyKey: `direct-${seed.accepted.commandId}`,
    nextEventSeq: "1",
    input: { kind: "prompt", prompt: "verify remote two-phase delivery" },
    model: {
      profileId: seed.profileId,
      provider: "agent-dock-fake",
      modelId: "agent-dock-fake",
      thinkingLevel: "off",
      credentialBindingId: seed.credentialId,
      credentialBindingVersion: "1",
    },
  };
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

type NetworkHarness = {
  supervisor: LocalSandboxSupervisor;
  client: SupervisorWebSocketClient;
  router: SupervisorCommandRouter;
  leaseCoordinator: SessionLeaseCoordinator;
  backend: RemoteSupervisorExecutionBackend;
  eventMessages: EventPublishMessage[];
  close(): Promise<void>;
};

async function startNetwork(
  seeded: SeededTurn,
  runner: SupervisorTurnRunner,
): Promise<NetworkHarness> {
  const eventMessages: EventPublishMessage[] = [];
  const eventStore = new DurableEventStore({ database, tenantId: seeded.tenantId });
  const router = new SupervisorCommandRouter({
    eventIngestor: eventStore,
    onEvent(message) {
      eventMessages.push(message);
    },
    commandAckTimeoutMs: 1_000,
    commandResultTimeoutMs: 5_000,
    maxPendingCommands: 8,
  });
  const manager = new SupervisorConnectionManager({
    database,
    controlPlaneInstanceId: CONTROL_PLANE_ID,
    ownerBoundary: {
      async stopAndConfirm() {
        return undefined;
      },
    },
    assignmentRetirerFactory: (identity) =>
      new AssignmentReconciler({
        database,
        sandboxId: identity.sandboxId,
        inventory: emptyInventory(),
      }),
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 2_000,
    leaseDurationMs: 5_000,
  });
  const gateway = new SupervisorWebSocketGateway({
    manager,
    commandRouter: router,
    authorizer: new HashedBearerSupervisorAuthorizer({ token: TOKEN, identity: seeded.identity }),
    registrationTimeoutMs: 1_000,
  });
  const server = Fastify({ logger: false });
  gateway.install(server);
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const supervisor = new LocalSandboxSupervisor({ runner, maxConcurrentSessions: 1 });
  const client = new SupervisorWebSocketClient({
    url: `${address.replace(/^http/, "ws")}/internal/v1/supervisor`,
    authorizationHeader: `Bearer ${TOKEN}`,
    registration: { ...seeded.identity, maxConcurrentSessions: 1 },
    runtime: supervisor,
    connectTimeoutMs: 2_000,
    closeTimeoutMs: 200,
    eventAckTimeoutMs: 2_000,
  });
  await client.start();
  const leaseCoordinator = await gateway.currentLeaseCoordinator(seeded.identity.sandboxId);
  const backend = new RemoteSupervisorExecutionBackend({
    sandboxId: seeded.identity.sandboxId,
    transport: router,
    leaseCoordinator,
  });
  return {
    supervisor,
    client,
    router,
    leaseCoordinator,
    backend,
    eventMessages,
    async close() {
      await client.stop();
      await server.close();
    },
  };
}

function eventMessage(
  command: ExecuteTurnCommandMessage,
  event: ReturnType<ReturnType<typeof createAgentDockEventFactory>["next"]>,
): EventPublishMessage {
  const parsed = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: uuid(),
    sentAt: new Date().toISOString(),
    type: "event.publish",
    payload: {
      leaseId: command.payload.leaseId,
      fencingToken: command.payload.fencingToken,
      commandId: command.payload.commandId,
      event,
    },
  });
  if (parsed.type !== "event.publish") throw new Error("Expected event publication");
  return parsed;
}

async function lifecycle(seed: SeededTurn) {
  const state = await database
    .selectFrom("commands as command")
    .innerJoin("turns as turn", "turn.id", "command.turn_id")
    .innerJoin("sessions as session_row", "session_row.id", "command.session_id")
    .select([
      "command.state as commandState",
      "turn.state as turnState",
      "session_row.state as sessionState",
    ])
    .where("command.id", "=", seed.accepted.commandId)
    .executeTakeFirstOrThrow();
  const outbox = await database
    .selectFrom("outbox")
    .select("published_at")
    .where("tenant_id", "=", seed.tenantId)
    .where("aggregate_id", "=", seed.session.sessionId)
    .where("topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
    .executeTakeFirst();
  return { ...state, publishedAt: outbox?.published_at ?? null };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for remote supervisor state");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 8,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 8,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("remote two-phase supervisor execution", () => {
  it("persists the command ACK before run and durably ACKs events over one socket", async () => {
    const seeded = await seedTurn();
    let runCalls = 0;
    const runner: SupervisorTurnRunner = {
      async run(command, publishEvent) {
        runCalls += 1;
        expect(await lifecycle(seeded)).toMatchObject({
          commandState: "acknowledged",
          turnState: "running",
          sessionState: "running",
        });
        const factory = createAgentDockEventFactory(
          {
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            agentId: command.payload.agentId,
          },
          { initialSequence: command.payload.nextEventSeq - 1 },
        );
        await publishEvent(
          eventMessage(
            command,
            factory.next({ type: "turn.started", payload: { inputKind: "prompt" } }),
          ),
        );
        await publishEvent(
          eventMessage(
            command,
            factory.next({ type: "turn.completed", payload: { stopReason: "remote-stop" } }),
          ),
        );
        return { stopReason: "remote-stop" };
      },
    };
    const network = await startNetwork(seeded, runner);
    const observed: Array<{ phase: string; state: Awaited<ReturnType<typeof lifecycle>> }> = [];
    const transport: RemoteSupervisorCommandTransport = {
      async prepare(sandboxId, command) {
        const acknowledgement = await network.router.prepare(sandboxId, command);
        observed.push({ phase: "prepared", state: await lifecycle(seeded) });
        expect(runCalls).toBe(0);
        return acknowledgement;
      },
      async commit(sandboxId, command, acknowledgement, commit) {
        observed.push({ phase: "before-commit", state: await lifecycle(seeded) });
        expect(runCalls).toBe(0);
        return network.router.commit(sandboxId, command, acknowledgement, commit);
      },
      release: (...arguments_) => network.router.release(...arguments_),
    };
    const backend = new RemoteSupervisorExecutionBackend({
      sandboxId: seeded.identity.sandboxId,
      transport,
      leaseCoordinator: network.leaseCoordinator,
    });
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: seeded.tenantId,
      backend,
      leaseManager: network.leaseCoordinator,
    });

    try {
      await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
        status: "completed",
        commandId: seeded.accepted.commandId,
        sessionId: seeded.session.sessionId,
        turnId: seeded.accepted.turnId,
      });
      expect(runCalls).toBe(1);
      expect(observed).toHaveLength(2);
      expect(observed[0]).toMatchObject({
        phase: "prepared",
        state: {
          commandState: "dispatched",
          turnState: "dispatching",
          sessionState: "cold",
          publishedAt: null,
        },
      });
      expect(observed[1]?.phase).toBe("before-commit");
      expect(observed[1]?.state).toMatchObject({
        commandState: "acknowledged",
        turnState: "running",
        sessionState: "running",
      });
      expect(observed[1]?.state.publishedAt).not.toBeNull();
      expect(network.eventMessages.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "turn.completed",
      ]);
      expect(
        await database
          .selectFrom("session_events")
          .select(["seq", "type"])
          .where("session_id", "=", seeded.session.sessionId)
          .orderBy("seq", "asc")
          .execute(),
      ).toEqual([
        { seq: "1", type: "turn.started" },
        { seq: "2", type: "turn.completed" },
      ]);
      expect(await lifecycle(seeded)).toMatchObject({
        commandState: "completed",
        turnState: "completed",
        sessionState: "idle",
      });
      expect(network.supervisor.activeSessionCount).toBe(0);
    } finally {
      await network.close();
    }
  });

  it("releases a prepared command and its lease when durable acknowledgement fails", async () => {
    const seeded = await seedTurn();
    let runCalls = 0;
    const network = await startNetwork(seeded, {
      async run() {
        runCalls += 1;
        return { stopReason: "must-not-run" };
      },
    });
    try {
      await expect(
        network.backend.execute(executionRequest(seeded), {
          async started() {
            throw new Error("simulated durable transaction failure");
          },
        }),
      ).rejects.toMatchObject({ code: "remote_supervisor_error", retryable: true });
      await waitFor(async () => {
        const lease = await database
          .selectFrom("session_leases")
          .select("lease_id")
          .where("session_id", "=", seeded.session.sessionId)
          .executeTakeFirst();
        return lease === undefined && network.supervisor.activeSessionCount === 0;
      });
      expect(runCalls).toBe(0);
      expect(
        await database
          .selectFrom("sandboxes")
          .select(["state", "active_sessions"])
          .where("id", "=", seeded.identity.sandboxId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "ready", active_sessions: 0 });
    } finally {
      await network.close();
    }
  });

  it("delivers a fenced cancellation and settles both command exchanges", async () => {
    const seeded = await seedTurn();
    let runnerStarted = false;
    let observedCancellation:
      { reason: CancelTurnCommandMessage["payload"]["reason"]; forced: boolean } | undefined;
    const runner: SupervisorTurnRunner = {
      async run(command, publishEvent, signal) {
        const factory = createAgentDockEventFactory(
          {
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            agentId: command.payload.agentId,
          },
          { initialSequence: command.payload.nextEventSeq - 1 },
        );
        await publishEvent(
          eventMessage(
            command,
            factory.next({ type: "turn.started", payload: { inputKind: "prompt" } }),
          ),
        );
        runnerStarted = true;
        if (!signal.aborted) {
          await new Promise<void>((resolvePromise) =>
            signal.addEventListener("abort", () => resolvePromise(), { once: true }),
          );
        }
        const cancellation = signal.reason as {
          kind: string;
          reason: CancelTurnCommandMessage["payload"]["reason"];
          gracePeriodMs: number;
        };
        expect(cancellation.kind).toBe("agent-dock.turn-cancellation");
        observedCancellation = { reason: cancellation.reason, forced: false };
        await publishEvent(
          eventMessage(
            command,
            factory.next({
              type: "turn.cancelled",
              payload: { reason: cancellation.reason, forced: false },
            }),
          ),
        );
        throw new PiRpcTurnCancelledError(cancellation.reason, false);
      },
    };
    const network = await startNetwork(seeded, runner);
    const executionDispatcher = new OutboxDispatcher({
      database,
      tenantId: seeded.tenantId,
      backend: network.backend,
      leaseManager: network.leaseCoordinator,
    });
    const cancellationDispatcher = new CancellationDispatcher({
      database,
      tenantId: seeded.tenantId,
      backend: network.backend,
      leaseManager: network.leaseCoordinator,
    });
    try {
      const execution = executionDispatcher.dispatchNext();
      await waitFor(() => runnerStarted);
      const cancellation = await seeded.store.acceptTurnCancellation(
        seeded.session.sessionId,
        seeded.accepted.turnId,
        `cancel-${uuid()}`,
        { gracePeriodMs: 100 },
      );
      await expect(cancellationDispatcher.dispatchNext()).resolves.toMatchObject({
        status: "cancelled",
        commandId: cancellation.commandId,
        targetCommandId: seeded.accepted.commandId,
        forced: false,
      });
      const executionResult = await execution;
      expect(["cancellation_pending", "cancelled"]).toContain(executionResult.status);
      expect(observedCancellation).toEqual({ reason: "user_request", forced: false });
      expect(network.eventMessages.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "turn.cancelled",
      ]);
      expect(await lifecycle(seeded)).toMatchObject({
        commandState: "completed",
        turnState: "cancelled",
        sessionState: "idle",
      });
      expect(
        await database
          .selectFrom("commands")
          .select("state")
          .where("id", "=", cancellation.commandId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "completed" });
      expect(network.supervisor.activeSessionCount).toBe(0);
    } finally {
      await network.close();
    }
  });

  it("revokes a committed runtime when the shared lease channel closes", async () => {
    const seeded = await seedTurn();
    let runnerStarted = false;
    let revokedReason: string | undefined;
    const runner: SupervisorTurnRunner = {
      async run(command, publishEvent, signal) {
        const factory = createAgentDockEventFactory(
          {
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            agentId: command.payload.agentId,
          },
          { initialSequence: command.payload.nextEventSeq - 1 },
        );
        await publishEvent(
          eventMessage(
            command,
            factory.next({ type: "turn.started", payload: { inputKind: "prompt" } }),
          ),
        );
        runnerStarted = true;
        if (!signal.aborted) {
          await new Promise<void>((resolvePromise) =>
            signal.addEventListener("abort", () => resolvePromise(), { once: true }),
          );
        }
        revokedReason = (signal.reason as { reason?: string } | undefined)?.reason;
        throw new PiRpcTurnCancelledError("lease_revoked", false);
      },
    };
    const network = await startNetwork(seeded, runner);
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: seeded.tenantId,
      backend: network.backend,
      leaseManager: network.leaseCoordinator,
    });
    try {
      const execution = dispatcher.dispatchNext();
      await waitFor(() => runnerStarted);
      await network.client.stop();
      await expect(execution).resolves.toMatchObject({
        status: "failed",
        phase: "after_start",
      });
      expect(revokedReason).toBe("lease_revoked");
      expect(await lifecycle(seeded)).toMatchObject({
        commandState: "failed",
        turnState: "failed",
        sessionState: "failed",
      });
      expect(
        await database
          .selectFrom("session_leases")
          .select("lease_id")
          .where("session_id", "=", seeded.session.sessionId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(network.supervisor.activeSessionCount).toBe(0);
    } finally {
      await network.close();
    }
  });
});
