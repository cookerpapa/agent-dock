import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { GitHubGatewayClient, GitHubGatewayRequest } from "@agent-dock/github-gateway";
import {
  createKopiaWorkspaceCheckpoint,
  createWorkspaceSnapshot,
} from "@agent-dock/workspace-runtime";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  ControlPlaneStore,
  GitHubIntegrationService,
  GitHubWebhookIngestGateway,
  WorkspaceVersionError,
  WorkspaceVersionService,
} from "../src/index.ts";

const IDS = {
  tenant: "11000000-0000-4000-8000-000000000001",
  otherTenant: "11000000-0000-4000-8000-000000000002",
  project: "12000000-0000-4000-8000-000000000001",
  workspace: "13000000-0000-4000-8000-000000000001",
  session: "14000000-0000-4000-8000-000000000001",
  credential: "15000000-0000-4000-8000-000000000001",
  profile: "16000000-0000-4000-8000-000000000001",
  pi1: "17000000-0000-4000-8000-000000000001",
  workspace1: "18000000-0000-4000-8000-000000000001",
  pi2: "17000000-0000-4000-8000-000000000002",
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
  const pi1 = Buffer.from("pi-one\n");
  const pi2 = Buffer.from("pi-two\n");
  objects.set("checkpoints/pi-1", pi1);
  objects.set("checkpoints/workspace-1", first);
  objects.set("checkpoints/pi-2", pi2);
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
      provider: "agent-dock-fake",
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
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
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
    .values({ id: IDS.workspace, tenant_id: IDS.tenant, project_id: IDS.project })
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
      pi_session_snapshot_key: "checkpoints/pi-2",
      workspace_snapshot_key: "checkpoints/workspace-2",
    })
    .execute();
  await database.insertInto("session_event_cursors").values({ session_id: IDS.session }).execute();
  const artifact = (
    id: string,
    kind: "pi_session_snapshot" | "workspace_snapshot",
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
    file_name: kind === "workspace_snapshot" ? "workspace.json" : "pi.jsonl",
    media_type: "application/octet-stream",
  });
  await database
    .insertInto("artifacts")
    .values([
      artifact(IDS.pi1, "pi_session_snapshot", "checkpoints/pi-1", pi1),
      artifact(IDS.workspace1, "workspace_snapshot", "checkpoints/workspace-1", first),
      artifact(IDS.pi2, "pi_session_snapshot", "checkpoints/pi-2", pi2),
      artifact(IDS.workspace2, "workspace_snapshot", "checkpoints/workspace-2", second),
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
        pi_artifact_id: IDS.pi1,
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
        pi_artifact_id: IDS.pi2,
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
  it("lists immutable history and exposes tenant-scoped files, compare and artifacts", async () => {
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
    await expect(service.compare(IDS.tenant, IDS.version1, IDS.version2)).resolves.toMatchObject({
      summary: { added: 1, modified: 1, deleted: 1, modeChanged: 0 },
    });
    await expect(service.artifact(IDS.tenant, IDS.workspace2)).resolves.toMatchObject({
      resource: { artifactId: IDS.workspace2 },
    });
    await expect(service.get(IDS.otherTenant, IDS.version2)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("starts a new conversation from the shared Workspace head without copying Pi history", async () => {
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
    );
    const persisted = await database
      .selectFrom("sessions")
      .select([
        "pi_session_snapshot_key",
        "workspace_snapshot_key",
        "current_workspace_version_id",
        "forked_from_session_id",
      ])
      .where("id", "=", conversation.sessionId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      pi_session_snapshot_key: null,
      workspace_snapshot_key: "checkpoints/workspace-2",
      current_workspace_version_id: IDS.version2,
      forked_from_session_id: null,
    });
    await expect(service.list(IDS.tenant, conversation.sessionId)).resolves.toMatchObject({
      currentVersionId: IDS.version2,
      versions: [{ versionId: IDS.version2 }, { versionId: IDS.version1 }],
    });
  });

  it("lists and compares Kopia versions without pretending their file bytes are portable", async () => {
    const readme = Buffer.from("provider-native\n");
    const checkpoint = createKopiaWorkspaceCheckpoint({
      snapshotId: "kopia-snapshot-version-three",
      volumeId: `adw-${"f".repeat(48)}`,
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
        pi_artifact_id: IDS.pi2,
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
    await expect(service.compare(IDS.tenant, IDS.version2, IDS.version3)).resolves.toMatchObject({
      summary: { added: 0, modified: 1, deleted: 1, modeChanged: 0 },
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

  it("registers an allowlisted GitHub App source and idempotently delivers an immutable version", async () => {
    const requests: GitHubGatewayRequest[] = [];
    const gateway = {
      request: async (request: GitHubGatewayRequest) => {
        requests.push(request);
        if (request.type === "installation.inspect") {
          return {
            type: "installation.inspected" as const,
            requestId: request.requestId,
            installation: {
              installationId: 7,
              accountId: 9,
              accountLogin: "acme",
              targetType: "Organization" as const,
              repositorySelection: "selected" as const,
              suspended: false,
              permissions: { contents: "write", pull_requests: "write", checks: "write" },
              repositories: [
                {
                  repositoryId: 42,
                  installationId: 7,
                  fullName: "acme/private-repo",
                  ownerLogin: "acme",
                  name: "private-repo",
                  private: true,
                  defaultBranch: "main",
                },
              ],
            },
          };
        }
        if (request.type === "pull_request.deliver") {
          return {
            type: "pull_request.delivered" as const,
            requestId: request.requestId,
            deliveryId: request.deliveryId,
            commitSha: "b".repeat(40),
            pullRequestNumber: 12,
            pullRequestUrl: "https://github.com/acme/private-repo/pull/12",
            checkRunId: 99,
          };
        }
        throw new Error("unexpected request");
      },
    } as GitHubGatewayClient;
    const integration = new GitHubIntegrationService({
      database,
      gateway,
      workspaceVersions: service,
    });
    await expect(integration.registerInstallation(IDS.tenant, 7)).resolves.toMatchObject({
      installationId: 7,
      repositories: [{ repositoryId: 42, enabled: true }],
    });
    await database
      .updateTable("workspace_sources")
      .set({
        kind: "github_app",
        repository: "acme/private-repo",
        commit_sha: "a".repeat(40),
        github_installation_id: 7,
        github_repository_id: 42,
        status: "pending",
      })
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .executeTakeFirstOrThrow();
    const request = {
      repositoryId: 42,
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
      headBranch: "agent/version-two",
      title: "Deliver version two",
      body: "Immutable AgentDock checkpoint",
    };
    await expect(
      integration.deliverPullRequest(IDS.tenant, IDS.version2, "deliver-version-two", request),
    ).resolves.toMatchObject({
      state: "completed",
      commitSha: "b".repeat(40),
      pullRequestNumber: 12,
      replayed: false,
    });
    await expect(
      integration.deliverPullRequest(IDS.tenant, IDS.version2, "deliver-version-two", request),
    ).resolves.toMatchObject({ state: "completed", replayed: true });
    expect(requests.filter((entry) => entry.type === "pull_request.deliver")).toHaveLength(1);
  });

  it("forks idempotently, rolls back with CAS, archives, and blocks archived turns", async () => {
    const fork = await service.fork(IDS.tenant, "fork-version-one", IDS.session, {
      versionId: IDS.version1,
    });
    expect(fork.forkedSessionId).toBeDefined();
    await expect(
      service.fork(IDS.tenant, "fork-version-one", IDS.session, { versionId: IDS.version1 }),
    ).resolves.toMatchObject({ replayed: true, forkedSessionId: fork.forkedSessionId });
    await expect(
      service.rollback(IDS.tenant, "rollback-version-one", IDS.session, {
        versionId: IDS.version1,
        expectedCurrentVersionId: IDS.version2,
      }),
    ).resolves.toMatchObject({ versionId: IDS.version1, replayed: false });
    await expect(
      service.rollback(IDS.tenant, "stale-rollback", IDS.session, {
        versionId: IDS.version2,
        expectedCurrentVersionId: IDS.version2,
      }),
    ).rejects.toBeInstanceOf(WorkspaceVersionError);
    await expect(
      service.archive(IDS.tenant, "archive-session", IDS.session, { archived: true }),
    ).resolves.toMatchObject({ kind: "archive" });
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

  it("authenticates, deduplicates, and applies normalized GitHub webhook events", async () => {
    const token = "g".repeat(64);
    const gateway = new GitHubWebhookIngestGateway({ database, serviceToken: token });
    const server = Fastify({ logger: false });
    gateway.install(server);
    try {
      const event = {
        deliveryId: "github-delivery-one",
        eventName: "repository",
        action: "deleted",
        installationId: 7,
        repositoryId: 42,
        repositoryFullName: "acme/private-repo",
        payloadSha256: "a".repeat(64),
      };
      await expect(
        server.inject({
          method: "POST",
          url: "/internal/v1/github/webhook-events",
          payload: event,
        }),
      ).resolves.toMatchObject({ statusCode: 401 });
      const accepted = await server.inject({
        method: "POST",
        url: "/internal/v1/github/webhook-events",
        headers: { authorization: `Bearer ${token}` },
        payload: event,
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ replayed: false, status: "processed" });
      await expect(
        database
          .selectFrom("github_repositories")
          .select("enabled")
          .where("tenant_id", "=", IDS.tenant)
          .where("repository_id", "=", "42")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ enabled: false });
      const replay = await server.inject({
        method: "POST",
        url: "/internal/v1/github/webhook-events",
        headers: { authorization: `Bearer ${token}` },
        payload: event,
      });
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({ replayed: true, status: "processed" });
      const conflict = await server.inject({
        method: "POST",
        url: "/internal/v1/github/webhook-events",
        headers: { authorization: `Bearer ${token}` },
        payload: { ...event, payloadSha256: "b".repeat(64) },
      });
      expect(conflict.statusCode).toBe(409);
    } finally {
      await server.close();
    }
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
