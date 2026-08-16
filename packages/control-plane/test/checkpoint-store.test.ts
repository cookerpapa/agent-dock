import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type {
  EnvironmentRuntimeSnapshot,
  EnvironmentValidationReport,
  ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  FileCheckpointObjectStore,
  PostgresSandboxCheckpointStore,
  SessionLiveStreamCompactionService,
} from "../src/index.ts";

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
  run1: "40000000-0000-4000-8000-000000000001",
  run2: "40000000-0000-4000-8000-000000000002",
  attempt1: "50000000-0000-4000-8000-000000000001",
  attempt2: "50000000-0000-4000-8000-000000000002",
  environment: "10000000-0000-4000-8000-000000000013",
} as const;

const ENVIRONMENT: EnvironmentRuntimeSnapshot = {
  environmentVersionId: IDS.environment,
  versionNumber: 1,
  profileKey: "pi-cloud-fullstack",
  profileVersion: "1",
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

const ENVIRONMENT_VALIDATION: EnvironmentValidationReport = {
  profileKey: "pi-cloud-fullstack",
  profileVersion: "1",
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  isolationBoundary: "microvm",
  runtime: "cubesandbox-kvm",
  networkMode: "public_web_proxy_private_denied",
  runAsUser: "1000:1000",
  readOnlyRootFilesystem: false,
  tools: [
    { name: "node", version: "v24.18.0" },
    { name: "java", version: 'openjdk version "17.0.19"' },
    { name: "python", version: "Python 3.11.2" },
    { name: "git", version: "git version 2.39.5" },
  ],
  recipeCommands: [],
};

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
      runId: turn === 1 ? IDS.run1 : IDS.run2,
      turnId: turn === 1 ? IDS.turn1 : IDS.turn2,
      attemptId: turn === 1 ? IDS.attempt1 : IDS.attempt2,
      agentId: "root",
      leaseId: turn === 1 ? IDS.lease1 : IDS.lease2,
      fencingToken: turn,
      nextEventSeq: turn,
      input: { kind: "prompt", text: `turn ${String(turn)}` },
      sandboxRetention: "ephemeral",
      model: {
        profileId: IDS.profile,
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        thinkingLevel: "off",
        credentialBindingId: IDS.credential,
        credentialBindingVersion: 1,
      },
      environment: ENVIRONMENT,
    },
  };
}

function workspace(label: string): Uint8Array {
  const content = Buffer.from(label).toString("base64");
  const fileHash = createHash("sha256").update(label).digest("hex");
  return Buffer.from(
    `${JSON.stringify({
      format: "pi-cloud.workspace-manifest.v1",
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

async function seed(targetDatabase: Kysely<Database> = database): Promise<void> {
  await targetDatabase
    .insertInto("tenants")
    .values({ id: IDS.tenant, slug: "checkpoint-owner" })
    .execute();
  await targetDatabase
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "checkpoint-project" })
    .execute();
  await targetDatabase
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      object_snapshot_key: null,
    })
    .execute();
  await targetDatabase
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      version_number: 1,
      profile_key: "pi-cloud-fullstack",
      profile_version: "1",
      image_revision: "development",
      spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      state: "pending",
      active: true,
      validated_at: null,
    })
    .execute();
  await targetDatabase
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "pi-cloud-fake",
      kind: "api_key",
      secret_ref: "test://checkpoint",
      version: 1,
      status: "active",
    })
    .execute();
  await targetDatabase
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "checkpoint-profile",
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await targetDatabase
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "running",
      workspace_snapshot_key: null,
      next_event_seq: 1,
      next_mailbox_position: 3,
      last_fencing_token: 1,
      row_version: 1,
    })
    .execute();
  await targetDatabase
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
        provider: "pi-cloud-fake",
        model_id: "pi-cloud-fake",
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
        provider: "pi-cloud-fake",
        model_id: "pi-cloud-fake",
        thinking_level: "off",
        credential_binding_id: IDS.credential,
        credential_binding_version: 1,
      },
    ])
    .execute();
  await targetDatabase
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
  await targetDatabase
    .insertInto("runs")
    .values([
      {
        id: IDS.run1,
        tenant_id: IDS.tenant,
        project_id: IDS.project,
        workspace_id: IDS.workspace,
        session_id: IDS.session,
        turn_id: IDS.turn1,
        command_id: IDS.command1,
        environment_version_id: IDS.environment,
        idempotency_key: "checkpoint-turn-1",
        state: "running",
        current_attempt_id: null,
        attempt_count: 0,
        started_at: new Date(),
      },
      {
        id: IDS.run2,
        tenant_id: IDS.tenant,
        project_id: IDS.project,
        workspace_id: IDS.workspace,
        session_id: IDS.session,
        turn_id: IDS.turn2,
        command_id: IDS.command2,
        environment_version_id: IDS.environment,
        idempotency_key: "checkpoint-turn-2",
        state: "queued",
        current_attempt_id: null,
        attempt_count: 0,
      },
    ])
    .execute();
  await targetDatabase
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
  await targetDatabase
    .insertInto("session_leases")
    .values({
      session_id: IDS.session,
      lease_id: IDS.lease1,
      sandbox_id: IDS.sandbox,
      fencing_token: 1,
      valid_until: new Date(Date.now() + 60_000),
    })
    .execute();
  const claimedAt = new Date(Date.now() - 1_000);
  await targetDatabase
    .insertInto("run_attempts")
    .values({
      id: IDS.attempt1,
      tenant_id: IDS.tenant,
      run_id: IDS.run1,
      attempt_number: 1,
      state: "running",
      claim_owner_id: "checkpoint-test",
      claim_expires_at: new Date(Date.now() + 60_000),
      sandbox_id: IDS.sandbox,
      lease_id: IDS.lease1,
      fencing_token: 1,
      checkpoint_revision: null,
      failure_code: null,
      failure_message: null,
      failure_retryable: null,
      provisioning_at: claimedAt,
      restoring_at: null,
      running_at: claimedAt,
      checkpointing_at: null,
      last_heartbeat_at: claimedAt,
      settled_at: null,
      claimed_at: claimedAt,
      created_at: claimedAt,
      updated_at: claimedAt,
    })
    .execute();
  await targetDatabase
    .updateTable("runs")
    .set({ current_attempt_id: IDS.attempt1, attempt_count: 1 })
    .where("id", "=", IDS.run1)
    .execute();
}

async function insertCompletedEvent(
  turn: 1 | 2,
  targetDatabase: Kysely<Database> = database,
): Promise<void> {
  await targetDatabase
    .insertInto("session_terminal_events")
    .values({
      event_id: `60000000-0000-4000-8000-00000000000${String(turn)}`,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      turn_id: turn === 1 ? IDS.turn1 : IDS.turn2,
      agent_id: "root",
      command_id: turn === 1 ? IDS.command1 : IDS.command2,
      seq: turn,
      schema_version: 1,
      type: "turn.completed",
      payload: { stopReason: "stop" },
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
  objectRoot = await mkdtemp(resolve(tmpdir(), "pi-cloud-checkpoint-store-test-"));
  await seed();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
  await rm(objectRoot, { recursive: true, force: true });
});

describe.sequential("PostgreSQL settled checkpoint store", () => {
  it("commits artifacts under a lease, cold-loads them, and rejects stale or corrupt state", async () => {
    let artifactSequence = 0;
    const store = new PostgresSandboxCheckpointStore({
      database,
      objectStore: new FileCheckpointObjectStore({ rootDirectory: objectRoot }),
      idGenerator: () => `40000000-0000-4000-8000-${String(++artifactSequence).padStart(12, "0")}`,
    });
    await expect(store.load(command(1))).resolves.toBeUndefined();
    const toolOutput = Buffer.alloc(2_048, 0x61);
    const savedToolOutput = await store.saveToolOutput(command(1), {
      toolCallId: "tool-call-large-output",
      bytes: toolOutput,
    });
    expect(savedToolOutput).toMatchObject({
      sha256: createHash("sha256").update(toolOutput).digest("hex"),
      sizeBytes: 2_048,
    });
    const first = await store.save(command(1), null, {
      workspace: workspace("first"),
      environment: ENVIRONMENT_VALIDATION,
    });
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    await expect(store.load(command(1))).resolves.toBeUndefined();
    await insertCompletedEvent(1);
    await expect(store.load(command(1))).resolves.toMatchObject({ revision: first.revision });
    const firstArtifacts = await database
      .selectFrom("artifacts")
      .select(["id", "kind", "run_id"])
      .where("turn_id", "=", IDS.turn1)
      .execute();
    expect(firstArtifacts).toHaveLength(2);
    expect(firstArtifacts).toContainEqual({
      id: savedToolOutput.artifactId,
      kind: "tool_output",
      run_id: IDS.run1,
    });

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
      const claimedAt = new Date(Date.now() - 1_000);
      await transaction
        .insertInto("run_attempts")
        .values({
          id: IDS.attempt2,
          tenant_id: IDS.tenant,
          run_id: IDS.run2,
          attempt_number: 1,
          state: "running",
          claim_owner_id: "checkpoint-test",
          claim_expires_at: new Date(Date.now() + 60_000),
          sandbox_id: IDS.sandbox,
          lease_id: IDS.lease2,
          fencing_token: 2,
          checkpoint_revision: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          provisioning_at: claimedAt,
          restoring_at: claimedAt,
          running_at: claimedAt,
          checkpointing_at: null,
          last_heartbeat_at: claimedAt,
          settled_at: null,
          claimed_at: claimedAt,
          created_at: claimedAt,
          updated_at: claimedAt,
        })
        .execute();
      await transaction
        .updateTable("runs")
        .set({
          state: "running",
          current_attempt_id: IDS.attempt2,
          attempt_count: 1,
          started_at: claimedAt,
        })
        .where("id", "=", IDS.run2)
        .execute();
      await transaction
        .updateTable("run_attempts")
        .set({ state: "completed", settled_at: claimedAt, updated_at: claimedAt })
        .where("id", "=", IDS.attempt1)
        .execute();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: claimedAt })
        .where("id", "=", IDS.run1)
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
      workspace: workspace("first"),
      workspaceRevision: createHash("sha256").update(workspace("first")).digest("hex"),
    });
    const second = await freshStore.save(command(2), first.revision, {
      workspace: workspace("second"),
      environment: ENVIRONMENT_VALIDATION,
    });
    expect(second.revision).not.toBe(first.revision);
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(3);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({ revision: first.revision });
    await insertCompletedEvent(2);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({
      revision: second.revision,
      workspace: workspace("second"),
    });

    await expect(
      freshStore.save(command(2), first.revision, {
        workspace: workspace("stale"),
        environment: ENVIRONMENT_VALIDATION,
      }),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(3);

    const session = await database
      .selectFrom("sessions")
      .select("workspace_snapshot_key")
      .where("id", "=", IDS.session)
      .executeTakeFirstOrThrow();
    expect(session.workspace_snapshot_key).not.toBeNull();
    await writeFile(resolve(objectRoot, session.workspace_snapshot_key!), "corrupt");
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

describe("Valkey Session live-stream compaction", () => {
  it("retries a failed trim and advances the replay floor only after success", async () => {
    const isolatedPglite = await PGlite.create();
    const isolatedSocket = new PGLiteSocketServer({
      db: isolatedPglite,
      host: "127.0.0.1",
      port: 0,
    });
    let isolatedDatabase: Kysely<Database> | undefined;
    try {
      await isolatedSocket.start();
      isolatedDatabase = createDatabase({
        connectionString: `postgresql://postgres@${isolatedSocket.getServerConn()}/postgres?sslmode=disable`,
        maxConnections: 2,
      });
      await runMigrations(isolatedDatabase, "up");
      await seed(isolatedDatabase);
      await isolatedDatabase
        .insertInto("session_event_cursors")
        .values({
          session_id: IDS.session,
          last_persisted_seq: 3,
          last_projected_seq: 3,
          acknowledged_through_seq: 3,
          replay_floor_seq: 0,
        })
        .executeTakeFirstOrThrow();
      await isolatedDatabase
        .insertInto("session_live_stream_compactions")
        .values({
          id: "61000000-0000-4000-8000-000000000001",
          tenant_id: IDS.tenant,
          session_id: IDS.session,
          turn_id: IDS.turn1,
          through_seq: 3,
          state: "pending",
          attempts: 0,
          available_at: new Date(0),
          claim_owner: null,
          claim_until: null,
          last_error: null,
          created_at: new Date(0),
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
      let calls = 0;
      const service = new SessionLiveStreamCompactionService({
        database: isolatedDatabase,
        liveEvents: {
          append: () => Promise.resolve(0),
          readPage: () => Promise.resolve([]),
          readTurn: () => Promise.resolve([]),
          resetSession: () => Promise.resolve(),
          trimThrough: () => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error("injected Valkey outage"))
              : Promise.resolve();
          },
        },
        ownerId: "compaction-test",
        clock: () => new Date("2026-08-10T00:00:00.000Z"),
      });
      await expect(service.runOnce()).rejects.toThrow("injected Valkey outage");
      await isolatedDatabase
        .updateTable("session_live_stream_compactions")
        .set({ available_at: new Date(0) })
        .execute();
      await expect(service.runOnce()).resolves.toMatchObject({
        status: "compacted",
        throughSequence: 3,
      });
      await expect(service.runOnce()).resolves.toEqual({ status: "idle" });
      expect(
        await isolatedDatabase
          .selectFrom("session_event_cursors")
          .select("replay_floor_seq")
          .where("session_id", "=", IDS.session)
          .executeTakeFirst(),
      ).toMatchObject({ replay_floor_seq: "3" });
    } finally {
      await isolatedDatabase?.destroy();
      await isolatedSocket.stop().catch(() => undefined);
      await isolatedPglite.close().catch(() => undefined);
    }
  }, 30_000);
});
