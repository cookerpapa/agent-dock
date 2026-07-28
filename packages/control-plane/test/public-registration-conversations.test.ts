import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type {
  AcceptedTurnResource,
  ConversationDetailResource,
  ConversationListResource,
  ProjectResource,
  SessionResource,
  TenantRegistrationResource,
  WorkspaceListResource,
} from "@agent-dock/protocol";
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
      maximumSessions: 4,
      maximumUnsettledTurns: 2,
      maximumConcurrentTurns: 1,
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
    expect(alpha.apiToken).toMatch(/^adk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43,}$/i);
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
    expect(invalid.body).not.toContain("adk_");
    expect(duplicate.body).not.toContain("adk_");
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
    expect(createAlphaTurn.statusCode).toBe(202);
    alphaTurn = createAlphaTurn.json<AcceptedTurnResource>();

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
    expect(rejected.body).not.toContain("adk_");
    const count = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("4");
  });
});
