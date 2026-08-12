import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { TemporalRunWorkflowInput } from "@agent-dock/temporal-orchestration";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneStore, listPendingTemporalRunExecutions } from "../src/index.ts";

const NOW = new Date("2026-07-26T08:00:00.000Z");
const TENANT_ID = "71000000-0000-4000-8000-000000000001";
const BINDING_ID = "71000000-0000-4000-8000-000000000002";
const PROFILE_ID = "71000000-0000-4000-8000-000000000003";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let store: ControlPlaneStore;

function workflowInput(
  accepted: Awaited<ReturnType<ControlPlaneStore["acceptTurn"]>>,
): TemporalRunWorkflowInput {
  return {
    schemaVersion: 2,
    cellId: "cell-0001",
    taskQueue: "agent-dock-pi-runs-cell-0001-v1",
    tenantId: TENANT_ID,
    sessionId: accepted.sessionId,
    runId: accepted.runId,
    commandId: accepted.commandId,
  };
}

async function createAcceptedRun(name: string): Promise<TemporalRunWorkflowInput> {
  const project = await store.createProject(`affinity-${name}`);
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "New conversation",
    "ephemeral",
  );
  return workflowInput(
    await store.acceptTurn(session.sessionId, `affinity-${name}`, {
      prompt: `affinity ${name}`,
    }),
  );
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

  await database
    .insertInto("tenants")
    .values({ id: TENANT_ID, slug: "temporal-affinity" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: BINDING_ID,
      tenant_id: TENANT_ID,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "broker://temporal-affinity/fake",
      version: 1,
      status: "active",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("model_profiles")
    .values({
      id: PROFILE_ID,
      tenant_id: TENANT_ID,
      name: "default",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: BINDING_ID,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: TENANT_ID,
      default_model_profile_id: PROFILE_ID,
      maximum_projects: 100,
      maximum_sessions: 100,
      maximum_unsettled_turns: 100,
      maximum_concurrent_turns: 10,
    })
    .executeTakeFirstOrThrow();
  store = new ControlPlaneStore({
    database,
    tenantId: TENANT_ID,
    defaultModelProfileId: PROFILE_ID,
  });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("Temporal Cell routing", () => {
  it("resolves the immutable Workspace Cell into the Temporal routing input", async () => {
    const input = await createAcceptedRun("cell-routing");
    const pending = await listPendingTemporalRunExecutions(database, 100);
    expect(pending.find((candidate) => candidate.commandId === input.commandId)).toEqual({
      ...input,
      outboxId: expect.any(String),
    });
  });

  it("removes handed-off Workflows from the bounded relay window before Worker execution", async () => {
    await database
      .updateTable("outbox")
      .set({ temporal_handed_off_at: NOW })
      .where("temporal_handed_off_at", "is", null)
      .execute();
    const first = await createAcceptedRun("handoff-first");
    const second = await createAcceptedRun("handoff-second");
    const third = await createAcceptedRun("handoff-third");
    const firstWindow = await listPendingTemporalRunExecutions(database, 2);
    const handedOff = firstWindow.filter((candidate) =>
      [first.commandId, second.commandId, third.commandId].includes(candidate.commandId),
    );
    expect(handedOff).toHaveLength(2);
    await database
      .updateTable("outbox")
      .set({ temporal_handed_off_at: NOW })
      .where(
        "id",
        "in",
        handedOff.map((candidate) => candidate.outboxId),
      )
      .execute();
    const nextWindow = await listPendingTemporalRunExecutions(database, 100);
    const remaining = nextWindow.filter((candidate) =>
      [first.commandId, second.commandId, third.commandId].includes(candidate.commandId),
    );
    expect(remaining).toHaveLength(1);
  });

  it("assigns a new Workspace to the least-loaded active Cell", async () => {
    await database
      .insertInto("execution_cells")
      .values({
        id: "cell-0002",
        display_name: "Secondary test Cell",
        state: "active",
        temporal_task_queue: "agent-dock-pi-runs-cell-0002-v1",
        sandbox_domain_id: "sandbox-domain-0001",
        supervisor_management_url_template: "http://{supervisorId}.agent-dock-cell-0002.test:4100",
        capacity_weight: 100,
      })
      .executeTakeFirstOrThrow();
    const project = await store.createProject("cell-placement");
    const workspace = await database
      .selectFrom("workspaces")
      .select("cell_id")
      .where("id", "=", project.workspaceId)
      .executeTakeFirstOrThrow();
    expect(workspace.cell_id).toBe("cell-0002");
  });
});
