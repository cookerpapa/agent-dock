import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type {
  AcceptedTurnResource,
  ProjectResource,
  SessionResource,
  TenantIdentityResource,
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
  generateTenantApiCredential,
  issuePrivateTenantCredential,
  revokePrivateTenantCredential,
  type CreatedPrivateTenant,
} from "../src/index.ts";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const TENANT_A_IDS = [
  "a1000000-0000-4000-8000-000000000001",
  "a1000000-0000-4000-8000-000000000002",
  "a1000000-0000-4000-8000-000000000003",
  "a1000000-0000-4000-8000-000000000004",
  "a1000000-0000-4000-8000-000000000005",
] as const;
const TENANT_B_IDS = [
  "b1000000-0000-4000-8000-000000000001",
  "b1000000-0000-4000-8000-000000000002",
  "b1000000-0000-4000-8000-000000000003",
  "b1000000-0000-4000-8000-000000000004",
  "b1000000-0000-4000-8000-000000000005",
] as const;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let application: NestFastifyApplication;
let http: FastifyInstance;
let tenantA: CreatedPrivateTenant;
let tenantB: CreatedPrivateTenant;
let memberAToken: string;
let viewerAToken: string;
let projectA: ProjectResource;
let sessionA: SessionResource;
let turnA: AcceptedTurnResource;

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test UUID sequence was exhausted");
    index += 1;
    return value;
  };
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
  tenantA = await createPrivateTenant(database, {
    slug: "tenant-alpha",
    ownerDisplayName: "Alpha Owner",
    quotas: {
      maximumProjects: 1,
      maximumSessions: 2,
      maximumUnsettledTurns: 1,
      maximumConcurrentTurns: 1,
    },
    idGenerator: sequence(TENANT_A_IDS),
    randomSecret: () => "a".repeat(43),
    clock: () => NOW,
  });
  tenantB = await createPrivateTenant(database, {
    slug: "tenant-bravo",
    ownerDisplayName: "Bravo Owner",
    idGenerator: sequence(TENANT_B_IDS),
    randomSecret: () => "b".repeat(43),
    clock: () => NOW,
  });
  memberAToken = (
    await issuePrivateTenantCredential(database, {
      tenant: tenantA.tenantId,
      userId: tenantA.ownerUserId,
      label: "alpha member",
      role: "member",
      credentialId: "a1000000-0000-4000-8000-000000000006",
      randomSecret: () => "m".repeat(43),
      clock: () => NOW,
    })
  ).token;
  viewerAToken = (
    await issuePrivateTenantCredential(database, {
      tenant: tenantA.tenantId,
      userId: tenantA.ownerUserId,
      label: "alpha viewer",
      role: "viewer",
      credentialId: "a1000000-0000-4000-8000-000000000007",
      randomSecret: () => "v".repeat(43),
      clock: () => NOW,
    })
  ).token;

  application = await createControlPlaneApplication({
    database,
    productionHttpGateway: new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database, clock: () => NOW }),
      readiness: () => true,
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

describe.sequential("private multi-tenant HTTP boundary", () => {
  it("resolves bearer credentials to exact tenant identities with uniform authentication failure", async () => {
    const alpha = await http.inject({
      method: "GET",
      url: "/v1/identity",
      headers: authorization(memberAToken),
    });
    expect(alpha.statusCode).toBe(200);
    expect(alpha.json<TenantIdentityResource>()).toEqual({
      tenantId: tenantA.tenantId,
      tenantSlug: "tenant-alpha",
      userId: tenantA.ownerUserId,
      displayName: "Alpha Owner",
      role: "member",
      platformAdministrator: false,
    });
    const bravo = await http.inject({
      method: "GET",
      url: "/v1/identity",
      headers: authorization(tenantB.credential.token),
    });
    expect(bravo.statusCode).toBe(200);
    expect(bravo.json<TenantIdentityResource>()).toMatchObject({
      tenantId: tenantB.tenantId,
      tenantSlug: "tenant-bravo",
      role: "owner",
    });

    const failures = await Promise.all([
      http.inject({ method: "GET", url: "/v1/identity" }),
      http.inject({
        method: "GET",
        url: "/v1/identity",
        headers: { authorization: "Bearer short" },
      }),
      http.inject({
        method: "GET",
        url: "/v1/identity",
        headers: authorization(
          generateTenantApiCredential("c1000000-0000-4000-8000-000000000001", "u".repeat(43)).token,
        ),
      }),
    ]);
    for (const response of failures) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: "authentication_required",
          message: "A valid AgentDock login session or API credential is required",
        },
      });
      expect(response.body).not.toContain("sha256");
      expect(response.body).not.toContain("adk_");
    }
  });

  it("allows member and owner mutations while hiding every foreign UUID behind 404", async () => {
    const viewerMutation = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(viewerAToken),
      payload: { name: "viewer-denied" },
    });
    expect(viewerMutation.statusCode).toBe(403);
    expect(viewerMutation.json()).toMatchObject({
      error: { code: "authorization_denied" },
    });

    const alphaProject = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(memberAToken),
      payload: { name: "same-private-name" },
    });
    expect(alphaProject.statusCode).toBe(201);
    projectA = alphaProject.json<ProjectResource>();
    const bravoProject = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(tenantB.credential.token),
      payload: { name: "same-private-name" },
    });
    expect(bravoProject.statusCode).toBe(201);
    expect(bravoProject.json<ProjectResource>().projectId).not.toBe(projectA.projectId);

    const alphaSession = await http.inject({
      method: "POST",
      url: `/v1/projects/${projectA.projectId}/sessions`,
      headers: authorization(memberAToken),
      payload: { workspaceId: projectA.workspaceId, title: "Test conversation" },
    });
    expect(alphaSession.statusCode).toBe(201);
    sessionA = alphaSession.json<SessionResource>();
    const alphaTurn = await http.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.sessionId}/turns`,
      headers: {
        ...authorization(memberAToken),
        "idempotency-key": "alpha-private-turn",
      },
      payload: { prompt: "tenant-private prompt" },
    });
    expect(alphaTurn.statusCode).toBe(202);
    turnA = alphaTurn.json<AcceptedTurnResource>();

    const viewerRewind = await http.inject({
      method: "POST",
      url: `/v1/runs/${turnA.runId}/rewinds`,
      headers: {
        ...authorization(viewerAToken),
        "idempotency-key": "viewer-rewind-denied",
      },
      payload: { sourceAttemptId: TENANT_A_IDS[0] },
    });
    expect(viewerRewind.statusCode).toBe(403);

    const foreignProbes = [
      await http.inject({
        method: "POST",
        url: `/v1/projects/${projectA.projectId}/sessions`,
        headers: authorization(tenantB.credential.token),
        payload: { workspaceId: projectA.workspaceId, title: "Test conversation" },
      }),
      await http.inject({
        method: "POST",
        url: `/v1/sessions/${sessionA.sessionId}/turns`,
        headers: {
          ...authorization(tenantB.credential.token),
          "idempotency-key": "foreign-turn-probe",
        },
        payload: { prompt: "probe" },
      }),
      await http.inject({
        method: "POST",
        url: `/v1/sessions/${sessionA.sessionId}/turns/${turnA.turnId}/cancellations`,
        headers: {
          ...authorization(tenantB.credential.token),
          "idempotency-key": "foreign-cancel-probe",
        },
        payload: {},
      }),
      await http.inject({
        method: "GET",
        url: `/v1/sessions/${sessionA.sessionId}/events`,
        headers: {
          ...authorization(tenantB.credential.token),
          "last-event-id": "0",
        },
      }),
      await http.inject({
        method: "GET",
        url: `/v1/runs/${turnA.runId}/review-bundle`,
        headers: authorization(tenantB.credential.token),
      }),
      await http.inject({
        method: "POST",
        url: `/v1/runs/${turnA.runId}/rewinds`,
        headers: {
          ...authorization(tenantB.credential.token),
          "idempotency-key": "foreign-rewind-probe",
        },
        payload: { sourceAttemptId: TENANT_B_IDS[0] },
      }),
    ];
    for (const response of foreignProbes) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "not_found" } });
      expect(response.body).not.toContain(tenantA.tenantId);
      expect(response.body).not.toContain("tenant-private prompt");
    }
  });

  it("enforces tenant-local quotas after returning idempotent acceptance replays", async () => {
    const projectLimit = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(memberAToken),
      payload: { name: "alpha-over-project-limit" },
    });
    expect(projectLimit.statusCode).toBe(429);
    expect(projectLimit.json()).toMatchObject({ error: { code: "tenant_quota_exceeded" } });

    const replay = await http.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.sessionId}/turns`,
      headers: {
        ...authorization(memberAToken),
        "idempotency-key": "alpha-private-turn",
      },
      payload: { prompt: "tenant-private prompt" },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ commandId: turnA.commandId, replayed: true });

    const newTurn = await http.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.sessionId}/turns`,
      headers: {
        ...authorization(memberAToken),
        "idempotency-key": "alpha-over-turn-limit",
      },
      payload: { prompt: "second unsettled turn" },
    });
    expect(newTurn.statusCode).toBe(429);
    expect(newTurn.json()).toMatchObject({ error: { code: "tenant_quota_exceeded" } });
  });

  it("restricts operational insights to owners and keeps them tenant scoped", async () => {
    const denied = await http.inject({
      method: "GET",
      url: "/v1/operations/summary",
      headers: authorization(memberAToken),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "authorization_denied" } });
    const auditDenied = await http.inject({
      method: "GET",
      url: "/v1/operations/audit",
      headers: authorization(memberAToken),
    });
    expect(auditDenied.statusCode).toBe(403);

    const bravo = await http.inject({
      method: "GET",
      url: "/v1/operations/summary",
      headers: authorization(tenantB.credential.token),
    });
    expect(bravo.statusCode).toBe(200);
    expect(bravo.json()).toMatchObject({
      runs: { queued: 0, active: 0 },
      model: { requests: 0, costMicrousd: 0 },
      tools: { calls: 0, failures: 0 },
      activeSandboxAssignments: 0,
      failures: [],
    });
    expect(bravo.body).not.toContain(tenantA.tenantId);
    const bravoAudit = await http.inject({
      method: "GET",
      url: "/v1/operations/audit",
      headers: authorization(tenantB.credential.token),
    });
    expect(bravoAudit.statusCode).toBe(200);
    expect(bravoAudit.json()).toEqual({
      tenantId: tenantB.tenantId,
      events: [],
      truncated: false,
    });
  });

  it("invalidates a revoked tenant credential without affecting another tenant", async () => {
    await expect(
      revokePrivateTenantCredential(database, {
        tenant: tenantA.tenantId,
        credentialId: "a1000000-0000-4000-8000-000000000007",
        revokedAt: NOW,
      }),
    ).resolves.toBe(true);
    const revoked = await http.inject({
      method: "GET",
      url: "/v1/identity",
      headers: authorization(viewerAToken),
    });
    expect(revoked.statusCode).toBe(401);
    const bravo = await http.inject({
      method: "GET",
      url: "/v1/identity",
      headers: authorization(tenantB.credential.token),
    });
    expect(bravo.statusCode).toBe(200);
  });
});
