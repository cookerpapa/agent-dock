import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { parseSupervisorToControlMessage } from "@agent-dock/protocol";
import type {
  SandboxAssignmentInventory,
  SandboxRuntimeAssignment,
} from "@agent-dock/sandbox-supervisor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Kysely, sql } from "kysely";
import {
  AssignmentReconciler,
  ControlPlaneStore,
  SessionLeaseCoordinatorError,
  SupervisorConnectionManager,
  SupervisorConnectionManagerError,
  SupervisorOwnerBoundaryError,
  type SupervisorBootIdentity,
  type SupervisorOwnerBoundary,
  type SupervisorTransportAuthority,
  type TurnExecutionRequest,
} from "../src/index.ts";

const CONTROL_PLANE_INSTANCE_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_CONTROL_PLANE_INSTANCE_ID = "10000000-0000-4000-8000-000000000002";
const START_TIME = new Date("2026-07-19T06:00:00.000Z");

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

class EmptyAssignmentInventory implements SandboxAssignmentInventory {
  readonly #beforeList: (() => void) | undefined;

  constructor(beforeList?: () => void) {
    this.#beforeList = beforeList;
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    this.#beforeList?.();
    return [];
  }

  async terminateAndConfirmAbsent(): Promise<void> {
    throw new Error("empty inventory cannot terminate an assignment");
  }
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function testTime(daysBeforeStart: number): Date {
  return new Date(START_TIME.valueOf() - daysBeforeStart * 24 * 60 * 60 * 1_000);
}

function authority(
  options: {
    supervisorId?: string;
    bootId?: string;
    sandboxId?: string;
    transportId?: string;
  } = {},
): SupervisorTransportAuthority {
  return {
    supervisorId: options.supervisorId ?? `supervisor-${uuid()}`,
    bootId: options.bootId ?? uuid(),
    sandboxId: options.sandboxId ?? uuid(),
    transportId: options.transportId ?? uuid(),
  };
}

function registration(
  transportAuthority: SupervisorTransportAuthority,
  options: {
    messageId?: string;
    piVersion?: string;
    capabilities?: readonly string[];
    maxConcurrentSessions?: number;
  } = {},
) {
  return {
    protocolVersion: 1,
    messageId: options.messageId ?? uuid(),
    sentAt: START_TIME.toISOString(),
    type: "supervisor.register",
    payload: {
      supervisorId: transportAuthority.supervisorId,
      bootId: transportAuthority.bootId,
      sandboxId: transportAuthority.sandboxId,
      supervisorVersion: "0.1.0",
      pi: {
        packageName: "@earendil-works/pi-coding-agent",
        version: options.piVersion ?? "0.80.10",
      },
      supportedProtocolVersions: [1],
      capabilities: [...(options.capabilities ?? ["event.replay", "pi.rpc"])],
      maxConcurrentSessions: options.maxConcurrentSessions ?? 1,
    },
  } as const;
}

function heartbeat(options: {
  authority: SupervisorTransportAuthority;
  connectionId: string;
  acceptingAssignments?: boolean;
  maxConcurrentSessions?: number;
  sessions?: readonly {
    sessionId: string;
    turnId: string;
    leaseId: string;
    fencingToken: number;
    lastProducedSeq?: number;
    lastAcknowledgedSeq?: number;
  }[];
}) {
  return parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: uuid(),
    sentAt: START_TIME.toISOString(),
    type: "supervisor.heartbeat",
    payload: {
      supervisorId: options.authority.supervisorId,
      bootId: options.authority.bootId,
      connectionId: options.connectionId,
      acceptingAssignments: options.acceptingAssignments ?? true,
      maxConcurrentSessions: options.maxConcurrentSessions ?? 1,
      sessions: (options.sessions ?? []).map((session) => ({
        sessionId: session.sessionId,
        turnId: session.turnId,
        state: "running" as const,
        leaseId: session.leaseId,
        fencingToken: session.fencingToken,
        lastProducedSeq: session.lastProducedSeq ?? 0,
        lastAcknowledgedSeq: session.lastAcknowledgedSeq ?? 0,
      })),
    },
  });
}

async function provisionSandbox(
  transportAuthority: SupervisorTransportAuthority,
  maxConcurrentSessions = 1,
): Promise<void> {
  await database
    .insertInto("sandboxes")
    .values({
      id: transportAuthority.sandboxId,
      supervisor_id: transportAuthority.supervisorId,
      boot_id: transportAuthority.bootId,
      state: "provisioning",
      max_concurrent_sessions: maxConcurrentSessions,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
}

function manager(options: {
  clock: () => Date;
  ownerBoundary?: SupervisorOwnerBoundary;
  beforeInventory?: () => void;
  retirementRetryDelayMs?: number;
  controlPlaneInstanceId?: string;
}): SupervisorConnectionManager {
  return new SupervisorConnectionManager({
    database,
    controlPlaneInstanceId: options.controlPlaneInstanceId ?? CONTROL_PLANE_INSTANCE_ID,
    clock: options.clock,
    ownerBoundary:
      options.ownerBoundary ??
      ({
        async stopAndConfirm() {
          return undefined;
        },
      } satisfies SupervisorOwnerBoundary),
    assignmentRetirerFactory: (identity) =>
      new AssignmentReconciler({
        database,
        sandboxId: identity.sandboxId,
        inventory: new EmptyAssignmentInventory(options.beforeInventory),
        clock: options.clock,
      }),
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 60_000,
    retirementRetryDelayMs: options.retirementRetryDelayMs ?? 5_000,
    retirementClaimDurationMs: 120_000,
  });
}

async function createAcceptedTurn(): Promise<{
  request: TurnExecutionRequest;
  sessionId: string;
  turnId: string;
  commandId: string;
}> {
  const tenantId = uuid();
  const credentialId = uuid();
  const profileId = uuid();
  await database
    .insertInto("tenants")
    .values({ id: tenantId, slug: `tenant-${tenantId}` })
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
      name: "default",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: credentialId,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  const store = new ControlPlaneStore({
    database,
    tenantId,
    defaultModelProfileId: profileId,
  });
  const project = await store.createProject(`project-${uuid()}`);
  const session = await store.createSession(project.projectId, project.workspaceId);
  const accepted = await store.acceptTurn(session.sessionId, `turn-${uuid()}`, {
    prompt: "keep this assignment alive",
  });
  return {
    sessionId: session.sessionId,
    turnId: accepted.turnId,
    commandId: accepted.commandId,
    request: {
      tenantId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      sessionId: session.sessionId,
      turnId: accepted.turnId,
      commandId: accepted.commandId,
      idempotencyKey: `execute-${accepted.commandId}`,
      nextEventSeq: "1",
      input: { kind: "prompt", prompt: "keep this assignment alive" },
      model: {
        profileId,
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: credentialId,
        credentialBindingVersion: "1",
      },
    },
  };
}

async function markAssignmentAcknowledged(options: {
  sessionId: string;
  turnId: string;
  commandId: string;
  now: Date;
}): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await transaction
      .updateTable("commands")
      .set({
        state: "acknowledged",
        dispatched_at: options.now,
        acknowledged_at: options.now,
      })
      .where("id", "=", options.commandId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("turns")
      .set({ state: "running", started_at: options.now })
      .where("id", "=", options.turnId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("sessions")
      .set({ state: "running", updated_at: options.now, last_active_at: options.now })
      .where("id", "=", options.sessionId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("outbox")
      .set({ attempts: 1, published_at: options.now })
      .where(sql<boolean>`${sql.ref("payload")} ->> 'commandId' = ${options.commandId}`)
      .executeTakeFirstOrThrow();
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

describe.sequential("durable supervisor registration and health management", () => {
  it("authenticates a pre-provisioned sandbox and idempotently repeats one transport handshake", async () => {
    let now = testTime(0);
    const connectionManager = manager({ clock: () => new Date(now) });
    const transportAuthority = authority();
    await provisionSandbox(transportAuthority);
    const message = registration(transportAuthority);

    const wrongAuthority = { ...transportAuthority, sandboxId: uuid() };
    await expect(connectionManager.register(message, wrongAuthority)).rejects.toMatchObject({
      code: "unauthorized_supervisor",
    });
    await expect(
      connectionManager.register(
        registration(transportAuthority, { piVersion: "0.79.0" }),
        transportAuthority,
      ),
    ).rejects.toMatchObject({ code: "unsupported_pi_runtime" });
    expect(
      await database
        .selectFrom("sandboxes")
        .select("state")
        .where("id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "provisioning" });

    const accepted = await connectionManager.register(message, transportAuthority);
    await expect(
      connectionManager.register(
        {
          ...message,
          payload: { ...message.payload, capabilities: ["event.replay", "pi.rpc", "tool.ui"] },
        },
        transportAuthority,
      ),
    ).rejects.toMatchObject({ code: "registration_conflict" });
    await expect(
      connectionManager.register(message, { ...transportAuthority, transportId: uuid() }),
    ).rejects.toMatchObject({ code: "registration_replay" });
    now = new Date(now.valueOf() + 1_000);
    const repeated = await connectionManager.register(message, transportAuthority);
    expect(repeated).toEqual(accepted);
    expect(accepted.payload).toMatchObject({
      supervisorId: transportAuthority.supervisorId,
      bootId: transportAuthority.bootId,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    const persisted = await database
      .selectFrom("supervisor_connections")
      .select(["state", "transport_id"])
      .where("sandbox_id", "=", transportAuthority.sandboxId)
      .execute();
    expect(persisted).toEqual([{ state: "active", transport_id: transportAuthority.transportId }]);
  });

  it("supersedes a same-boot reconnect and rejects the old connection generation", async () => {
    const now = testTime(1);
    const connectionManager = manager({ clock: () => new Date(now) });
    const firstAuthority = authority();
    await provisionSandbox(firstAuthority);
    const first = await connectionManager.register(registration(firstAuthority), firstAuthority);
    const secondAuthority = { ...firstAuthority, transportId: uuid() };
    const second = await connectionManager.register(registration(secondAuthority), secondAuthority);
    expect(second.payload.connectionId).not.toBe(first.payload.connectionId);

    await expect(
      connectionManager.heartbeat(
        heartbeat({ authority: firstAuthority, connectionId: first.payload.connectionId }),
        firstAuthority,
      ),
    ).rejects.toMatchObject({ code: "stale_connection" });
    const acknowledgement = await connectionManager.heartbeat(
      heartbeat({ authority: secondAuthority, connectionId: second.payload.connectionId }),
      secondAuthority,
    );
    expect(acknowledgement.payload.connectionId).toBe(second.payload.connectionId);
    const states = await database
      .selectFrom("supervisor_connections")
      .select(["connection_id", "state", "close_reason"])
      .where("sandbox_id", "=", firstAuthority.sandboxId)
      .orderBy("registered_at", "asc")
      .execute();
    expect(states).toEqual([
      {
        connection_id: first.payload.connectionId,
        state: "superseded",
        close_reason: "reconnected",
      },
      { connection_id: second.payload.connectionId, state: "active", close_reason: null },
    ]);
  });

  it("fences an older boot while admitting its separately provisioned replacement", async () => {
    const now = testTime(2);
    const connectionManager = manager({ clock: () => new Date(now) });
    const oldAuthority = authority();
    await provisionSandbox(oldAuthority);
    const oldConnection = await connectionManager.register(
      registration(oldAuthority),
      oldAuthority,
    );
    const replacementAuthority = authority({ supervisorId: oldAuthority.supervisorId });
    await provisionSandbox(replacementAuthority);
    await connectionManager.register(registration(replacementAuthority), replacementAuthority);

    expect(
      await database
        .selectFrom("sandboxes")
        .select(["id", "state"])
        .where("id", "in", [oldAuthority.sandboxId, replacementAuthority.sandboxId])
        .orderBy("id", "asc")
        .execute(),
    ).toEqual(
      [
        { id: oldAuthority.sandboxId, state: "failed" },
        { id: replacementAuthority.sandboxId, state: "ready" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      await database
        .selectFrom("supervisor_connections")
        .select(["state", "close_reason"])
        .where("connection_id", "=", oldConnection.payload.connectionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "fenced", close_reason: "new_boot" });
    expect(
      await database
        .selectFrom("sandbox_retirements")
        .select(["reason", "state"])
        .where("sandbox_id", "=", oldAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ reason: "new_boot", state: "pending" });
  });

  it("renews assignment and connection atomically, then honors acceptingAssignments=false", async () => {
    let now = testTime(3);
    const connectionManager = manager({ clock: () => new Date(now) });
    const transportAuthority = authority();
    await provisionSandbox(transportAuthority, 2);
    const registered = await connectionManager.register(
      registration(transportAuthority, { maxConcurrentSessions: 2 }),
      transportAuthority,
    );
    const accepted = await createAcceptedTurn();
    const coordinator = await connectionManager.leaseCoordinator(
      registered.payload.connectionId,
      transportAuthority,
    );
    const lease = await coordinator.acquire(accepted.request);
    await markAssignmentAcknowledged({ ...accepted, now });
    const before = await database
      .selectFrom("session_leases")
      .select("valid_until")
      .where("session_id", "=", accepted.sessionId)
      .executeTakeFirstOrThrow();

    now = new Date(now.valueOf() + 10_000);
    const acknowledgement = await connectionManager.heartbeat(
      heartbeat({
        authority: transportAuthority,
        connectionId: registered.payload.connectionId,
        acceptingAssignments: false,
        maxConcurrentSessions: 2,
        sessions: [
          {
            sessionId: accepted.sessionId,
            turnId: accepted.turnId,
            leaseId: lease.leaseId,
            fencingToken: lease.fencingToken,
          },
        ],
      }),
      transportAuthority,
    );
    expect(acknowledgement.payload.leaseRenewals).toHaveLength(1);
    const after = await database
      .selectFrom("session_leases")
      .select("valid_until")
      .where("session_id", "=", accepted.sessionId)
      .executeTakeFirstOrThrow();
    expect(new Date(after.valid_until).valueOf()).toBeGreaterThan(
      new Date(before.valid_until).valueOf(),
    );
    expect(
      await database
        .selectFrom("supervisor_connections")
        .select("accepting_assignments")
        .where("connection_id", "=", registered.payload.connectionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ accepting_assignments: false });

    const follower = await createAcceptedTurn();
    await expect(coordinator.acquire(follower.request)).rejects.toEqual(
      expect.objectContaining<Partial<SessionLeaseCoordinatorError>>({
        code: "connection_not_accepting",
        retryable: true,
      }),
    );
  });

  it("retains an ambiguous lease after timeout until owner stop and reconciliation complete", async () => {
    let now = testTime(4);
    let ownerStopped = false;
    const stopped: SupervisorBootIdentity[] = [];
    const connectionManager = manager({
      clock: () => new Date(now),
      ownerBoundary: {
        async stopAndConfirm(identity) {
          stopped.push(identity);
          ownerStopped = true;
        },
      },
      beforeInventory() {
        expect(ownerStopped).toBe(true);
      },
    });
    const transportAuthority = authority();
    await provisionSandbox(transportAuthority);
    const registered = await connectionManager.register(
      registration(transportAuthority),
      transportAuthority,
    );
    const accepted = await createAcceptedTurn();
    const coordinator = await connectionManager.leaseCoordinator(
      registered.payload.connectionId,
      transportAuthority,
    );
    await coordinator.acquire(accepted.request);
    await markAssignmentAcknowledged({ ...accepted, now });

    now = new Date(now.valueOf() + 30_001);
    const sweep = await connectionManager.expireConnections();
    expect(sweep).toMatchObject({ scannedConnections: 1, expiredConnections: 1 });
    expect(stopped).toEqual([]);
    expect(
      await database
        .selectFrom("session_leases")
        .select("session_id")
        .where("session_id", "=", accepted.sessionId)
        .executeTakeFirst(),
    ).toBeDefined();
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed", active_sessions: 1 });

    const retirement = await connectionManager.processNextRetirement();
    expect(retirement).toMatchObject({
      kind: "retired",
      identity: {
        supervisorId: transportAuthority.supervisorId,
        bootId: transportAuthority.bootId,
        sandboxId: transportAuthority.sandboxId,
      },
      reconciliation: { settledAssignments: 1, sandboxState: "terminated" },
    });
    expect(stopped).toHaveLength(1);
    expect(
      await database
        .selectFrom("session_leases")
        .select("session_id")
        .where("session_id", "=", accepted.sessionId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom("turns")
        .select(["state", "failure_code"])
        .where("id", "=", accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed", failure_code: "assignment_lost" });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "terminated", active_sessions: 0 });
  });

  it("durably delays a retryable owner-stop failure and blocks a non-retryable one", async () => {
    let now = testTime(5);
    let attempts = 0;
    const retryAuthority = authority();
    const retryManager = manager({
      clock: () => new Date(now),
      retirementRetryDelayMs: 5_000,
      ownerBoundary: {
        async stopAndConfirm() {
          attempts += 1;
          if (attempts === 1) {
            throw new SupervisorOwnerBoundaryError(
              "owner_stop_unavailable",
              "Injected owner stop failure",
              true,
            );
          }
        },
      },
    });
    await provisionSandbox(retryAuthority);
    await retryManager.register(registration(retryAuthority), retryAuthority);
    now = new Date(now.valueOf() + 30_001);
    await retryManager.expireConnections();
    expect(await retryManager.processNextRetirement()).toMatchObject({
      kind: "retry_scheduled",
      attempt: 1,
      errorCode: "owner_stop_unavailable",
    });
    expect(await retryManager.processNextRetirement()).toEqual({ kind: "idle" });
    now = new Date(now.valueOf() + 5_000);
    expect(await retryManager.processNextRetirement()).toMatchObject({
      kind: "retired",
      attempt: 2,
    });

    const blockedAuthority = authority();
    const blockedManager = manager({
      clock: () => new Date(now),
      ownerBoundary: {
        async stopAndConfirm() {
          throw new SupervisorOwnerBoundaryError(
            "owner_identity_mismatch",
            "Injected owner identity mismatch",
            false,
          );
        },
      },
    });
    await provisionSandbox(blockedAuthority);
    await blockedManager.register(registration(blockedAuthority), blockedAuthority);
    now = new Date(now.valueOf() + 30_001);
    await blockedManager.expireConnections();
    expect(await blockedManager.processNextRetirement()).toMatchObject({
      kind: "blocked",
      errorCode: "owner_identity_mismatch",
    });
    expect(
      await database
        .selectFrom("sandbox_retirements")
        .select(["state", "last_error"])
        .where("sandbox_id", "=", blockedAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "blocked", last_error: "owner_identity_mismatch" });
  });

  it("lets another control-plane instance reclaim an abandoned retirement claim", async () => {
    let now = testTime(6);
    let releaseFirstOwner!: () => void;
    let reportFirstClaim!: () => void;
    const firstOwnerReleased = new Promise<void>((resolvePromise) => {
      releaseFirstOwner = resolvePromise;
    });
    const firstClaimed = new Promise<void>((resolvePromise) => {
      reportFirstClaim = resolvePromise;
    });
    const transportAuthority = authority();
    const firstManager = manager({
      clock: () => new Date(now),
      ownerBoundary: {
        async stopAndConfirm() {
          reportFirstClaim();
          await firstOwnerReleased;
        },
      },
    });
    await provisionSandbox(transportAuthority);
    await firstManager.register(registration(transportAuthority), transportAuthority);
    now = new Date(now.valueOf() + 30_001);
    await firstManager.expireConnections();

    const abandonedWork = firstManager.processNextRetirement();
    await firstClaimed;
    now = new Date(now.valueOf() + 120_001);
    const replacementManager = manager({
      clock: () => new Date(now),
      controlPlaneInstanceId: SECOND_CONTROL_PLANE_INSTANCE_ID,
    });
    expect(await replacementManager.processNextRetirement()).toMatchObject({
      kind: "retired",
      attempt: 2,
    });
    releaseFirstOwner();
    await expect(abandonedWork).rejects.toMatchObject({
      code: "supervisor_connection_invariant",
    });
    expect(
      await database
        .selectFrom("sandbox_retirements")
        .select(["state", "attempts"])
        .where("sandbox_id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "completed", attempts: 2 });
  });

  it("cannot revive an expired same-boot registration", async () => {
    let now = testTime(7);
    const connectionManager = manager({ clock: () => new Date(now) });
    const transportAuthority = authority();
    await provisionSandbox(transportAuthority);
    const message = registration(transportAuthority);
    await connectionManager.register(message, transportAuthority);
    now = new Date(now.valueOf() + 30_001);

    await expect(connectionManager.register(message, transportAuthority)).rejects.toEqual(
      expect.objectContaining<Partial<SupervisorConnectionManagerError>>({
        code: "stale_registration",
        retryable: false,
      }),
    );
    expect(
      await database
        .selectFrom("sandboxes")
        .select("state")
        .where("id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed" });
    expect(
      await database
        .selectFrom("sandbox_retirements")
        .select("reason")
        .where("sandbox_id", "=", transportAuthority.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ reason: "heartbeat_timeout" });
  });
});
