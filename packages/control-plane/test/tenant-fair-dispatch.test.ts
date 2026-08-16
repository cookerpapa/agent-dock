import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ControlPlaneStore,
  RunCommandExecutor,
  type RunCommandExecutionResult,
  type TurnExecutionBackend,
  type TurnExecutionRequest,
} from "../src/index.ts";
import { dispatchNextTestCommand } from "./dispatch-next-test-command.ts";

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
      provider: "pi-cloud-fake",
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
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
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
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "New conversation",
    "ephemeral",
  );
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
  dispatcher: RunCommandExecutor,
  timeoutMs = 2_000,
): Promise<RunCommandExecutionResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await dispatchNextTestCommand(database, dispatcher);
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
  it("dispatches only the command claimed by a Worker while preserving Session FIFO", async () => {
    const store = await seedTenant({
      tenantId: "90000000-0000-4000-8000-000000000001",
      bindingId: "90000000-0000-4000-8000-000000000002",
      profileId: "90000000-0000-4000-8000-000000000003",
      slug: "fair-target",
      maximumConcurrentTurns: 1,
    });
    const turns = await createQueuedTurns(store, 2, "fair-target");
    const executed: string[] = [];
    const dispatcher = new RunCommandExecutor({
      database,
      backend: {
        async execute(request, lifecycle) {
          executed.push(request.commandId);
          await lifecycle.started();
          return { stopReason: "fair-target-test" };
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
    const laneOne = new RunCommandExecutor({ database, backend });
    const laneTwo = new RunCommandExecutor({ database, backend });
    const probeLane = new RunCommandExecutor({ database, backend });
    const dispatches = [
      dispatchNextTestCommand(database, laneOne),
      dispatchNextTestCommand(database, laneTwo),
    ];
    await twoEntered;

    expect(new Set(entered.map((request) => request.tenantId))).toEqual(
      new Set([tenantA, tenantB]),
    );
    await expect(dispatchNextTestCommand(database, probeLane)).resolves.toEqual({ status: "idle" });
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

  it("serializes ordinary conversations that write the same shared Workspace", async () => {
    const tenantId = "95000000-0000-4000-8000-000000000001";
    const store = await seedTenant({
      tenantId,
      bindingId: "95000000-0000-4000-8000-000000000002",
      profileId: "95000000-0000-4000-8000-000000000003",
      slug: "shared-workspace",
      maximumConcurrentTurns: 2,
    });
    const project = await store.createProject("shared-directory");
    const firstSession = await store.createSession(
      project.projectId,
      project.workspaceId,
      "One",
      "ephemeral",
    );
    const secondSession = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Two",
      "ephemeral",
    );
    await store.acceptTurn(firstSession.sessionId, "shared-one", { prompt: "first" });
    await store.acceptTurn(secondSession.sessionId, "shared-two", { prompt: "second" });

    let entered = 0;
    let announceFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => {
      announceFirst = resolvePromise;
    });
    const firstRelease = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const backend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        entered += 1;
        await lifecycle.started();
        if (entered === 1) {
          announceFirst();
          await firstRelease;
        }
        return { stopReason: "shared-workspace-test" };
      },
    };
    const activeLane = new RunCommandExecutor({ database, backend });
    const probeLane = new RunCommandExecutor({ database, backend });
    const first = dispatchNextTestCommand(database, activeLane);
    await firstEntered;
    await expect(dispatchNextTestCommand(database, probeLane)).resolves.toEqual({ status: "idle" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(dispatchUntilWork(probeLane)).resolves.toMatchObject({ status: "completed" });
    expect(entered).toBe(2);
  });
});
