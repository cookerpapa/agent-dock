import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ControlPlaneStore,
  WorkspaceCellMigrationError,
  WorkspaceCellMigrationService,
} from "../src/index.ts";

const TENANT_ID = "81000000-0000-4000-8000-000000000001";
const USER_ID = "81000000-0000-4000-8000-000000000002";
const BINDING_ID = "81000000-0000-4000-8000-000000000003";
const PROFILE_ID = "81000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-08-09T12:00:00.000Z");

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let store: ControlPlaneStore;
let migrations: WorkspaceCellMigrationService;

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
    .values({ id: TENANT_ID, slug: "workspace-cell-migration" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("users")
    .values({ id: USER_ID, tenant_id: TENANT_ID, display_name: "Cell operator" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: BINDING_ID,
      tenant_id: TENANT_ID,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "broker://workspace-cell-migration/fake",
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
  await database
    .insertInto("sandbox_domains")
    .values({
      id: "sandbox-domain-0002",
      display_name: "Migration target domain",
      state: "active",
      tool_broker_base_url: "http://tool-broker-domain-0002:4300",
      workspace_storage_key: "workspace-domain-0002",
      maximum_active_sandboxes: 100,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("execution_cells")
    .values({
      id: "cell-0002",
      display_name: "Migration target",
      state: "active",
      temporal_task_queue: "agent-dock-pi-runs-cell-0002-v1",
      sandbox_domain_id: "sandbox-domain-0001",
      supervisor_management_url_template: "http://{supervisorId}.agent-dock-cell-0002.test:4100",
      capacity_weight: 100,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("execution_cells")
    .values({
      id: "cell-0003",
      display_name: "Cross-domain target",
      state: "active",
      temporal_task_queue: "agent-dock-pi-runs-cell-0003-v1",
      sandbox_domain_id: "sandbox-domain-0002",
      supervisor_management_url_template: "http://{supervisorId}.agent-dock-cell-0003.test:4100",
      capacity_weight: 100,
    })
    .executeTakeFirstOrThrow();
  store = new ControlPlaneStore({
    database,
    tenantId: TENANT_ID,
    defaultModelProfileId: PROFILE_ID,
  });
  migrations = new WorkspaceCellMigrationService({ database, clock: () => NOW });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("drained Workspace Cell migration", () => {
  it("atomically moves an idle Workspace and makes retries idempotent", async () => {
    const project = await store.createProject("cell-migration-idle");
    const input = {
      tenantId: TENANT_ID,
      workspaceId: project.workspaceId,
      targetCellId: "cell-0002",
      requestedByUserId: USER_ID,
      idempotencyKey: `move:${project.workspaceId}:cell-0002`,
    } as const;
    await expect(migrations.migrate(input)).resolves.toMatchObject({
      sourceCellId: "cell-0001",
      targetCellId: "cell-0002",
      baseRowVersion: 0,
      resultRowVersion: 1,
      idempotent: false,
    });
    await expect(migrations.migrate(input)).resolves.toMatchObject({
      resultRowVersion: 1,
      idempotent: true,
    });
    await expect(
      database
        .selectFrom("workspaces")
        .select(["cell_id", "row_version"])
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cell_id: "cell-0002", row_version: "1" });
    const cells = await database
      .selectFrom("execution_cells")
      .select(["id", "assigned_workspaces"])
      .where("id", "in", ["cell-0001", "cell-0002"])
      .orderBy("id", "asc")
      .execute();
    expect(cells).toEqual([
      { id: "cell-0001", assigned_workspaces: "0" },
      { id: "cell-0002", assigned_workspaces: "1" },
    ]);
  });

  it("records a retryable refusal while a Run is queued", async () => {
    const project = await store.createProject("cell-migration-busy");
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "New conversation",
      "ephemeral",
    );
    await store.acceptTurn(session.sessionId, "cell-migration-busy", { prompt: "hold" });
    await expect(
      migrations.migrate({
        tenantId: TENANT_ID,
        workspaceId: project.workspaceId,
        targetCellId: "cell-0002",
        requestedByUserId: USER_ID,
        idempotencyKey: `busy:${project.workspaceId}:cell-0002`,
      }),
    ).rejects.toMatchObject({
      code: "workspace_run_active",
      retryable: true,
    } satisfies Partial<WorkspaceCellMigrationError>);
    await expect(
      database
        .selectFrom("workspace_cell_migrations")
        .select(["state", "failure_code"])
        .where("workspace_id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "failed", failure_code: "workspace_run_active" });
    await expect(
      database
        .selectFrom("workspaces")
        .select("cell_id")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cell_id: "cell-0001" });
  });

  it("requires a drained Cell to be empty before disabling it", async () => {
    await migrations.setCellState("cell-0001", "draining");
    await expect(migrations.setCellState("cell-0001", "disabled")).rejects.toMatchObject({
      code: "cell_not_empty",
      retryable: true,
    });
  });

  it("rejects a Cell move that would silently cross Sandbox Domains", async () => {
    await migrations.setCellState("cell-0001", "active");
    const project = await store.createProject("cross-domain-migration");
    const source = await database
      .selectFrom("workspaces")
      .innerJoin("execution_cells", "execution_cells.id", "workspaces.cell_id")
      .select(["workspaces.cell_id", "execution_cells.sandbox_domain_id"])
      .where("workspaces.id", "=", project.workspaceId)
      .executeTakeFirstOrThrow();
    const targetCellId =
      source.sandbox_domain_id === "sandbox-domain-0002" ? "cell-0002" : "cell-0003";
    await expect(
      migrations.migrate({
        tenantId: TENANT_ID,
        workspaceId: project.workspaceId,
        targetCellId,
        requestedByUserId: USER_ID,
        idempotencyKey: `cross-domain:${project.workspaceId}:${targetCellId}`,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_domain_migration_required",
      retryable: false,
    } satisfies Partial<WorkspaceCellMigrationError>);
    await expect(
      database
        .selectFrom("workspaces")
        .select("cell_id")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cell_id: source.cell_id });
  });
});
