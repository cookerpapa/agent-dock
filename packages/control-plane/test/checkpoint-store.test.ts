import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type {
  EnvironmentRuntimeSnapshot,
  EnvironmentValidationReport,
  ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  FileCheckpointObjectStore,
  PI_SESSION_MANIFEST_MEDIA_TYPE,
  PostgresSandboxCheckpointStore,
  S3CheckpointObjectStore,
  decodePiSessionManifest,
  type S3CheckpointObjectStoreOptions,
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
  profileKey: "agent-dock-fullstack",
  profileVersion: "1",
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

const ENVIRONMENT_VALIDATION: EnvironmentValidationReport = {
  profileKey: "agent-dock-fullstack",
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
      model: {
        profileId: IDS.profile,
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: IDS.credential,
        credentialBindingVersion: 1,
      },
      environment: ENVIRONMENT,
    },
  };
}

function piSession(label: string): Uint8Array {
  const labels = label === "second" ? ["first", "second"] : [label];
  return Buffer.from(
    [
      JSON.stringify({ type: "session", version: 3, id: "pi-checkpoint", cwd: "/workspace" }),
      ...labels.map((entry, index) =>
        JSON.stringify({
          type: "message",
          id: `assistant-${entry}`,
          parentId: index === 0 ? null : `assistant-${labels[index - 1]}`,
          timestamp: "2026-07-19T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: entry }] },
        }),
      ),
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
      profile_key: "agent-dock-fullstack",
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
      provider: "agent-dock-fake",
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
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
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
      pi_session_snapshot_key: null,
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
      piSession: piSession("first"),
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
    expect(firstArtifacts).toHaveLength(3);
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
      piSession: piSession("first"),
      workspace: workspace("first"),
      workspaceRevision: createHash("sha256").update(workspace("first")).digest("hex"),
    });
    const second = await freshStore.save(command(2), first.revision, {
      piSession: piSession("second"),
      workspace: workspace("second"),
      environment: ENVIRONMENT_VALIDATION,
    });
    expect(second.revision).not.toBe(first.revision);
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(5);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({ revision: first.revision });
    await insertCompletedEvent(2);
    await expect(freshStore.load(command(2))).resolves.toMatchObject({
      revision: second.revision,
      piSession: piSession("second"),
    });
    const piArtifacts = await database
      .selectFrom("artifacts")
      .select(["object_key", "media_type"])
      .where("kind", "=", "pi_session_snapshot")
      .orderBy("created_at")
      .execute();
    expect(piArtifacts).toHaveLength(2);
    expect(
      piArtifacts.every((artifact) => artifact.media_type === PI_SESSION_MANIFEST_MEDIA_TYPE),
    ).toBe(true);
    const firstManifest = decodePiSessionManifest(
      await readFile(resolve(objectRoot, piArtifacts[0]!.object_key)),
    );
    const secondManifest = decodePiSessionManifest(
      await readFile(resolve(objectRoot, piArtifacts[1]!.object_key)),
    );
    expect(firstManifest.mode).toBe("rebase");
    expect(secondManifest.mode).toBe("append");
    expect(secondManifest.previousManifestSha256).toBe(
      createHash("sha256")
        .update(await readFile(resolve(objectRoot, piArtifacts[0]!.object_key)))
        .digest("hex"),
    );
    expect(secondManifest.segments[0]).toEqual(firstManifest.segments[0]);

    await expect(
      freshStore.save(command(2), first.revision, {
        piSession: piSession("stale"),
        workspace: workspace("stale"),
        environment: ENVIRONMENT_VALIDATION,
      }),
    ).rejects.toMatchObject({ code: "checkpoint_conflict" });
    expect(await database.selectFrom("artifacts").selectAll().execute()).toHaveLength(5);

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

type S3IntegrationConfiguration = {
  options: S3CheckpointObjectStoreOptions;
  physicalPrefix: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

function s3IntegrationConfiguration(): S3IntegrationConfiguration {
  const endpoint = process.env.AGENT_DOCK_TEST_S3_ENDPOINT;
  const bucket = process.env.AGENT_DOCK_TEST_S3_BUCKET;
  const accessKeyId = process.env.AGENT_DOCK_TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AGENT_DOCK_TEST_S3_SECRET_ACCESS_KEY;
  const physicalPrefix = process.env.AGENT_DOCK_TEST_S3_KEY_PREFIX;
  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    physicalPrefix === undefined
  ) {
    throw new Error("S3 checkpoint integration environment is incomplete");
  }
  const credentials = { accessKeyId, secretAccessKey };
  return {
    physicalPrefix,
    credentials,
    options: {
      endpoint,
      bucket,
      region: "us-east-1",
      keyPrefix: physicalPrefix,
      forcePathStyle: true,
      allowInsecureEndpoint: endpoint.startsWith("http://"),
      credentials,
      maxAttempts: 2,
    },
  };
}

const s3IntegrationEnabled = process.env.AGENT_DOCK_TEST_S3_ENDPOINT !== undefined;

describe.skipIf(!s3IntegrationEnabled)("S3-compatible settled checkpoint store", () => {
  it("restores through a fresh adapter and detects immutable conflicts and remote corruption", async () => {
    const configuration = s3IntegrationConfiguration();
    const isolatedPglite = await PGlite.create();
    const isolatedSocket = new PGLiteSocketServer({
      db: isolatedPglite,
      host: "127.0.0.1",
      port: 0,
    });
    let isolatedDatabase: Kysely<Database> | undefined;
    let readerObjectStore: S3CheckpointObjectStore | undefined;
    let rawClient: S3Client | undefined;
    try {
      rawClient = new S3Client({
        endpoint: configuration.options.endpoint!,
        region: configuration.options.region,
        forcePathStyle: true,
        credentials: configuration.credentials,
        maxAttempts: 1,
      });
      await rawClient.send(new CreateBucketCommand({ Bucket: configuration.options.bucket }));
      await isolatedSocket.start();
      isolatedDatabase = createDatabase({
        connectionString: `postgresql://postgres@${isolatedSocket.getServerConn()}/postgres?sslmode=disable`,
        maxConnections: 2,
      });
      await runMigrations(isolatedDatabase, "up");
      await seed(isolatedDatabase);

      const writerObjectStore = new S3CheckpointObjectStore(configuration.options);
      let savedRevision: string;
      try {
        const writer = new PostgresSandboxCheckpointStore({
          database: isolatedDatabase,
          objectStore: writerObjectStore,
          idGenerator: (() => {
            let sequence = 0;
            return () => `70000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
          })(),
        });
        const saved = await writer.save(command(1), null, {
          piSession: piSession("remote"),
          workspace: workspace("remote"),
          environment: ENVIRONMENT_VALIDATION,
        });
        savedRevision = saved.revision;
        await writerObjectStore.put("probes/immutable.bin", Buffer.from("first"));
        await insertCompletedEvent(1, isolatedDatabase);
      } finally {
        writerObjectStore.destroy();
      }

      readerObjectStore = new S3CheckpointObjectStore(configuration.options);
      await expect(
        readerObjectStore.put("probes/immutable.bin", Buffer.from("replacement")),
      ).rejects.toMatchObject({ code: "checkpoint_object_exists", retryable: false });
      await expect(readerObjectStore.get("probes/immutable.bin")).resolves.toEqual(
        Buffer.from("first"),
      );

      const reader = new PostgresSandboxCheckpointStore({
        database: isolatedDatabase,
        objectStore: readerObjectStore,
      });
      await expect(reader.load(command(1))).resolves.toEqual({
        revision: savedRevision,
        piSession: piSession("remote"),
        workspace: workspace("remote"),
      });

      const session = await isolatedDatabase
        .selectFrom("sessions")
        .select("pi_session_snapshot_key")
        .where("id", "=", IDS.session)
        .executeTakeFirstOrThrow();
      expect(session.pi_session_snapshot_key).not.toBeNull();
      await rawClient.send(
        new PutObjectCommand({
          Bucket: configuration.options.bucket,
          Key: `${configuration.physicalPrefix}/${session.pi_session_snapshot_key!}`,
          Body: Buffer.from("corrupt"),
        }),
      );
      await expect(reader.load(command(1))).rejects.toMatchObject({
        code: "checkpoint_corrupt",
        retryable: false,
      });

      await rawClient.send(
        new PutObjectCommand({
          Bucket: configuration.options.bucket,
          Key: `${configuration.physicalPrefix}/probes/oversized.bin`,
          Body: Buffer.alloc(2 * 1_024 * 1_024 + 1),
        }),
      );
      await expect(readerObjectStore.get("probes/oversized.bin")).rejects.toMatchObject({
        code: "checkpoint_object_invalid",
        retryable: false,
      });
    } finally {
      rawClient?.destroy();
      readerObjectStore?.destroy();
      await isolatedDatabase?.destroy();
      await isolatedSocket.stop().catch(() => undefined);
      await isolatedPglite.close().catch(() => undefined);
    }
  }, 60_000);
});
