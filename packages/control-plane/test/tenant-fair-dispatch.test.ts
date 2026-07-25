import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ControlPlaneStore,
  OutboxDispatcher,
  type TurnExecutionBackend,
  type TurnExecutionRequest,
} from "../src/index.ts";

const IDS = {
  tenantA: "91000000-0000-4000-8000-000000000001",
  bindingA: "91000000-0000-4000-8000-000000000002",
  profileA: "91000000-0000-4000-8000-000000000003",
  tenantB: "92000000-0000-4000-8000-000000000001",
  bindingB: "92000000-0000-4000-8000-000000000002",
  profileB: "92000000-0000-4000-8000-000000000003",
} as const;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

async function seedTenant(options: {
  tenantId: string;
  bindingId: string;
  profileId: string;
  slug: string;
  maximumConcurrentTurns: number;
}): Promise<ControlPlaneStore> {
  await database
    .insertInto("tenants")
    .values({ id: options.tenantId, slug: options.slug })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: options.bindingId,
      tenant_id: options.tenantId,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: `broker://${options.slug}/fake`,
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: options.profileId,
      tenant_id: options.tenantId,
      name: "default",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: options.bindingId,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: options.tenantId,
      default_model_profile_id: options.profileId,
      maximum_projects: 100,
      maximum_sessions: 100,
      maximum_unsettled_turns: 100,
      maximum_concurrent_turns: options.maximumConcurrentTurns,
    })
    .execute();
  return new ControlPlaneStore({
    database,
    tenantId: options.tenantId,
    defaultModelProfileId: options.profileId,
  });
}

async function createQueuedTurns(
  store: ControlPlaneStore,
  count: number,
  prefix: string,
): Promise<Awaited<ReturnType<ControlPlaneStore["acceptTurn"]>>[]> {
  const project = await store.createProject(`${prefix}-project`);
  const session = await store.createSession(project.projectId, project.workspaceId);
  const turns = [];
  for (let index = 1; index <= count; index += 1) {
    turns.push(
      await store.acceptTurn(session.sessionId, `${prefix}-${String(index)}`, {
        prompt: `${prefix} prompt ${String(index)}`,
      }),
    );
  }
  return turns;
}

async function dispatchUntilWork(
  dispatcher: OutboxDispatcher,
  timeoutMs = 2_000,
): Promise<Awaited<ReturnType<OutboxDispatcher["dispatchNext"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await dispatcher.dispatchNext();
    if (result.status !== "idle" || Date.now() >= deadline) return result;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
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

describe.sequential("global tenant scheduling", () => {
  it("dispatches only the command named by a Temporal Activity while preserving Session FIFO", async () => {
    const store = await seedTenant({
      tenantId: "90000000-0000-4000-8000-000000000001",
      bindingId: "90000000-0000-4000-8000-000000000002",
      profileId: "90000000-0000-4000-8000-000000000003",
      slug: "temporal-target",
      maximumConcurrentTurns: 1,
    });
    const turns = await createQueuedTurns(store, 2, "temporal-target");
    const executed: string[] = [];
    const dispatcher = new OutboxDispatcher({
      database,
      backend: {
        async execute(request, lifecycle) {
          executed.push(request.commandId);
          await lifecycle.started();
          return { stopReason: "temporal-target-test" };
        },
      },
    });

    await expect(dispatcher.dispatchCommand(turns[1]!.commandId)).resolves.toEqual({
      status: "idle",
    });
    expect(executed).toEqual([]);
    await expect(dispatcher.dispatchCommand(turns[0]!.commandId)).resolves.toMatchObject({
      status: "completed",
      commandId: turns[0]!.commandId,
    });
    await expect(dispatcher.dispatchCommand(turns[1]!.commandId)).resolves.toMatchObject({
      status: "completed",
      commandId: turns[1]!.commandId,
    });
    expect(executed).toEqual([turns[0]!.commandId, turns[1]!.commandId]);
    await expect(dispatcher.dispatchCommand("not-a-command")).rejects.toThrow(
      "commandId must be a UUID",
    );
  });

  it("serves a later tenant before an existing tenant drains its backlog", async () => {
    const storeA = await seedTenant({
      tenantId: IDS.tenantA,
      bindingId: IDS.bindingA,
      profileId: IDS.profileA,
      slug: "fair-alpha",
      maximumConcurrentTurns: 1,
    });
    const storeB = await seedTenant({
      tenantId: IDS.tenantB,
      bindingId: IDS.bindingB,
      profileId: IDS.profileB,
      slug: "fair-bravo",
      maximumConcurrentTurns: 1,
    });
    const turnsA = await createQueuedTurns(storeA, 3, "alpha");
    const executionOrder: Array<{ tenantId: string; commandId: string }> = [];
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        executionOrder.push({ tenantId: request.tenantId, commandId: request.commandId });
        await lifecycle.started();
        return { stopReason: "fairness-test" };
      },
    };
    const fixedClock = () => new Date("2100-01-01T00:00:00.000Z");
    const dispatcher = new OutboxDispatcher({ database, backend, clock: fixedClock });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      commandId: turnsA[0]?.commandId,
    });
    const turnsB = await createQueuedTurns(storeB, 2, "bravo");
    for (let index = 0; index < 4; index += 1) {
      await expect(dispatcher.dispatchNext()).resolves.toMatchObject({ status: "completed" });
    }

    expect(executionOrder).toEqual([
      { tenantId: IDS.tenantA, commandId: turnsA[0]?.commandId },
      { tenantId: IDS.tenantB, commandId: turnsB[0]?.commandId },
      { tenantId: IDS.tenantA, commandId: turnsA[1]?.commandId },
      { tenantId: IDS.tenantB, commandId: turnsB[1]?.commandId },
      { tenantId: IDS.tenantA, commandId: turnsA[2]?.commandId },
    ]);
    await expect(dispatcher.dispatchNext()).resolves.toEqual({ status: "idle" });
  });

  it("enforces each tenant's concurrent-turn limit across competing lanes", async () => {
    const tenantA = "93000000-0000-4000-8000-000000000001";
    const tenantB = "94000000-0000-4000-8000-000000000001";
    const storeA = await seedTenant({
      tenantId: tenantA,
      bindingId: "93000000-0000-4000-8000-000000000002",
      profileId: "93000000-0000-4000-8000-000000000003",
      slug: "cap-alpha",
      maximumConcurrentTurns: 1,
    });
    const storeB = await seedTenant({
      tenantId: tenantB,
      bindingId: "94000000-0000-4000-8000-000000000002",
      profileId: "94000000-0000-4000-8000-000000000003",
      slug: "cap-bravo",
      maximumConcurrentTurns: 1,
    });
    await createQueuedTurns(storeA, 1, "cap-alpha-one");
    await createQueuedTurns(storeA, 1, "cap-alpha-two");
    await createQueuedTurns(storeB, 1, "cap-bravo-one");

    const entered: TurnExecutionRequest[] = [];
    let release!: () => void;
    let announceTwo!: () => void;
    const released = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const twoEntered = new Promise<void>((resolvePromise) => {
      announceTwo = resolvePromise;
    });
    const activeByTenant = new Map<string, number>();
    const maximumByTenant = new Map<string, number>();
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        entered.push(request);
        const active = (activeByTenant.get(request.tenantId) ?? 0) + 1;
        activeByTenant.set(request.tenantId, active);
        maximumByTenant.set(
          request.tenantId,
          Math.max(maximumByTenant.get(request.tenantId) ?? 0, active),
        );
        await lifecycle.started();
        if (entered.length === 2) announceTwo();
        await released;
        activeByTenant.set(request.tenantId, active - 1);
        return { stopReason: "concurrency-test" };
      },
    };
    const laneOne = new OutboxDispatcher({ database, backend });
    const laneTwo = new OutboxDispatcher({ database, backend });
    const probeLane = new OutboxDispatcher({ database, backend });
    const dispatches = [laneOne.dispatchNext(), laneTwo.dispatchNext()];
    await twoEntered;

    expect(new Set(entered.map((request) => request.tenantId))).toEqual(
      new Set([tenantA, tenantB]),
    );
    await expect(probeLane.dispatchNext()).resolves.toEqual({ status: "idle" });
    expect(maximumByTenant).toEqual(
      new Map([
        [tenantA, 1],
        [tenantB, 1],
      ]),
    );

    release();
    await expect(Promise.all(dispatches)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    // The production scheduler polls. Under a loaded PGlite socket, a claim
    // transaction can briefly observe the just-completed lanes before their
    // commits become visible on another connection, so exercise the same
    // bounded poll behavior instead of assuming one immediate poll.
    await expect(dispatchUntilWork(probeLane)).resolves.toMatchObject({ status: "completed" });
  });
});
