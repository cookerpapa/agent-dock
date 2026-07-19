import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import {
  createAgentDockEventFactory,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  LocalSandboxSupervisor,
  PiRpcTurnCancelledError,
  SupervisorWebSocketClient,
} from "@agent-dock/sandbox-supervisor";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ControlPlaneStore,
  DurableEventStore,
  HashedBearerSupervisorAuthorizer,
  RemoteSupervisorWorkerRuntime,
  SessionEventHub,
  createRemoteControlPlaneRuntime,
  type RemoteControlPlaneRuntime,
  type RemoteSupervisorDispatchBinding,
  type RemoteSupervisorWorkerActivity,
} from "../src/index.ts";

const IDS = {
  tenant: "81000000-0000-4000-8000-000000000001",
  credential: "81000000-0000-4000-8000-000000000002",
  profile: "81000000-0000-4000-8000-000000000003",
  controlPlane: "81000000-0000-4000-8000-000000000004",
  boot: "81000000-0000-4000-8000-000000000005",
  sandbox: "81000000-0000-4000-8000-000000000006",
} as const;

const SUPERVISOR_ID = "remote-runtime-test";
const TOKEN = `agent-dock-${"w".repeat(48)}`;

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for remote control-plane runtime state");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
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
  if (parsed.type !== "event.publish") throw new Error("Expected an event publication");
  return parsed;
}

async function seed(): Promise<ControlPlaneStore> {
  await database
    .insertInto("tenants")
    .values({ id: IDS.tenant, slug: "remote-runtime" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "broker://remote-runtime/fake",
      version: 1,
      status: "active",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "remote-runtime",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: IDS.tenant,
      default_model_profile_id: IDS.profile,
      maximum_concurrent_turns: 3,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandboxes")
    .values({
      id: IDS.sandbox,
      supervisor_id: SUPERVISOR_ID,
      boot_id: IDS.boot,
      state: "provisioning",
      max_concurrent_sessions: 3,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
  return new ControlPlaneStore({
    database,
    tenantId: IDS.tenant,
    defaultModelProfileId: IDS.profile,
  });
}

async function turnState(turnId: string): Promise<string> {
  return (
    await database
      .selectFrom("turns")
      .select("state")
      .where("id", "=", turnId)
      .executeTakeFirstOrThrow()
  ).state;
}

beforeAll(async () => {
  let connectionString = process.env.AGENT_DOCK_TEST_DATABASE_URL;
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
    // PGlite's socket adapter multiplexes one embedded PostgreSQL engine. Keeping that
    // path on one connection avoids testing adapter protocol concurrency instead of the
    // runtime's asynchronous lane concurrency; the real PostgreSQL path remains pooled.
    maxConnections: pglite === undefined ? 8 : 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("remote control-plane runtime composition", () => {
  it("retries discovery and maintenance failures without overlapping or exposing raw errors", async () => {
    const activities: RemoteSupervisorWorkerActivity[] = [];
    let discoveryCalls = 0;
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    let maintenanceCalls = 0;
    let activeMaintenance = 0;
    let maxActiveMaintenance = 0;
    const runtime = new RemoteSupervisorWorkerRuntime({
      database,
      bindingSource: {
        async listRemoteDispatchBindings() {
          discoveryCalls += 1;
          activeDiscoveries += 1;
          maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          activeDiscoveries -= 1;
          if (discoveryCalls === 1) {
            throw { code: "binding_probe_failed", retryable: true, message: "must not escape" };
          }
          return [];
        },
      },
      maintenanceRunner: {
        async runMaintenanceCycle() {
          maintenanceCalls += 1;
          activeMaintenance += 1;
          maxActiveMaintenance = Math.max(maxActiveMaintenance, activeMaintenance);
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          activeMaintenance -= 1;
          if (maintenanceCalls === 1) {
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
      bindingDiscoveryIntervalMs: 5,
      maintenanceIntervalMs: 5,
      idlePollMs: 5,
      failurePollMs: 5,
      onActivity(activity) {
        activities.push(activity);
      },
    });

    runtime.start();
    expect(() => runtime.start()).toThrow("already started");
    await waitFor(() => discoveryCalls >= 2 && maintenanceCalls >= 2);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(runtime.state).toBe("stopped");
    expect(runtime.activeBindingCount).toBe(0);
    expect(maxActiveDiscoveries).toBe(1);
    expect(maxActiveMaintenance).toBe(1);
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.failure",
          component: "binding_discovery",
          code: "binding_probe_failed",
          retryable: true,
        }),
        expect.objectContaining({
          type: "runtime.failure",
          component: "maintenance",
          code: "maintenance_probe_failed",
          retryable: true,
        }),
        expect.objectContaining({ type: "maintenance.completed" }),
      ]),
    );
    expect(JSON.stringify(activities)).not.toContain("must not escape");
    expect(JSON.stringify(activities)).not.toContain(TOKEN);
  });

  it("does not start dispatch lanes when discovery resolves after drain begins", async () => {
    const activities: RemoteSupervisorWorkerActivity[] = [];
    let discoveryStarted = false;
    let resolveDiscovery!: (bindings: readonly RemoteSupervisorDispatchBinding[]) => void;
    const discovery = new Promise<readonly RemoteSupervisorDispatchBinding[]>((resolvePromise) => {
      resolveDiscovery = resolvePromise;
    });
    const runtime = new RemoteSupervisorWorkerRuntime({
      database,
      bindingSource: {
        async listRemoteDispatchBindings() {
          discoveryStarted = true;
          return discovery;
        },
      },
      maintenanceRunner: {
        async runMaintenanceCycle() {
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
      bindingDiscoveryIntervalMs: 5,
      maintenanceIntervalMs: 5,
      idlePollMs: 5,
      failurePollMs: 5,
      onActivity(activity) {
        activities.push(activity);
      },
    });

    runtime.start();
    await waitFor(() => discoveryStarted);
    runtime.beginDrain();
    resolveDiscovery([
      {
        sandboxId: IDS.sandbox,
        connectionId: uuid(),
        maxConcurrentSessions: 1,
        supervisorAffinity: {
          sandboxId: IDS.sandbox,
          controlPlaneInstanceId: IDS.controlPlane,
        },
        backend: {} as RemoteSupervisorDispatchBinding["backend"],
        leaseCoordinator: {} as RemoteSupervisorDispatchBinding["leaseCoordinator"],
      },
    ]);
    await runtime.stop();

    expect(runtime.state).toBe("stopped");
    expect(runtime.activeBindingCount).toBe(0);
    expect(activities.some((activity) => activity.type === "binding.started")).toBe(false);
  });

  it("automatically executes, cancels, maintains, and drains a real remote Supervisor", async () => {
    const store = await seed();
    const activities: RemoteSupervisorWorkerActivity[] = [];
    let threwObserverFailure = false;
    let runtime: RemoteControlPlaneRuntime | undefined;
    let client: SupervisorWebSocketClient | undefined;
    let runCalls = 0;
    let secondRunActive = false;
    let thirdRunActive = false;

    try {
      runtime = await createRemoteControlPlaneRuntime({
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
            throw new Error("owner stop must not run for a healthy connection");
          },
        },
        assignmentInventoryFactory: () => ({
          async listAssignments() {
            return [];
          },
          async terminateAndConfirmAbsent() {
            throw new Error("empty inventory cannot terminate an assignment");
          },
        }),
        connectionManager: {
          heartbeatIntervalMs: 250,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 60_000,
        },
        commandRouter: {
          commandAckTimeoutMs: 2_000,
          commandResultTimeoutMs: 10_000,
          maxPendingCommands: 8,
        },
        gateway: { registrationTimeoutMs: 2_000 },
        worker: {
          bindingDiscoveryIntervalMs: 25,
          maintenanceIntervalMs: 100,
          idlePollMs: 25,
          failurePollMs: 50,
          maxLanesPerConnection: 2,
          onActivity(activity) {
            activities.push(activity);
            if (activity.type === "maintenance.completed" && !threwObserverFailure) {
              threwObserverFailure = true;
              throw new Error("observer failures are not runtime failures");
            }
          },
        },
      });
      const address = await runtime.listen(0, "127.0.0.1");
      expect(runtime.application.get(DurableEventStore)).toBe(runtime.eventStore);
      expect(runtime.application.get(SessionEventHub)).toBe(runtime.eventHub);

      const supervisor = new LocalSandboxSupervisor({
        maxConcurrentSessions: 3,
        runner: {
          async run(command, publishEvent, signal) {
            runCalls += 1;
            const call = runCalls;
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
            if (call === 1) {
              await publishEvent(
                eventMessage(
                  command,
                  factory.next({
                    type: "turn.completed",
                    payload: { stopReason: "automatic-runtime" },
                  }),
                ),
              );
              return { stopReason: "automatic-runtime" };
            }
            if (call === 2) secondRunActive = true;
            if (call === 3) thirdRunActive = true;
            if (!signal.aborted) {
              await new Promise<void>((resolvePromise) =>
                signal.addEventListener("abort", () => resolvePromise(), { once: true }),
              );
            }
            const reason = (signal.reason as { reason?: string } | undefined)?.reason;
            if (reason === "user_request") {
              await publishEvent(
                eventMessage(
                  command,
                  factory.next({
                    type: "turn.cancelled",
                    payload: { reason: "user_request", forced: false },
                  }),
                ),
              );
              throw new PiRpcTurnCancelledError("user_request", false);
            }
            throw new PiRpcTurnCancelledError("lease_revoked", false);
          },
        },
      });
      client = new SupervisorWebSocketClient({
        url: `${address.replace(/^http/, "ws")}/internal/v1/supervisor`,
        authorizationHeader: `Bearer ${TOKEN}`,
        registration: {
          supervisorId: SUPERVISOR_ID,
          bootId: IDS.boot,
          sandboxId: IDS.sandbox,
          maxConcurrentSessions: 3,
        },
        runtime: supervisor,
        connectTimeoutMs: 2_000,
        closeTimeoutMs: 200,
        eventAckTimeoutMs: 5_000,
      });
      await client.start();
      await waitFor(() => runtime!.worker.activeBindingCount === 1);
      expect(activities.find((activity) => activity.type === "binding.started")).toMatchObject({
        executionLanes: 2,
        cancellationLanes: 2,
      });

      const project = await store.createProject(`automatic-${uuid()}`);
      const session = await store.createSession(project.projectId, project.workspaceId);
      const first = await store.acceptTurn(session.sessionId, `first-${uuid()}`, {
        prompt: "execute without a manual dispatcher",
      });
      await waitFor(async () => (await turnState(first.turnId)) === "completed");
      expect(runCalls).toBe(1);
      expect(
        await database
          .selectFrom("session_events")
          .select(["seq", "type"])
          .where("session_id", "=", session.sessionId)
          .orderBy("seq", "asc")
          .execute(),
      ).toEqual([
        { seq: "1", type: "turn.started" },
        { seq: "2", type: "turn.completed" },
      ]);

      const second = await store.acceptTurn(session.sessionId, `second-${uuid()}`, {
        prompt: "remain active until the independent cancel lane runs",
      });
      await waitFor(() => secondRunActive);
      const maintenanceBeforeCancellation = activities.filter(
        (activity) => activity.type === "maintenance.completed",
      ).length;
      const cancellation = await store.acceptTurnCancellation(
        session.sessionId,
        second.turnId,
        `cancel-${uuid()}`,
        { gracePeriodMs: 100 },
      );
      await waitFor(async () => (await turnState(second.turnId)) === "cancelled");
      expect(
        await database
          .selectFrom("commands")
          .select("state")
          .where("id", "=", cancellation.commandId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "completed" });
      expect(
        activities.some(
          (activity) =>
            activity.type === "dispatch.completed" &&
            activity.kind === "cancel" &&
            activity.status === "cancelled",
        ),
      ).toBe(true);
      await waitFor(
        () =>
          activities.filter((activity) => activity.type === "maintenance.completed").length >
          maintenanceBeforeCancellation,
      );

      const third = await store.acceptTurn(session.sessionId, `third-${uuid()}`, {
        prompt: "prove graceful runtime drain",
      });
      await waitFor(() => thirdRunActive);
      await Promise.all([runtime.close(), runtime.close()]);
      await client.waitUntilClosed();
      expect(runtime.state).toBe("closed");
      expect(runtime.worker.state).toBe("stopped");
      expect(runtime.gateway.activeConnectionCount).toBe(0);
      expect(await turnState(third.turnId)).toBe("failed");
      expect(activities.some((activity) => activity.type === "binding.stopped")).toBe(true);
    } finally {
      await client?.stop().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
    }
  }, 45_000);
});
