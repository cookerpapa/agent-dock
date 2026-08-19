import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type {
  AcceptedTurnResource,
  ConversationDetailResource,
  ConversationListResource,
  ConversationPruneResource,
  ConversationTreeResource,
  ConversationForkResource,
  ProjectResource,
  SessionResource,
  TenantRegistrationResource,
  WorkspaceListResource,
  WorkspaceDeletionResource,
} from "@pi-cloud/protocol";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
  createControlPlaneApplication,
  createPrivateTenant,
  issuePrivateTenantCredential,
} from "../src/index.ts";

const NOW = new Date("2026-07-19T14:00:00.000Z");

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let application: NestFastifyApplication;
let http: FastifyInstance;
let alpha: TenantRegistrationResource;
let bravo: TenantRegistrationResource;
let alphaProject: ProjectResource;
let alphaSession: SessionResource;
let alphaTurn: AcceptedTurnResource;
let bravoSession: SessionResource;

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function register(tenantSlug: string, displayName: string) {
  return http.inject({
    method: "POST",
    url: "/v1/registrations",
    payload: { tenantSlug, displayName },
  });
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await createPrivateTenant(database, {
    slug: "operator-bootstrap",
    ownerDisplayName: "Operator",
    clock: () => NOW,
  });
  const publicRegistration = {
    enabled: true,
    maximumTenants: 4,
    tenantQuotas: {
      maximumProjects: 2,
      maximumSessions: 8,
      maximumUnsettledTurns: 2,
      maximumConcurrentTurns: 1,
      maximumActiveSandboxes: 1,
    },
    clock: () => NOW,
  } as const;
  application = await createControlPlaneApplication({
    database,
    publicRegistration,
    productionHttpGateway: new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database, clock: () => NOW }),
      readiness: () => true,
      publicRegistrationEnabled: true,
    }),
    sessionEventStreamOptions: { heartbeatIntervalMs: 20 },
  });
  await application.listen(0, "127.0.0.1");
  http = application.getHttpAdapter().getInstance() as FastifyInstance;
}, 30_000);

afterAll(async () => {
  await application?.close();
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("opt-in registration and tenant conversation discovery", () => {
  it("creates two complete owner identities without authentication or plaintext persistence", async () => {
    const alphaResponse = await register(" Public-Alpha ", " Alpha Owner ");
    expect(alphaResponse.statusCode).toBe(201);
    alpha = alphaResponse.json<TenantRegistrationResource>();
    expect(alpha).toMatchObject({
      tenantSlug: "public-alpha",
      displayName: "Alpha Owner",
      role: "owner",
    });
    expect(alpha.apiToken).toMatch(/^pck_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43,}$/i);
    expect(alphaResponse.body).not.toContain("secretSha256");

    const bravoResponse = await register("public-bravo", "Bravo Owner");
    expect(bravoResponse.statusCode).toBe(201);
    bravo = bravoResponse.json<TenantRegistrationResource>();
    expect(bravo.tenantId).not.toBe(alpha.tenantId);
    expect(bravo.apiToken).not.toBe(alpha.apiToken);

    const persisted = await database
      .selectFrom("tenant_api_credentials")
      .select(["credential_id", "secret_sha256"])
      .where("tenant_id", "in", [alpha.tenantId, bravo.tenantId])
      .execute();
    expect(persisted).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain(alpha.apiToken);
    expect(JSON.stringify(persisted)).not.toContain(bravo.apiToken);

    for (const registration of [alpha, bravo]) {
      const identity = await http.inject({
        method: "GET",
        url: "/v1/identity",
        headers: authorization(registration.apiToken),
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({
        tenantId: registration.tenantId,
        userId: registration.userId,
        role: "owner",
      });
    }
  });

  it("normalizes validation failures and duplicate slugs without partial rows", async () => {
    const before = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const invalid = await register("bad slug", "Owner");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    const duplicate = await register("PUBLIC-ALPHA", "Duplicate Owner");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: { code: "tenant_slug_unavailable", message: "Tenant slug is unavailable" },
    });
    const after = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
    expect(invalid.body).not.toContain("pck_");
    expect(duplicate.body).not.toContain("pck_");
  });

  it("lists and loads only conversations owned by the authenticated tenant", async () => {
    const createAlphaProject = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(alpha.apiToken),
      payload: { name: "Alpha private repair" },
    });
    expect(createAlphaProject.statusCode).toBe(201);
    alphaProject = createAlphaProject.json<ProjectResource>();
    const createAlphaSession = await http.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: { workspaceId: alphaProject.workspaceId, title: "Test conversation" },
    });
    expect(createAlphaSession.statusCode).toBe(201);
    alphaSession = createAlphaSession.json<SessionResource>();
    const createAlphaTurn = await http.inject({
      method: "POST",
      url: `/v1/sessions/${alphaSession.sessionId}/turns`,
      headers: { ...authorization(alpha.apiToken), "idempotency-key": "alpha-conversation" },
      payload: { prompt: "alpha private prompt" },
    });
    expect(createAlphaTurn.statusCode, createAlphaTurn.body).toBe(202);
    alphaTurn = createAlphaTurn.json<AcceptedTurnResource>();
    const acceptedToolSnapshot = await database
      .selectFrom("runs as run")
      .innerJoin("sessions as session", (join) =>
        join
          .onRef("session.tenant_id", "=", "run.tenant_id")
          .onRef("session.id", "=", "run.session_id"),
      )
      .select([
        "session.tool_capabilities as sessionTools",
        "run.tool_capability_snapshot as runTools",
      ])
      .where("run.id", "=", alphaTurn.runId)
      .executeTakeFirstOrThrow();
    expect(acceptedToolSnapshot).toEqual({
      sessionTools: ["read", "write", "edit", "bash"],
      runTools: ["read", "write", "edit", "bash"],
    });

    const bravoProjectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(bravo.apiToken),
      payload: { name: "Bravo private repair" },
    });
    expect(bravoProjectResponse.statusCode).toBe(201);
    const bravoProject = bravoProjectResponse.json<ProjectResource>();
    const bravoSessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${bravoProject.projectId}/sessions`,
      headers: authorization(bravo.apiToken),
      payload: { workspaceId: bravoProject.workspaceId, title: "Test conversation" },
    });
    expect(bravoSessionResponse.statusCode).toBe(201);
    bravoSession = bravoSessionResponse.json<SessionResource>();
    expect(
      (
        await http.inject({
          method: "POST",
          url: `/v1/sessions/${bravoSession.sessionId}/turns`,
          headers: {
            ...authorization(bravo.apiToken),
            "idempotency-key": "bravo-conversation",
          },
          payload: { prompt: "bravo private prompt" },
        })
      ).statusCode,
    ).toBe(202);

    const [alphaListResponse, bravoListResponse] = await Promise.all([
      http.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: authorization(alpha.apiToken),
      }),
      http.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: authorization(bravo.apiToken),
      }),
    ]);
    expect(alphaListResponse.statusCode).toBe(200);
    expect(bravoListResponse.statusCode).toBe(200);
    const alphaList = alphaListResponse.json<ConversationListResource>();
    const bravoList = bravoListResponse.json<ConversationListResource>();
    expect(alphaList).toMatchObject({
      truncated: false,
      conversations: [{ sessionId: alphaSession.sessionId, turnCount: 1 }],
    });
    expect(bravoList).toMatchObject({
      truncated: false,
      conversations: [{ sessionId: bravoSession.sessionId, turnCount: 1 }],
    });
    expect(alphaListResponse.body).not.toContain(bravoSession.sessionId);
    expect(bravoListResponse.body).not.toContain(alphaSession.sessionId);

    const alphaDetailResponse = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(alphaDetailResponse.statusCode).toBe(200);
    expect(alphaDetailResponse.json<ConversationDetailResource>()).toMatchObject({
      project: {
        projectId: alphaProject.projectId,
        source: { kind: "empty", status: "ready" },
      },
      session: { sessionId: alphaSession.sessionId, state: "cold" },
      turns: [
        {
          turnId: alphaTurn.turnId,
          commandId: alphaTurn.commandId,
          mailboxPosition: 1,
          prompt: "alpha private prompt",
          state: "queued",
        },
      ],
      historyTruncated: false,
      replayAfterSequence: 0,
    });

    const foreignDetail = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignDetail.statusCode).toBe(404);
    expect(foreignDetail.json()).toMatchObject({ error: { code: "not_found" } });
    expect(foreignDetail.body).not.toContain("alpha private prompt");
    const foreignEvents = await http.inject({
      method: "GET",
      url: `/v1/sessions/${alphaSession.sessionId}/events`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignEvents.statusCode).toBe(404);
    expect(
      (
        await http.inject({
          method: "GET",
          url: "/v1/conversations",
        })
      ).statusCode,
    ).toBe(401);
  });

  it("allows a viewer to read its conversation without granting mutation", async () => {
    const viewerToken = (
      await issuePrivateTenantCredential(database, {
        tenant: alpha.tenantId,
        userId: alpha.userId,
        label: "browser viewer",
        role: "viewer",
        clock: () => NOW,
      })
    ).token;
    expect(
      (
        await http.inject({
          method: "GET",
          url: `/v1/conversations/${alphaSession.sessionId}`,
          headers: authorization(viewerToken),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await http.inject({
          method: "POST",
          url: "/v1/projects",
          headers: authorization(viewerToken),
          payload: { name: "viewer denied" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("reuses one Workspace across named conversations and deletes only the selected conversation", async () => {
    const secondSessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: alphaProject.workspaceId,
        title: "Follow-up in the same workspace",
      },
    });
    expect(secondSessionResponse.statusCode).toBe(201);
    const secondSession = secondSessionResponse.json<SessionResource>();

    const workspacesResponse = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceListResource>()).toMatchObject({
      truncated: false,
      workspaces: [
        {
          workspaceId: alphaProject.workspaceId,
          projectId: alphaProject.projectId,
          name: "Alpha private repair",
          sessionCount: 2,
        },
      ],
    });

    const deleted = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${secondSession.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "delete-alpha-follow-up",
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (
        await http.inject({
          method: "GET",
          url: `/v1/conversations/${secondSession.sessionId}`,
          headers: authorization(alpha.apiToken),
        })
      ).statusCode,
    ).toBe(404);

    const remaining = await http.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: authorization(alpha.apiToken),
    });
    expect(remaining.json<ConversationListResource>().conversations).toEqual([
      expect.objectContaining({
        sessionId: alphaSession.sessionId,
        title: "Test conversation",
        workspaceName: "Alpha private repair",
      }),
    ]);
    const workspacesAfterDelete = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(workspacesAfterDelete.json<WorkspaceListResource>().workspaces[0]).toMatchObject({
      workspaceId: alphaProject.workspaceId,
      sessionCount: 1,
    });
  });

  it("persists the Sandbox retention policy and reserves a Workspace for its persistent conversation", async () => {
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(alpha.apiToken),
      payload: { name: "Persistent devbox" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<ProjectResource>();

    const persistentResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: project.workspaceId,
        title: "Long-running development environment",
        sandboxRetention: "persistent",
      },
    });
    expect(persistentResponse.statusCode).toBe(201);
    const persistent = persistentResponse.json<SessionResource>();
    expect(persistent.sandboxRetention).toBe("persistent");

    const detail = await http.inject({
      method: "GET",
      url: `/v1/conversations/${persistent.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<ConversationDetailResource>().session.sandboxRetention).toBe("persistent");

    const conflicting = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: project.workspaceId,
        title: "Conflicting conversation",
        sandboxRetention: "ephemeral",
      },
    });
    expect(conflicting.statusCode).toBe(409);

    const archived = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${persistent.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "archive-persistent-devbox",
      },
    });
    expect(archived.statusCode).toBe(200);

    const replacement = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: project.workspaceId,
        title: "Replacement conversation",
        sandboxRetention: "ephemeral",
      },
    });
    expect(replacement.statusCode).toBe(201);
    const replacementSession = replacement.json<SessionResource>();
    expect(replacementSession.sandboxRetention).toBe("ephemeral");

    const blockedDeletion = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "delete-live-persistent-workspace",
      },
    });
    expect(blockedDeletion.statusCode).toBe(409);
    expect(blockedDeletion.json()).toMatchObject({ error: { code: "conflict" } });

    const foreignDeletion = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: {
        ...authorization(bravo.apiToken),
        "idempotency-key": "delete-foreign-workspace",
      },
    });
    expect(foreignDeletion.statusCode).toBe(404);

    const archiveReplacement = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${replacementSession.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "archive-replacement-devbox",
      },
    });
    expect(archiveReplacement.statusCode).toBe(200);

    const deletionHeaders = {
      ...authorization(alpha.apiToken),
      "idempotency-key": "delete-persistent-workspace",
    };
    const deletedWorkspace = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: deletionHeaders,
    });
    expect(deletedWorkspace.statusCode).toBe(200);
    const deletion = deletedWorkspace.json<WorkspaceDeletionResource>();
    expect(deletion).toMatchObject({
      workspaceId: project.workspaceId,
      storageState: "pending",
      replayed: false,
    });
    const replay = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: deletionHeaders,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<WorkspaceDeletionResource>()).toMatchObject({
      operationId: deletion.operationId,
      workspaceId: project.workspaceId,
      replayed: true,
    });

    const visibleWorkspaces = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(
      visibleWorkspaces
        .json<WorkspaceListResource>()
        .workspaces.some((workspace) => workspace.workspaceId === project.workspaceId),
    ).toBe(false);
    expect(
      (
        await http.inject({
          method: "POST",
          url: `/v1/projects/${project.projectId}/sessions`,
          headers: authorization(alpha.apiToken),
          payload: { workspaceId: project.workspaceId, title: "Cannot restore deleted files" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("forks a settled Pi branch transactionally and renders inherited history", async () => {
    const userEntryId = "10000000-0000-4000-8000-000000000001";
    const assistantEntryId = "10000000-0000-4000-8000-000000000002";
    const transcript = {
      schemaVersion: 1,
      throughSequence: 1,
      items: [
        {
          kind: "text",
          text: "alpha final answer",
          firstSequence: 1,
          lastSequence: 1,
        },
      ],
      startedSequence: 1,
      terminalSequence: 1,
      stopReason: "stop",
      failure: null,
      cancellation: null,
      workspacePatch: null,
    };
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("commands")
        .set({ state: "completed" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaTurn.commandId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaTurn.turnId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaTurn.runId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaSession.sessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("conversation_turn_projections")
        .values({
          tenant_id: alpha.tenantId,
          session_id: alphaSession.sessionId,
          turn_id: alphaTurn.turnId,
          schema_version: 1,
          through_seq: 1,
          source_event_count: 1,
          transcript,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("pi_sessions")
        .values({
          tenant_id: alpha.tenantId,
          id: alphaSession.sessionId,
          created_at_ms: NOW.valueOf(),
          parent_session_id: null,
          next_seq: 3,
          name: "Test conversation",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("pi_session_entries")
        .values([
          {
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            id: userEntryId,
            seq: 1,
            parent_id: null,
            type: "message",
            custom_type: null,
            timestamp_ms: NOW.valueOf(),
            payload: {
              id: userEntryId,
              type: "message",
              message: { role: "user", content: "alpha private prompt", timestamp: NOW.valueOf() },
            },
          },
          {
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            id: assistantEntryId,
            seq: 2,
            parent_id: userEntryId,
            type: "message",
            custom_type: null,
            timestamp_ms: NOW.valueOf() + 1,
            payload: {
              id: assistantEntryId,
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "alpha final answer" }],
                provider: "test",
                model: "test",
                api: "test",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: NOW.valueOf() + 1,
              },
            },
          },
        ])
        .execute();
      await transaction
        .insertInto("pi_session_lanes")
        .values({
          tenant_id: alpha.tenantId,
          session_id: alphaSession.sessionId,
          lane: "main",
          leaf_id: assistantEntryId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("pi_session_log")
        .values([
          {
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            seq: 1,
            kind: "entry",
            payload: { entry: { id: userEntryId, type: "message" } },
          },
          {
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            seq: 2,
            kind: "entry",
            payload: { entry: { id: assistantEntryId, type: "message" } },
          },
        ])
        .execute();
    });

    const beforeFork = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(beforeFork.statusCode).toBe(200);
    expect(beforeFork.json<ConversationTreeResource>()).toMatchObject({
      rootSessionId: alphaSession.sessionId,
      currentSessionId: alphaSession.sessionId,
      view: "full",
      branches: [
        {
          sessionId: alphaSession.sessionId,
          current: true,
          entries: [
            { role: "user", turnId: alphaTurn.turnId },
            {
              role: "assistant",
              turnId: alphaTurn.turnId,
              entryId: assistantEntryId,
              finalAssistant: true,
            },
          ],
        },
      ],
    });

    const forkRequest = {
      method: "POST" as const,
      url: `/v1/conversations/${alphaSession.sessionId}/forks`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "fork-alpha-final",
      },
      payload: {
        turnId: alphaTurn.turnId,
        entryId: assistantEntryId,
        title: "Alternative alpha branch",
      },
    };
    const forkResponse = await http.inject(forkRequest);
    expect(forkResponse.statusCode).toBe(201);
    const forked = forkResponse.json<ConversationForkResource>();
    expect(forked).toMatchObject({
      parentSessionId: alphaSession.sessionId,
      forkedFromTurnId: alphaTurn.turnId,
      forkedFromEntryId: assistantEntryId,
      replayed: false,
      session: {
        title: "Alternative alpha branch",
        workspaceId: alphaProject.workspaceId,
      },
    });
    const replay = await http.inject(forkRequest);
    expect(replay.statusCode).toBe(201);
    expect(replay.json<ConversationForkResource>()).toMatchObject({
      replayed: true,
      session: { sessionId: forked.session.sessionId },
    });

    const childDetail = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(childDetail.statusCode).toBe(200);
    expect(childDetail.json<ConversationDetailResource>()).toMatchObject({
      session: {
        sessionId: forked.session.sessionId,
        parentSessionId: alphaSession.sessionId,
      },
      turns: [{ turnId: alphaTurn.turnId, originSessionId: alphaSession.sessionId }],
    });
    const fullTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(fullTree.json<ConversationTreeResource>().branches).toEqual([
      expect.objectContaining({ sessionId: alphaSession.sessionId, current: false }),
      expect.objectContaining({
        sessionId: forked.session.sessionId,
        parentSessionId: alphaSession.sessionId,
        forkedFromEntryId: assistantEntryId,
        current: true,
      }),
    ]);
    const copiedEntries = await database
      .selectFrom("pi_session_entries")
      .select("id")
      .where("tenant_id", "=", alpha.tenantId)
      .where("session_id", "=", forked.session.sessionId)
      .orderBy("seq")
      .execute();
    expect(copiedEntries.map((entry) => entry.id)).toEqual([userEntryId, assistantEntryId]);
    expect(
      await database
        .selectFrom("pi_session_log")
        .select(["seq", "kind"])
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", forked.session.sessionId)
        .orderBy("seq")
        .execute(),
    ).toEqual([
      { seq: "1", kind: "entry" },
      { seq: "2", kind: "entry" },
      { seq: "3", kind: "lane" },
      { seq: "4", kind: "fact" },
    ]);
    expect(
      await database
        .selectFrom("pi_session_records")
        .select("id")
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", forked.session.sessionId)
        .execute(),
    ).toEqual([]);

    const foreignTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}/tree`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignTree.statusCode).toBe(404);

    const laterTurnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${alphaSession.sessionId}/turns`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "alpha-later-turn",
      },
      payload: { prompt: "later branch that should be pruned" },
    });
    expect(laterTurnResponse.statusCode).toBe(202);
    const laterTurn = laterTurnResponse.json<AcceptedTurnResource>();
    const laterUserEntryId = "10000000-0000-4000-8000-000000000003";
    const laterAssistantEntryId = "10000000-0000-4000-8000-000000000004";
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("commands")
        .set({ state: "completed" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", laterTurn.commandId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", laterTurn.turnId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", laterTurn.runId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaSession.sessionId)
        .executeTakeFirstOrThrow();
      const laterEntries = [
        {
          id: laterUserEntryId,
          seq: 3,
          parentId: assistantEntryId,
          timestamp: NOW.valueOf() + 2,
          message: {
            role: "user",
            content: "later branch that should be pruned",
            timestamp: NOW.valueOf() + 2,
          },
        },
        {
          id: laterAssistantEntryId,
          seq: 4,
          parentId: laterUserEntryId,
          timestamp: NOW.valueOf() + 3,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "later answer" }],
            provider: "test",
            model: "test",
            api: "test",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: NOW.valueOf() + 3,
          },
        },
      ];
      await transaction
        .insertInto("pi_session_entries")
        .values(
          laterEntries.map((entry) => ({
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            id: entry.id,
            seq: entry.seq,
            parent_id: entry.parentId,
            type: "message",
            custom_type: null,
            timestamp_ms: entry.timestamp,
            payload: {
              id: entry.id,
              seq: entry.seq,
              type: "message",
              parentId: entry.parentId,
              timestamp: entry.timestamp,
              message: entry.message,
            },
          })),
        )
        .execute();
      await transaction
        .insertInto("pi_session_log")
        .values(
          laterEntries.map((entry) => ({
            tenant_id: alpha.tenantId,
            session_id: alphaSession.sessionId,
            seq: entry.seq,
            kind: "entry",
            payload: { entry: { id: entry.id, type: "message" } },
          })),
        )
        .execute();
      await transaction
        .updateTable("pi_session_lanes")
        .set({ leaf_id: laterAssistantEntryId })
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", alphaSession.sessionId)
        .where("lane", "=", "main")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("pi_sessions")
        .set({ next_seq: 5 })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaSession.sessionId)
        .executeTakeFirstOrThrow();
    });

    const pruneRequest = {
      method: "POST" as const,
      url: `/v1/conversations/${alphaSession.sessionId}/prunes`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "prune-alpha-after-first-answer",
      },
      payload: { turnId: alphaTurn.turnId, entryId: assistantEntryId },
    };
    const prunedResponse = await http.inject(pruneRequest);
    expect(prunedResponse.statusCode).toBe(201);
    expect(prunedResponse.json<ConversationPruneResource>()).toMatchObject({
      anchorTurnId: alphaTurn.turnId,
      anchorEntryId: assistantEntryId,
      prunedTurnCount: 1,
      archivedSessionCount: 1,
      replayed: false,
    });
    expect((await http.inject(pruneRequest)).json<ConversationPruneResource>()).toMatchObject({
      replayed: true,
    });
    expect(
      await database
        .selectFrom("turns")
        .select("pruned_at as prunedAt")
        .where("id", "=", laterTurn.turnId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ prunedAt: expect.anything() });
    expect(
      await database
        .selectFrom("pi_session_lanes")
        .select("leaf_id as leafId")
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", alphaSession.sessionId)
        .where("lane", "=", "main")
        .executeTakeFirstOrThrow(),
    ).toEqual({ leafId: assistantEntryId });
    expect(
      await database
        .selectFrom("sessions")
        .select("archived_at as archivedAt")
        .where("id", "=", forked.session.sessionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ archivedAt: expect.anything() });
    const afterPruneTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(afterPruneTree.json<ConversationTreeResource>()).toMatchObject({
      branches: [
        {
          sessionId: alphaSession.sessionId,
          entries: [
            { turnId: alphaTurn.turnId, role: "user" },
            { turnId: alphaTurn.turnId, role: "assistant" },
          ],
        },
      ],
    });

    const replacementFork = await http.inject({
      ...forkRequest,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "fork-alpha-before-subtree-delete",
      },
      payload: {
        turnId: alphaTurn.turnId,
        entryId: assistantEntryId,
        title: "Child removed with parent",
      },
    });
    expect(replacementFork.statusCode).toBe(201);
    const replacementChildId = replacementFork.json<ConversationForkResource>().session.sessionId;
    const deletedTree = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "delete-alpha-conversation-tree",
      },
    });
    expect(deletedTree.statusCode).toBe(200);
    expect(
      await database
        .selectFrom("sessions")
        .select(["id", "archived_at as archivedAt"])
        .where("id", "in", [alphaSession.sessionId, replacementChildId])
        .orderBy("id")
        .execute(),
    ).toEqual([
      expect.objectContaining({ archivedAt: expect.anything() }),
      expect.objectContaining({ archivedAt: expect.anything() }),
    ]);
  });

  it("serializes concurrent registration at the configured total-tenant cap", async () => {
    const results = await Promise.all([
      register("capacity-charlie", "Charlie"),
      register("capacity-delta", "Delta"),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 429]);
    const rejected = results.find((response) => response.statusCode === 429)!;
    expect(rejected.json()).toEqual({
      error: {
        code: "registration_capacity_reached",
        message: "Self-service tenant registration capacity has been reached",
      },
    });
    expect(rejected.body).not.toContain("pck_");
    const count = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("4");
  });
});
