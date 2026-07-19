import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { FileCheckpointObjectStore, PostgresSandboxCheckpointStore } from "../src/index.ts";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  project: "10000000-0000-4000-8000-000000000002",
  workspace: "10000000-0000-4000-8000-000000000003",
  credential: "10000000-0000-4000-8000-000000000004",
  profile: "10000000-0000-4000-8000-000000000005",
  session: "10000000-0000-4000-8000-000000000006",
  turn1: "10000000-0000-4000-8000-000000000007",
  turn2: "10000000-0000-4000-8000-000000000008",
  sandbox: "10000000-0000-4000-8000-000000000009",
  boot: "10000000-0000-4000-8000-000000000010",
  lease1: "10000000-0000-4000-8000-000000000011",
  lease2: "10000000-0000-4000-8000-000000000012",
  command1: "30000000-0000-4000-8000-000000000001",
  command2: "30000000-0000-4000-8000-000000000002",
} as const;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let objectRoot: string;

function command(turn: 1 | 2): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: `20000000-0000-4000-8000-00000000000${String(turn)}`,
    sentAt: "2026-07-19T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      commandId: turn === 1 ? IDS.command1 : IDS.command2,
      idempotencyKey: `checkpoint-turn-${String(turn)}`,
      tenantId: IDS.tenant,
      projectId: IDS.project,
      workspaceId: IDS.workspace,
      sessionId: IDS.session,
      turnId: turn === 1 ? IDS.turn1 : IDS.turn2,
      agentId: "root",
      leaseId: turn === 1 ? IDS.lease1 : IDS.lease2,
      fencingToken: turn,
      nextEventSeq: turn,
      input: { kind: "prompt", text: `turn ${String(turn)}` },
      model: {
        profileId: IDS.profile,
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: IDS.credential,
        credentialBindingVersion: 1,
      },
    },
  };
}

function piSession(label: string): Uint8Array {
  return Buffer.from(
    [
      JSON.stringify({ type: "session", version: 3, id: "pi-checkpoint", cwd: "/workspace" }),
      JSON.stringify({
        type: "message",
        id: `assistant-${label}`,
        parentId: null,
        timestamp: "2026-07-19T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: label }] },
      }),
      "",
    ].join("\n"),
  );
}

function workspace(label: string): Uint8Array {
  const content = Buffer.from(label).toString("base64");
  const fileHash = createHash("sha256").update(label).digest("hex");
  return Buffer.from(
    `${JSON.stringify({
      format: "agent-dock.workspace-manifest.v1",
      files: [
        {
          path: "state.txt",
          executable: false,
          sizeBytes: Buffer.byteLength(label),
          sha256: fileHash,
          content,
        },
      ],
    })}\n`,
  );
}

async function seed(): Promise<void> {
  await database
    .insertInto("tenants")
    .values({ id: IDS.tenant, slug: "checkpoint-owner" })
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "checkpoint-project" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      object_snapshot_key: null,
    })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "api_key",
      secret_ref: "test://checkpoint",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "checkpoint-profile",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "running",
      pi_session_snapshot_key: null,
      workspace_snapshot_key: null,
      next_event_seq: 1,
      next_mailbox_position: 3,
      last_fencing_token: 1,
      row_version: 1,
    })
    .execute();
  await database
    .insertInto("turns")
    .values([
      {
        id: IDS.turn1,
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        state: "running",
        input_kind: "prompt",
        input_text: "turn one",
        model_profile_id: IDS.profile,
        provider: "agent-dock-fake",
        model_id: "agent-dock-fake",
        thinking_level: "off",
        credential_binding_id: IDS.credential,
        credential_binding_version: 1,
      },
      {
        id: IDS.turn2,
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        state: "queued",
        input_kind: "prompt",
        input_text: "turn two",
        model_profile_id: IDS.profile,
        provider: "agent-dock-fake",
        model_id: "agent-dock-fake",
        thinking_level: "off",
        credential_binding_id: IDS.credential,
        credential_binding_version: 1,
      },
    ])
    .execute();
  await database
    .insertInto("commands")
    .values([
      {
        id: IDS.command1,
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        turn_id: IDS.turn1,
        idempotency_key: "checkpoint-turn-1",
        kind: "turn.execute",
        mailbox_position: 1,
        state: "acknowledged",
        payload: { schemaVersion: 1 },
        acknowledged_at: new Date(),
        failure_code: null,
      },
      {
        id: IDS.command2,
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        turn_id: IDS.turn2,
        idempotency_key: "checkpoint-turn-2",
        kind: "turn.execute",
        mailbox_position: 2,
        state: "pending",
        payload: { schemaVersion: 1 },
        failure_code: null,
      },
    ])
    .execute();
  await database
    .insertInto("sandboxes")
    .values({
      id: IDS.sandbox,
      supervisor_id: "checkpoint-test",
      boot_id: IDS.boot,
      state: "leased",
      max_concurrent_sessions: 1,
      active_sessions: 1,
    })
    .execute();
  await database
    .insertInto("session_leases")
    .values({
      session_id: IDS.session,
      lease_id: IDS.lease1,
      sandbox_id: IDS.sandbox,
      fencing_token: 1,
      valid_until: new Date(Date.now() + 60_000),
    })
    .execute();
}

async function insertCompletedEvent(turn: 1 | 2): Promise<void> {
  await database
    .insertInto("session_events")
    .values({
      event_id: `60000000-0000-4000-8000-00000000000${String(turn)}`,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      turn_id: turn === 1 ? IDS.turn1 : IDS.turn2,
      agent_node_id: null,
      agent_id: "root",
      command_id: null,
      seq: turn,
      schema_version: 1,
      type: "turn.completed",
      payload: { stopReason: "stop" },
      lease_id: turn === 1 ? IDS.lease1 : IDS.lease2,
      fencing_token: turn,
      occurred_at: new Date(),
    })
    .execute();
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  objectRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-checkpoint-store-test-"));
  await seed();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
  await rm(objectRoot, { recursive: true, force: true });
});

describe("PostgreSQL settled checkpoint store", () => {
  it("commits artifacts under a lease, cold-loads them, and rejects stale or corrupt state", async () => {
    let artifactSequence = 0;
    const store = new PostgresSandboxCheckpointStore({
      database,
      objectStore: new FileCheckpointObjectStore({ rootDirectory: objectRoot }),
      idGenerator: () => `40000000-0000-4000-8000-${String(++artifactSequence).padStart(12, "0")}`,
    });
    await expect(store.load(command(1))).resolves.toBeUndefined();
    const first = await store.save(command(1), null, {
      piSession: piSession("first"),
      workspace: workspace("first"),
    });
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    await expect(store.load(command(1))).resolves.toBeUndefined();
    await insertCompletedEvent(1);
    await expect(store.load(command(1))).resolves.toMatchObject({ revision: first.revision });
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(2);

    await database.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom("session_leases")
        .where("session_id", "=", IDS.session)
        .execute();
      await transaction
        .updateTable("turns")
        .set({ state: "completed", stop_reason: "stop", settled_at: new Date() })
        .where("id", "=", IDS.turn1)
        .execute();
      await transaction
        .updateTable("turns")
        .set({ state: "running", started_at: new Date() })
        .where("id", "=", IDS.turn2)
        .execute();
      await transaction
        .updateTable("commands")
        .set({ state: "acknowledged", acknowledged_at: new Date() })
        .where("id", "=", IDS.command2)
        .execute();
      await transaction
        .updateTable("sessions")
        .set({ state: "running", last_fencing_token: 2 })
        .where("id", "=", IDS.session)
        .execute();
      await transaction
        .insertInto("session_leases")
        .values({
          session_id: IDS.session,
          lease_id: IDS.lease2,
          sandbox_id: IDS.sandbox,
          fencing_token: 2,
          valid_until: new Date(Date.now() + 60_000),
        })
        .execute();
    });

    const freshStore = new PostgresSandboxCheckpointStore({
      database,
      objectStore: new FileCheckpointObjectStore({ rootDirectory: objectRoot }),
      idGenerator: () => `50000000-0000-4000-8000-${String(++artifactSequence).padStart(12, "0")}`,
    });
    const restored = await freshStore.load(command(2));
    expect(restored).toEqual({
      revision: first.revision,
      piSession: piSession("first"),
      workspace: workspace("first"),
    });
    const second = await freshStore.save(command(2), first.revision, {
      piSession: piSession("second"),
      workspace: workspace("second"),
    });
    expect(second.revision).not.toBe(first.revision);
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(4);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({ revision: first.revision });
    await insertCompletedEvent(2);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({ revision: second.revision });

    await expect(
      freshStore.save(command(2), first.revision, {
        piSession: piSession("stale"),
        workspace: workspace("stale"),
      }),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(4);

    const session = await database
      .selectFrom("sessions")
      .select(["pi_session_snapshot_key", "workspace_snapshot_key"])
      .where("id", "=", IDS.session)
      .executeTakeFirstOrThrow();
    expect(session.pi_session_snapshot_key).not.toBeNull();
    await writeFile(resolve(objectRoot, session.pi_session_snapshot_key!), "corrupt");
    await expect(freshStore.load(command(2))).rejects.toMatchObject({ code: "checkpoint_corrupt" });

    const expiredStore = new PostgresSandboxCheckpointStore({
      database,
      objectStore: new FileCheckpointObjectStore({ rootDirectory: objectRoot }),
      clock: () => new Date(Date.now() + 120_000),
    });
    await expect(expiredStore.load(command(2))).rejects.toMatchObject({
      code: "stale_checkpoint_fence",
    });
  }, 30_000);
});
