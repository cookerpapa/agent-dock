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
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import {
  DeterministicExecutionBackend,
  OutboxDispatcher,
  OutboxDispatcherStaleClaimError,
  type TurnExecutionBackend,
  createControlPlaneApplication,
} from "../src/index.ts";

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
let firstAccepted: AcceptedTurnResource;

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

async function acceptTurn(idempotencyKey: string, prompt: string): Promise<AcceptedTurnResource> {
  const response = await http.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { "idempotency-key": idempotencyKey },
    payload: { prompt },
  });
  expect(response.statusCode).toBe(202);
  return response.json() as AcceptedTurnResource;
}

async function readTurnExecution(accepted: AcceptedTurnResource) {
  return database
    .selectFrom("commands as command")
    .innerJoin("turns as turn", "turn.id", "command.turn_id")
    .innerJoin("sessions as session_row", "session_row.id", "turn.session_id")
    .innerJoin("outbox", (join) =>
      join
        .onRef("outbox.tenant_id", "=", "command.tenant_id")
        .on(sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${accepted.commandId}`),
    )
    .select([
      "command.state as commandState",
      "command.acknowledged_at as acknowledgedAt",
      "command.completed_at as commandCompletedAt",
      "command.failure_code as commandFailureCode",
      "turn.state as turnState",
      "turn.started_at as startedAt",
      "turn.settled_at as settledAt",
      "turn.stop_reason as stopReason",
      "turn.failure_code as turnFailureCode",
      "turn.failure_message as failureMessage",
      "turn.failure_retryable as failureRetryable",
      "session_row.state as sessionState",
      "outbox.attempts as attempts",
      "outbox.published_at as publishedAt",
      "outbox.last_error as lastError",
    ])
    .where("command.id", "=", accepted.commandId)
    .where("turn.id", "=", accepted.turnId)
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
    maxConnections: 2,
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
    firstAccepted = response.json() as AcceptedTurnResource;
    expect(firstAccepted).toMatchObject({
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
      .where("turn.id", "=", firstAccepted.turnId)
      .where("command.id", "=", firstAccepted.commandId)
      .where("outbox.topic", "=", "control.command.pending.v1")
      .executeTakeFirstOrThrow();
    expect(durable).toMatchObject({
      turnId: firstAccepted.turnId,
      inputText: "fix the failing test",
      thinkingLevel: "low",
      commandId: firstAccepted.commandId,
      commandState: "pending",
      topic: "control.command.pending.v1",
      outboxPayload: {
        schemaVersion: 1,
        commandId: firstAccepted.commandId,
        sessionId: session.sessionId,
        turnId: firstAccepted.turnId,
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

  it("dispatches a durable command through ACK to a completed turn", async () => {
    const backend = new DeterministicExecutionBackend([{ kind: "complete", stopReason: "done" }]);
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      commandId: firstAccepted.commandId,
      turnId: firstAccepted.turnId,
      attempt: 1,
    });
    const durable = await readTurnExecution(firstAccepted);
    expect(durable).toMatchObject({
      commandState: "completed",
      turnState: "completed",
      sessionState: "idle",
      stopReason: "done",
      attempts: 1,
      lastError: null,
    });
    expect(durable.acknowledgedAt).not.toBeNull();
    expect(durable.startedAt).not.toBeNull();
    expect(durable.commandCompletedAt).not.toBeNull();
    expect(durable.settledAt).not.toBeNull();
    expect(durable.publishedAt).not.toBeNull();
    expect(backend.records).toEqual([
      {
        commandId: firstAccepted.commandId,
        sessionId: session.sessionId,
        turnId: firstAccepted.turnId,
        outcome: "complete",
      },
    ]);
    expect(JSON.stringify(backend.records)).not.toContain("fix the failing test");
  });

  it("does not let two dispatchers execute the same claimed turn", async () => {
    const accepted = await acceptTurn("concurrent-dispatch", "run exactly once");
    let allowAcknowledgement!: () => void;
    let releaseExecution!: () => void;
    let reportClaimed!: () => void;
    let reportAcknowledged!: () => void;
    const claimed = new Promise<void>((resolve) => {
      reportClaimed = resolve;
    });
    const acknowledgementAllowed = new Promise<void>((resolve) => {
      allowAcknowledgement = resolve;
    });
    const acknowledged = new Promise<void>((resolve) => {
      reportAcknowledged = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    const backend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        executions += 1;
        reportClaimed();
        await acknowledgementAllowed;
        await lifecycle.started();
        reportAcknowledged();
        await release;
        return { stopReason: "agent_end" };
      },
    };
    const firstDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
    });
    const secondDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
    });

    const dispatches = [firstDispatcher.dispatchNext(), secondDispatcher.dispatchNext()];
    await claimed;
    const earlyResult = await Promise.race(dispatches);
    const executionsBeforeAcknowledgement = executions;
    allowAcknowledgement();
    await acknowledged;
    const duringExecution = await readTurnExecution(accepted);
    releaseExecution();
    const results = await Promise.all(dispatches);

    expect(earlyResult).toEqual({ status: "idle" });
    expect(executionsBeforeAcknowledgement).toBe(1);
    expect(duringExecution).toMatchObject({
      commandState: "acknowledged",
      turnState: "running",
      sessionState: "running",
      attempts: 1,
      publishedAt: expect.anything(),
      lastError: null,
    });
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "idle"]);
    expect(results.find((result) => result.status === "completed")).toMatchObject({
      commandId: accepted.commandId,
    });
    expect((await readTurnExecution(accepted)).attempts).toBe(1);
  });

  it("fences a dispatcher whose pre-ACK claim lease was superseded", async () => {
    const accepted = await acceptTurn("stale-dispatch", "only the current claimant may start");
    let now = new Date(Date.now() + 1_000);
    let releaseStaleClaim!: () => void;
    let reportClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => {
      reportClaimed = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    let staleBackendWorkStarted = false;
    const staleBackend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        reportClaimed();
        await release;
        await lifecycle.started();
        staleBackendWorkStarted = true;
        return { stopReason: "stale_backend_must_not_finish" };
      },
    };
    const staleDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: staleBackend,
      clock: () => new Date(now),
      claimLeaseMs: 10,
    });

    const staleDispatch = staleDispatcher.dispatchNext();
    const staleOutcome = staleDispatch.then(
      () => undefined,
      (error: unknown) => error,
    );
    await claimed;

    now = new Date(now.valueOf() + 11);
    const currentBackend = new DeterministicExecutionBackend();
    const currentDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: currentBackend,
      clock: () => new Date(now),
      claimLeaseMs: 10,
    });
    const currentResult = await currentDispatcher.dispatchNext();
    releaseStaleClaim();
    const staleError = await staleOutcome;

    expect(currentResult).toMatchObject({
      status: "completed",
      commandId: accepted.commandId,
      attempt: 2,
    });
    expect(staleError).toBeInstanceOf(OutboxDispatcherStaleClaimError);
    expect(staleBackendWorkStarted).toBe(false);
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "completed",
      turnState: "completed",
      attempts: 2,
      publishedAt: expect.anything(),
    });
  });

  it("requeues a retryable pre-ACK failure without letting a later turn overtake it", async () => {
    const accepted = await acceptTurn("retry-before-start", "retry without leaking this prompt");
    let now = new Date(Date.now() + 1_000);
    const backend = new DeterministicExecutionBackend([
      {
        kind: "fail_before_start",
        code: "runner_busy",
        safeMessage: "No runner capacity was available",
        retryable: true,
      },
      { kind: "complete" },
    ]);
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
      clock: () => new Date(now),
      retryDelayMs: 10,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "retry_scheduled",
      commandId: accepted.commandId,
      attempt: 1,
      failureCode: "runner_busy",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "pending",
      turnState: "queued",
      sessionState: "idle",
      attempts: 1,
      publishedAt: null,
      lastError: "runner_busy",
    });

    const follower = await acceptTurn("retry-follower", "wait behind the retrying turn");
    await database
      .updateTable("commands")
      .set({ created_at: new Date(0) })
      .where("id", "=", accepted.commandId)
      .executeTakeFirstOrThrow();
    await expect(dispatcher.dispatchNext()).resolves.toEqual({ status: "idle" });
    expect(await readTurnExecution(follower)).toMatchObject({
      commandState: "pending",
      turnState: "queued",
      attempts: 0,
      publishedAt: null,
    });

    now = new Date(now.valueOf() + 11);
    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      commandId: accepted.commandId,
      attempt: 2,
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "completed",
      turnState: "completed",
      sessionState: "idle",
      attempts: 2,
      publishedAt: expect.anything(),
      lastError: null,
    });
    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      commandId: follower.commandId,
      attempt: 1,
    });
    expect(backend.records).toHaveLength(3);
    expect(JSON.stringify(backend.records)).not.toContain("retry without leaking this prompt");
  });

  it("stops pre-ACK retry after the configured attempt limit", async () => {
    const accepted = await acceptTurn("retry-exhausted", "eventually fail before start");
    let now = new Date(Date.now() + 1_000);
    const failure = {
      kind: "fail_before_start",
      code: "runner_busy",
      safeMessage: "No runner capacity was available",
      retryable: true,
    } as const;
    const backend = new DeterministicExecutionBackend([failure, failure]);
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
      clock: () => new Date(now),
      retryDelayMs: 10,
      maxAttempts: 2,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "retry_scheduled",
      attempt: 1,
    });
    now = new Date(now.valueOf() + 11);
    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      attempt: 2,
      phase: "before_start",
      failureCode: "runner_busy",
    });

    const durable = await readTurnExecution(accepted);
    expect(durable).toMatchObject({
      commandState: "failed",
      commandFailureCode: "runner_busy",
      turnState: "failed",
      turnFailureCode: "runner_busy",
      failureRetryable: true,
      sessionState: "idle",
      attempts: 2,
      publishedAt: expect.anything(),
      lastError: "runner_busy",
    });
    expect(durable.acknowledgedAt).toBeNull();
    expect(durable.startedAt).toBeNull();
  });

  it("makes an execution failure terminal after ACK", async () => {
    const accepted = await acceptTurn("failure-after-start", "fail after acknowledgement");
    const backend = new DeterministicExecutionBackend([
      {
        kind: "fail_after_start",
        code: "model_timeout",
        safeMessage: "The model call timed out",
        retryable: true,
      },
    ]);
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      attempt: 1,
      phase: "after_start",
      failureCode: "model_timeout",
    });
    const durable = await readTurnExecution(accepted);
    expect(durable).toMatchObject({
      commandState: "failed",
      commandFailureCode: "model_timeout",
      turnState: "failed",
      turnFailureCode: "model_timeout",
      failureMessage: "The model call timed out",
      failureRetryable: true,
      sessionState: "idle",
      attempts: 1,
      lastError: null,
    });
    expect(durable.acknowledgedAt).not.toBeNull();
    expect(durable.startedAt).not.toBeNull();
    expect(durable.commandCompletedAt).not.toBeNull();
    expect(durable.settledAt).not.toBeNull();
    expect(durable.publishedAt).not.toBeNull();
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
