import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import {
  temporalWorkerAffinityTaskQueue,
  type TemporalRunWorkflowInput,
} from "@agent-dock/temporal-orchestration";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ControlPlaneStore,
  listPendingTemporalRunExecutions,
  PostgresTemporalWorkerAffinity,
} from "../src/index.ts";

const NOW = new Date("2026-07-26T08:00:00.000Z");
const TENANT_ID = "71000000-0000-4000-8000-000000000001";
const BINDING_ID = "71000000-0000-4000-8000-000000000002";
const PROFILE_ID = "71000000-0000-4000-8000-000000000003";
const SANDBOX_ID = "72000000-0000-4000-8000-000000000001";
const OTHER_SANDBOX_ID = "72000000-0000-4000-8000-000000000002";
const BOOT_ID = "72000000-0000-4000-8000-000000000003";

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

  await database
    .insertInto("sandboxes")
    .values({
      id: SANDBOX_ID,
      supervisor_id: "affinity-worker-a",
      boot_id: BOOT_ID,
      state: "ready",
      max_concurrent_sessions: 1,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("supervisor_connections")
    .values({
      connection_id: "73000000-0000-4000-8000-000000000001",
      transport_id: "73000000-0000-4000-8000-000000000002",
      registration_message_id: "73000000-0000-4000-8000-000000000003",
      registered_message_id: "73000000-0000-4000-8000-000000000004",
      sandbox_id: SANDBOX_ID,
      supervisor_id: "affinity-worker-a",
      boot_id: BOOT_ID,
      control_plane_instance_id: "73000000-0000-4000-8000-000000000005",
      state: "active",
      close_reason: null,
      registration_fingerprint: "a".repeat(64),
      supervisor_version: "0.1.0",
      pi_package_name: "@mariozechner/pi-coding-agent",
      pi_version: "0.80.10",
      supported_protocol_versions: [1],
      capabilities: ["pi.sdk"],
      selected_protocol_version: 1,
      heartbeat_interval_ms: 10_000,
      heartbeat_timeout_ms: 30_000,
      accepting_assignments: false,
      registered_at: NOW,
      last_heartbeat_at: NOW,
      expires_at: new Date(NOW.valueOf() + 30_000),
      closed_at: null,
    })
    .executeTakeFirstOrThrow();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("capacity-aware Temporal Worker affinity", () => {
  it("resolves the immutable Workspace Cell into the Temporal routing input", async () => {
    const input = await createAcceptedRun("cell-routing");
    const pending = await listPendingTemporalRunExecutions(database, 100);
    expect(pending.find((candidate) => candidate.commandId === input.commandId)).toEqual(input);
  });

  it("targets a live cached Worker but never reserves beyond its remaining capacity", async () => {
    const affinity = new PostgresTemporalWorkerAffinity({
      database,
      reservationTtlMs: 5_000,
      clock: () => NOW,
    });
    const [first, second] = await Promise.all([
      createAcceptedRun("first"),
      createAcceptedRun("second"),
    ]);
    await Promise.all([
      affinity.remember(first, SANDBOX_ID, 600_000),
      affinity.remember(second, SANDBOX_ID, 600_000),
    ]);

    const reservations = await Promise.all([affinity.reserve(first), affinity.reserve(second)]);
    const selected = reservations.filter((reservation) => reservation !== undefined);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      sandboxId: SANDBOX_ID,
      taskQueue: temporalWorkerAffinityTaskQueue(SANDBOX_ID),
    });
    expect(
      await database.selectFrom("temporal_worker_affinity_reservations").select("id").execute(),
    ).toHaveLength(1);

    const selectedInput = reservations[0] === undefined ? second : first;
    const selectedAffinity = reservations[0] ?? reservations[1]!;
    const routedInput = { ...selectedInput, affinity: selectedAffinity };
    await expect(affinity.claim(routedInput, OTHER_SANDBOX_ID)).resolves.toBe("wrong_worker");
    await expect(affinity.claim(routedInput, SANDBOX_ID)).resolves.toBe("claimed");
    await expect(affinity.claim(routedInput, SANDBOX_ID)).resolves.toBe("stale");
  });

  it("falls back to the shared queue when the preferred Worker is already active", async () => {
    const affinity = new PostgresTemporalWorkerAffinity({
      database,
      reservationTtlMs: 5_000,
      clock: () => NOW,
    });
    const input = await createAcceptedRun("active-worker");
    await affinity.remember(input, SANDBOX_ID, 600_000);
    await database
      .updateTable("sandboxes")
      .set({ active_sessions: 1 })
      .where("id", "=", SANDBOX_ID)
      .executeTakeFirstOrThrow();

    await expect(affinity.reserve(input)).resolves.toBeUndefined();

    await database
      .updateTable("sandboxes")
      .set({ active_sessions: 0 })
      .where("id", "=", SANDBOX_ID)
      .executeTakeFirstOrThrow();
    await expect(affinity.reserve(input)).resolves.toMatchObject({
      sandboxId: SANDBOX_ID,
    });
  });

  it("assigns a new Workspace to the least-loaded active Cell", async () => {
    await database
      .insertInto("execution_cells")
      .values({
        id: "cell-0002",
        display_name: "Secondary test Cell",
        state: "active",
        temporal_task_queue: "agent-dock-pi-runs-cell-0002-v1",
        sandbox_manager_base_url: "http://sandbox-manager-cell-0002.test:4300",
        supervisor_management_url_template: "http://{supervisorId}.agent-dock-cell-0002.test:4100",
        workspace_storage_key: "workspace-cell-0002",
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
