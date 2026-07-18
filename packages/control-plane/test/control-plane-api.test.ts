import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, upInitialControlPlane, type Database } from "@agent-dock/database";
import type {
  AcceptedTurnResource,
  ControlPlaneApiError,
  ProjectResource,
  SessionResource,
} from "@agent-dock/protocol";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely, KyselyPlugin } from "kysely";
import { createControlPlaneApplication } from "../src/index.ts";

const IDS = {
  tenant: "00000000-0000-4000-8000-000000000001",
  credential: "30000000-0000-4000-8000-000000000001",
  profile: "40000000-0000-4000-8000-000000000001",
};

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;
let application: NestFastifyApplication;
let http: FastifyInstance;
let project: ProjectResource;
let session: SessionResource;

const rejectOutboxInsertPlugin: KyselyPlugin = {
  transformQuery({ node }) {
    if (
      node.kind === "InsertQueryNode" &&
      node.into?.kind === "TableNode" &&
      node.into.table.identifier.name === "outbox"
    ) {
      throw new Error("injected outbox write failure");
    }
    return node;
  },
  async transformResult({ result }) {
    return result;
  },
};

async function seedSingleUserProfile(): Promise<void> {
  await database
    .insertInto("tenants")
    .values({ id: IDS.tenant, slug: "owner" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "openai-codex",
      kind: "oauth",
      secret_ref: "broker://owner/openai-codex",
      version: 1,
      status: "active",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "default",
      provider: "openai-codex",
      model_id: "gpt-5.4-mini",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off", "low"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  let connectionString = process.env.AGENT_DOCK_TEST_DATABASE_URL;
  if (!connectionString) {
    pglite = await PGlite.create();
    socketServer = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 2,
    });
    await socketServer.start();
    connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  }
  database = createDatabase({
    connectionString,
    maxConnections: 1,
  });
  await upInitialControlPlane(database as unknown as Kysely<unknown>);
  await seedSingleUserProfile();
  application = await createControlPlaneApplication({
    database,
    tenantId: IDS.tenant,
    defaultModelProfileId: IDS.profile,
  });
  http = application.getHttpAdapter().getInstance() as FastifyInstance;
}, 30_000);

afterAll(async () => {
  await application?.close();
  await database?.destroy();
  if (socketServer) await socketServer.stop();
  if (pglite) await pglite.close();
});

describe.sequential("single-user durable turn intake API", () => {
  it("creates a project and workspace atomically, then creates a cold session", async () => {
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "  Sample Java Repair  " },
    });
    expect(projectResponse.statusCode).toBe(201);
    project = projectResponse.json() as ProjectResource;
    expect(project).toMatchObject({ name: "Sample Java Repair" });

    const persistedProject = await database
      .selectFrom("projects as project")
      .innerJoin("workspaces as workspace", "workspace.project_id", "project.id")
      .select(["project.id as projectId", "workspace.id as workspaceId"])
      .where("project.id", "=", project.projectId)
      .executeTakeFirstOrThrow();
    expect(persistedProject).toEqual({
      projectId: project.projectId,
      workspaceId: project.workspaceId,
    });

    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    session = sessionResponse.json() as SessionResource;
    expect(session).toMatchObject({
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      state: "cold",
      modelProfileId: IDS.profile,
    });

    const cursor = await database
      .selectFrom("session_event_cursors")
      .select(["last_persisted_seq", "acknowledged_through_seq"])
      .where("session_id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(cursor).toEqual({ last_persisted_seq: "0", acknowledged_through_seq: "0" });
  });

  it("rejects malformed bodies and a missing Idempotency-Key before writing", async () => {
    const missingRoute = await http.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(missingRoute.statusCode).toBe(404);
    expect(missingRoute.json()).toEqual({
      error: {
        code: "route_not_found",
        message: "The requested API route was not found",
      },
    });

    const extraField = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Invalid", providerToken: "must-not-pass" },
    });
    expect(extraField.statusCode).toBe(400);
    expect((extraField.json() as ControlPlaneApiError).error.code).toBe("invalid_request");

    const missingKey = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns`,
      payload: { prompt: "fix the failing test" },
    });
    expect(missingKey.statusCode).toBe(400);
    expect((missingKey.json() as ControlPlaneApiError).error.code).toBe("invalid_request");

    const disallowedThinking = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns`,
      headers: { "idempotency-key": "disallowed-thinking" },
      payload: { prompt: "fix the test", thinkingLevel: "high" },
    });
    expect(disallowedThinking.statusCode).toBe(400);
    expect((disallowedThinking.json() as ControlPlaneApiError).error.code).toBe("invalid_request");

    const turnCount = await database
      .selectFrom("turns")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("session_id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(turnCount.count).toBe("0");
  });

  it("returns 202 only after the turn, command, and outbox record are durable", async () => {
    const response = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns`,
      headers: { "idempotency-key": "repair-request-1" },
      payload: { prompt: "fix the failing test", thinkingLevel: "low" },
    });
    expect(response.statusCode).toBe(202);
    const accepted = response.json() as AcceptedTurnResource;
    expect(accepted).toMatchObject({
      sessionId: session.sessionId,
      state: "queued",
      replayed: false,
    });

    const durable = await database
      .selectFrom("turns as turn")
      .innerJoin("commands as command", "command.turn_id", "turn.id")
      .innerJoin("outbox", "outbox.aggregate_id", "turn.session_id")
      .select([
        "turn.id as turnId",
        "turn.input_text as inputText",
        "turn.thinking_level as thinkingLevel",
        "command.id as commandId",
        "command.state as commandState",
        "outbox.topic as topic",
        "outbox.payload as outboxPayload",
      ])
      .where("turn.id", "=", accepted.turnId)
      .where("command.id", "=", accepted.commandId)
      .where("outbox.topic", "=", "control.command.pending.v1")
      .executeTakeFirstOrThrow();
    expect(durable).toMatchObject({
      turnId: accepted.turnId,
      inputText: "fix the failing test",
      thinkingLevel: "low",
      commandId: accepted.commandId,
      commandState: "pending",
      topic: "control.command.pending.v1",
      outboxPayload: {
        schemaVersion: 1,
        commandId: accepted.commandId,
        sessionId: session.sessionId,
        turnId: accepted.turnId,
        kind: "turn.execute",
      },
    });
    expect(JSON.stringify(durable.outboxPayload)).not.toContain("fix the failing test");
  });

  it("replays the original acceptance for the same idempotency key and request", async () => {
    const original = await database
      .selectFrom("commands")
      .select(["id", "turn_id"])
      .where("session_id", "=", session.sessionId)
      .where("idempotency_key", "=", "repair-request-1")
      .executeTakeFirstOrThrow();
    const response = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns`,
      headers: { "idempotency-key": "repair-request-1" },
      payload: { prompt: "fix the failing test", thinkingLevel: "low" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      commandId: original.id,
      turnId: original.turn_id,
      replayed: true,
    });

    const count = await database
      .selectFrom("commands")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("session_id", "=", session.sessionId)
      .where("idempotency_key", "=", "repair-request-1")
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("1");
  });

  it("returns 409 when a key is reused for different content", async () => {
    const response = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns`,
      headers: { "idempotency-key": "repair-request-1" },
      payload: { prompt: "perform a different task", thinkingLevel: "low" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "idempotency_conflict",
        message: "Idempotency-Key was already used for a different turn request",
      },
    });
  });

  it("rolls back the turn and command if the outbox write fails", async () => {
    const failingApplication = await createControlPlaneApplication({
      database: database.withPlugin(rejectOutboxInsertPlugin),
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
    });
    const failingHttp = failingApplication.getHttpAdapter().getInstance() as FastifyInstance;
    try {
      const response = await failingHttp.inject({
        method: "POST",
        url: `/v1/sessions/${session.sessionId}/turns`,
        headers: { "idempotency-key": "forced-outbox-failure" },
        payload: { prompt: "rollback-me" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "The control plane could not complete the request",
        },
      });
      expect(response.body).not.toContain("outbox");
      expect(response.body).not.toContain("rollback-me");
    } finally {
      await failingApplication.close();
    }

    const turnCount = await database
      .selectFrom("turns")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("input_text", "=", "rollback-me")
      .executeTakeFirstOrThrow();
    const commandCount = await database
      .selectFrom("commands")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("idempotency_key", "=", "forced-outbox-failure")
      .executeTakeFirstOrThrow();
    expect(turnCount.count).toBe("0");
    expect(commandCount.count).toBe("0");
  });
});
