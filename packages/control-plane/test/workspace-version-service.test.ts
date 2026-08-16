import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  createPersistentVolumeReference,
  createWorkspaceSnapshot,
} from "@pi-cloud/workspace-runtime";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { ControlPlaneStore, WorkspaceVersionService } from "../src/index.ts";

const IDS = {
  tenant: "11000000-0000-4000-8000-000000000001",
  otherTenant: "11000000-0000-4000-8000-000000000002",
  project: "12000000-0000-4000-8000-000000000001",
  workspace: "13000000-0000-4000-8000-000000000001",
  session: "14000000-0000-4000-8000-000000000001",
  credential: "15000000-0000-4000-8000-000000000001",
  profile: "16000000-0000-4000-8000-000000000001",
  workspace1: "18000000-0000-4000-8000-000000000001",
  workspace2: "18000000-0000-4000-8000-000000000002",
  version1: "19000000-0000-4000-8000-000000000001",
  version2: "19000000-0000-4000-8000-000000000002",
  workspace3: "18000000-0000-4000-8000-000000000003",
  version3: "19000000-0000-4000-8000-000000000003",
} as const;

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
const objects = new Map<string, Uint8Array>();
let service: WorkspaceVersionService;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seed(): Promise<void> {
  const first = createWorkspaceSnapshot([
    { path: "README.md", executable: false, content: Buffer.from("first\n") },
    { path: "old.txt", executable: false, content: Buffer.from("remove\n") },
  ]);
  const second = createWorkspaceSnapshot([
    { path: "README.md", executable: false, content: Buffer.from("second\n") },
    { path: "bin/run.sh", executable: true, content: Buffer.from("#!/bin/sh\n") },
  ]);
  objects.set("checkpoints/workspace-1", first);
  objects.set("checkpoints/workspace-2", second);
  await database
    .insertInto("tenants")
    .values([
      { id: IDS.tenant, slug: "version-owner" },
      { id: IDS.otherTenant, slug: "version-other" },
    ])
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "pi-cloud-fake",
      kind: "brokered",
      secret_ref: "test://version",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "version-model",
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
    })
    .execute();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: IDS.tenant,
      default_model_profile_id: IDS.profile,
      maximum_projects: 10,
      maximum_sessions: 10,
      maximum_unsettled_turns: 10,
      maximum_concurrent_turns: 2,
    })
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "versions" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
    })
    .execute();
  await database
    .insertInto("workspace_sources")
    .values({
      tenant_id: IDS.tenant,
      workspace_id: IDS.workspace,
      kind: "sample_java",
      repository: null,
      commit_sha: null,
      github_installation_id: null,
      github_repository_id: null,
      status: "ready",
      object_key: null,
      sha256: null,
      size_bytes: null,
      import_lease_id: null,
      lease_expires_at: null,
      failure_code: null,
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
      state: "idle",
      workspace_snapshot_key: "checkpoints/workspace-2",
    })
    .execute();
  await database.insertInto("session_event_cursors").values({ session_id: IDS.session }).execute();
  const artifact = (
    id: string,
    kind: "workspace_snapshot",
    objectKey: string,
    bytes: Uint8Array,
  ) => ({
    id,
    tenant_id: IDS.tenant,
    session_id: IDS.session,
    turn_id: null,
    run_id: null,
    kind,
    object_key: objectKey,
    sha256: hash(bytes),
    size_bytes: bytes.byteLength,
    file_name: "workspace.json",
    media_type: "application/octet-stream",
  });
  await database
    .insertInto("artifacts")
    .values([
      artifact(IDS.workspace1, "workspace_snapshot", "checkpoints/workspace-1", first),
      artifact(IDS.workspace2, "workspace_snapshot", "checkpoints/workspace-2", second),
    ])
    .execute();
  await database
    .insertInto("checkpoint_objects")
    .values([
      {
        object_key: "checkpoints/workspace-1",
        bytes: first,
        sha256: hash(first),
        size_bytes: first.byteLength,
      },
      {
        object_key: "checkpoints/workspace-2",
        bytes: second,
        sha256: hash(second),
        size_bytes: second.byteLength,
      },
    ])
    .execute();
  await database
    .insertInto("workspace_versions")
    .values([
      {
        id: IDS.version1,
        tenant_id: IDS.tenant,
        workspace_id: IDS.workspace,
        session_id: IDS.session,
        version_number: 1,
        parent_version_id: null,
        source_version_id: null,
        origin_kind: "migration",
        run_id: null,
        attempt_id: null,
        turn_id: null,
        workspace_artifact_id: IDS.workspace1,
        patch_artifact_id: null,
        revision: hash(first),
        file_count: 2,
        state: "settled",
        settled_at: new Date("2026-07-20T00:00:00.000Z"),
      },
      {
        id: IDS.version2,
        tenant_id: IDS.tenant,
        workspace_id: IDS.workspace,
        session_id: IDS.session,
        version_number: 2,
        parent_version_id: IDS.version1,
        source_version_id: null,
        origin_kind: "migration",
        run_id: null,
        attempt_id: null,
        turn_id: null,
        workspace_artifact_id: IDS.workspace2,
        patch_artifact_id: null,
        revision: hash(second),
        file_count: 2,
        state: "settled",
        settled_at: new Date("2026-07-20T00:01:00.000Z"),
      },
    ])
    .execute();
  await database
    .updateTable("sessions")
    .set({ current_workspace_version_id: IDS.version2 })
    .where("id", "=", IDS.session)
    .execute();
  await database
    .updateTable("workspaces")
    .set({ current_workspace_version_id: IDS.version2 })
    .where("id", "=", IDS.workspace)
    .execute();
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await seed();
  service = new WorkspaceVersionService({
    database,
    artifactReader: {
      get: async (key) => {
        const bytes = objects.get(key);
        if (bytes === undefined) throw new Error("missing");
        return bytes;
      },
    },
  });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe.sequential("versioned Workspace service", () => {
  it("lists immutable history and exposes tenant-scoped files", async () => {
    await expect(service.list(IDS.tenant, IDS.session)).resolves.toMatchObject({
      currentVersionId: IDS.version2,
      archived: false,
      versions: [{ versionId: IDS.version2 }, { versionId: IDS.version1 }],
    });
    await expect(service.files(IDS.tenant, IDS.version2)).resolves.toMatchObject({
      files: [
        { path: "README.md", executable: false },
        { path: "bin/run.sh", executable: true },
      ],
      truncated: false,
    });
    const firstFilePage = await service.files(IDS.tenant, IDS.version2, undefined, 1);
    expect(firstFilePage).toMatchObject({
      files: [{ path: "README.md" }],
      truncated: true,
      nextCursor: "README.md",
    });
    await expect(
      service.files(IDS.tenant, IDS.version2, firstFilePage.nextCursor, 1),
    ).resolves.toMatchObject({
      files: [{ path: "bin/run.sh" }],
      truncated: false,
    });
    await expect(service.file(IDS.tenant, IDS.version2, "README.md")).resolves.toMatchObject({
      bytes: Buffer.from("second\n"),
    });
    await expect(service.get(IDS.otherTenant, IDS.version2)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("starts a new conversation from the shared Workspace head", async () => {
    const store = new ControlPlaneStore({
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      idGenerator: randomUUID,
    });
    const conversation = await store.createSession(
      IDS.project,
      IDS.workspace,
      "Second conversation",
      "ephemeral",
    );
    const persisted = await database
      .selectFrom("sessions")
      .select(["workspace_snapshot_key", "current_workspace_version_id", "forked_from_session_id"])
      .where("id", "=", conversation.sessionId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      workspace_snapshot_key: "checkpoints/workspace-2",
      current_workspace_version_id: IDS.version2,
      forked_from_session_id: null,
    });
    await expect(service.list(IDS.tenant, conversation.sessionId)).resolves.toMatchObject({
      currentVersionId: IDS.version2,
      versions: [{ versionId: IDS.version2 }, { versionId: IDS.version1 }],
    });
  });

  it("keeps orphaned Workspace checkpoints out of new and existing conversations", async () => {
    const store = new ControlPlaneStore({
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      idGenerator: randomUUID,
    });
    const conversation = await store.createSession(
      IDS.project,
      IDS.workspace,
      "Checkpoint availability",
      "ephemeral",
    );
    const bytes = objects.get("checkpoints/workspace-2")!;
    await database
      .deleteFrom("checkpoint_objects")
      .where("object_key", "=", "checkpoints/workspace-2")
      .executeTakeFirstOrThrow();

    await expect(store.listWorkspaces()).resolves.toEqual({ workspaces: [], truncated: false });
    await expect(
      store.createSession(IDS.project, IDS.workspace, "Unavailable Workspace", "ephemeral"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.acceptTurn(conversation.sessionId, "missing-workspace-checkpoint", {
        prompt: "Do not enqueue this turn.",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Workspace checkpoint is unavailable; create a new Workspace",
    });

    await database
      .insertInto("checkpoint_objects")
      .values({
        object_key: "checkpoints/workspace-2",
        bytes: Buffer.from(bytes),
        sha256: hash(bytes),
        size_bytes: bytes.byteLength,
      })
      .executeTakeFirstOrThrow();
  });

  it("lists persistent Volume revisions without pretending their file bytes are portable", async () => {
    const readme = Buffer.from("provider-native\n");
    const checkpoint = createPersistentVolumeReference({
      volumeId: `adw-${"f".repeat(48)}`,
      volumeRevision: "e".repeat(64),
      activationId: "20000000-0000-4000-8000-000000000001",
      tenantId: IDS.tenant,
      workspaceId: IDS.workspace,
      sourceSessionId: IDS.session,
      bindingSha256: "a".repeat(64),
      fencingToken: 3,
      imageRevision: "development",
      environmentSpecSha256: "b".repeat(64),
      gitBaselineCommit: "c".repeat(40),
      files: [
        {
          path: "README.md",
          executable: false,
          sizeBytes: readme.byteLength,
          sha256: hash(readme),
        },
      ],
      recipeCommands: [],
    });
    objects.set("checkpoints/workspace-3", checkpoint);
    await database
      .insertInto("artifacts")
      .values({
        id: IDS.workspace3,
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        turn_id: null,
        run_id: null,
        kind: "workspace_snapshot",
        object_key: "checkpoints/workspace-3",
        sha256: hash(checkpoint),
        size_bytes: checkpoint.byteLength,
        file_name: "workspace.json",
        media_type: "application/octet-stream",
      })
      .execute();
    await database
      .insertInto("workspace_versions")
      .values({
        id: IDS.version3,
        tenant_id: IDS.tenant,
        workspace_id: IDS.workspace,
        session_id: IDS.session,
        version_number: 3,
        parent_version_id: IDS.version2,
        source_version_id: null,
        origin_kind: "migration",
        run_id: null,
        attempt_id: null,
        turn_id: null,
        workspace_artifact_id: IDS.workspace3,
        patch_artifact_id: null,
        revision: hash(checkpoint),
        file_count: 1,
        state: "settled",
        settled_at: new Date("2026-07-20T00:02:00.000Z"),
      })
      .execute();

    await expect(service.files(IDS.tenant, IDS.version3)).resolves.toMatchObject({
      files: [
        {
          path: "README.md",
          executable: false,
          sizeBytes: readme.byteLength,
          sha256: hash(readme),
        },
      ],
    });
    await expect(service.file(IDS.tenant, IDS.version3, "README.md")).rejects.toMatchObject({
      code: "artifact_unavailable",
      message: "Workspace file content requires a live Provider snapshot reader",
    });

    const materializedRequests: unknown[] = [];
    const materializedService = new WorkspaceVersionService({
      database,
      artifactReader: {
        get: async (key) => {
          const bytes = objects.get(key);
          if (bytes === undefined) throw new Error("missing");
          return bytes;
        },
      },
      providerSnapshotReader: {
        read: async (input) => {
          materializedRequests.push(input);
          return {
            bytes: readme,
            sha256: hash(readme),
            executable: false,
          };
        },
      },
    });
    await expect(
      materializedService.file(IDS.tenant, IDS.version3, "README.md"),
    ).resolves.toMatchObject({
      bytes: readme,
      sha256: hash(readme),
      executable: false,
    });
    expect(materializedRequests).toEqual([
      {
        tenantId: IDS.tenant,
        workspaceId: IDS.workspace,
        snapshot: checkpoint,
        path: "README.md",
      },
    ]);

    const corruptService = new WorkspaceVersionService({
      database,
      artifactReader: {
        get: async (key) => {
          const bytes = objects.get(key);
          if (bytes === undefined) throw new Error("missing");
          return bytes;
        },
      },
      providerSnapshotReader: {
        read: async () => ({
          bytes: Buffer.from("tampered\n"),
          sha256: hash(Buffer.from("tampered\n")),
          executable: false,
        }),
      },
    });
    await expect(corruptService.file(IDS.tenant, IDS.version3, "README.md")).rejects.toMatchObject({
      code: "artifact_corrupt",
    });
  });

  it("archives a conversation idempotently and blocks later turns", async () => {
    await expect(
      service.archive(IDS.tenant, "archive-session", IDS.session, { archived: true }),
    ).resolves.toMatchObject({ kind: "archive" });
    await expect(
      service.archive(IDS.tenant, "archive-session", IDS.session, { archived: true }),
    ).resolves.toMatchObject({ kind: "archive", replayed: true });
    const store = new ControlPlaneStore({
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      idGenerator: randomUUID,
    });
    await expect(
      store.acceptTurn(IDS.session, "archived-turn", { prompt: "must reject" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("detects corrupt trusted artifact bytes", async () => {
    const original = objects.get("checkpoints/workspace-1")!;
    objects.set("checkpoints/workspace-1", Buffer.from("corrupt"));
    await expect(service.files(IDS.tenant, IDS.version1)).rejects.toMatchObject({
      code: "artifact_corrupt",
    });
    objects.set("checkpoints/workspace-1", original);
  });
});
