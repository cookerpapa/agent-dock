import { createDatabase, runMigrations } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  WorkspaceVolumeDeletionReaper,
  workspaceVolumeId,
} from "../src/index.ts";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  activation: "40000000-0000-4000-8000-000000000001",
  broker: "50000000-0000-4000-8000-000000000001",
  supervisor: "60000000-0000-4000-8000-000000000001",
  boot: "70000000-0000-4000-8000-000000000001",
  sandbox: "80000000-0000-4000-8000-000000000001",
  command: "90000000-0000-4000-8000-000000000001",
  session: "a0000000-0000-4000-8000-000000000001",
  turn: "b0000000-0000-4000-8000-000000000001",
  attempt: "c0000000-0000-4000-8000-000000000001",
  lease: "d0000000-0000-4000-8000-000000000001",
} as const;

describe("WorkspaceVolumeDeletionReaper", () => {
  it("waits for the live Cube activation before purging POSIX Workspace data", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-dock-delete-reaper-"));
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 1,
    });
    try {
      await runMigrations(database, "up");
      await database
        .insertInto("tenants")
        .values({ id: IDS.tenant, slug: "volume-delete" })
        .execute();
      await database
        .insertInto("projects")
        .values({ id: IDS.project, tenant_id: IDS.tenant, name: "Volume delete" })
        .execute();
      await database
        .insertInto("sandbox_domains")
        .values({
          id: "sandbox-domain-delete",
          display_name: "Delete",
          state: "active",
          tool_broker_base_url: "http://delete.invalid",
          workspace_storage_key: "delete",
        })
        .execute();
      await database
        .insertInto("workspaces")
        .values({
          id: IDS.workspace,
          tenant_id: IDS.tenant,
          project_id: IDS.project,
          sandbox_domain_id: "sandbox-domain-delete",
          object_snapshot_key: null,
        })
        .execute();

      const volumeId = workspaceVolumeId({ tenantId: IDS.tenant, workspaceId: IDS.workspace });
      const gateway = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
      await gateway.prepare({
        tenantId: IDS.tenant,
        workspaceId: IDS.workspace,
        sessionId: "session-delete",
        volumeId,
      });
      const volumeRoot = join(workspaceRoot, `agentdock-posix-${volumeId}`);
      await writeFile(join(volumeRoot, "workspace", "private.txt"), "private\n");
      await database
        .updateTable("workspaces")
        .set({ deleted_at: new Date() })
        .where("id", "=", IDS.workspace)
        .execute();
      await database
        .insertInto("tool_broker_instances")
        .values({
          instance_id: IDS.broker,
          sandbox_domain_id: "sandbox-domain-delete",
          owner_base_url: "http://broker-delete.invalid",
          state: "ready",
          lease_expires_at: new Date(Date.now() + 60_000),
          last_heartbeat_at: new Date(),
        })
        .execute();
      // This test only needs the activation lifecycle row; its unrelated Run graph is
      // covered by the Tool Broker integration suite.
      await pglite.exec("alter table tool_broker_activations disable trigger all");
      await database
        .insertInto("tool_broker_activations")
        .values({
          activation_id: IDS.activation,
          sandbox_domain_id: "sandbox-domain-delete",
          owner_instance_id: IDS.broker,
          owner_base_url: "http://broker-delete.invalid",
          tenant_id: IDS.tenant,
          project_id: IDS.project,
          workspace_id: IDS.workspace,
          supervisor_id: IDS.supervisor,
          boot_id: IDS.boot,
          sandbox_id: IDS.sandbox,
          command_id: IDS.command,
          session_id: IDS.session,
          turn_id: IDS.turn,
          attempt_id: IDS.attempt,
          lease_id: IDS.lease,
          fencing_token: 1,
          capability_sha256: "a".repeat(64),
          turn_context_sha256: "b".repeat(64),
          attempt_context_sha256: "c".repeat(64),
          environment_sha256: "d".repeat(64),
          workspace_revision: null,
          runtime_id: "runtime-delete",
          runtime_name: "CubeSandbox",
          state: "warm",
          failure_code: null,
        })
        .execute();
      await pglite.exec("alter table tool_broker_activations enable trigger all");

      const reaper = new WorkspaceVolumeDeletionReaper({ database, gateway });
      await expect(reaper.runOnce()).resolves.toBe(0);
      await expect(lstat(volumeRoot)).resolves.toMatchObject({});
      await database
        .updateTable("tool_broker_activations")
        .set({ state: "released" })
        .where("activation_id", "=", IDS.activation)
        .execute();
      await expect(reaper.runOnce()).resolves.toBe(1);
      await expect(lstat(volumeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        database
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", IDS.workspace)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ storage_purged_at: expect.any(Date) });
      await reaper.close();
    } finally {
      await database.destroy();
      await socket.stop();
      await pglite.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
