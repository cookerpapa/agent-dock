import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import type {
  AcceptedTurnResource,
  AcceptedTurnCancellationResource,
  ControlPlaneApiError,
  EventPublishMessage,
  ProjectResource,
  SessionResource,
} from "@agent-dock/protocol";
import { parseSupervisorToControlMessage } from "@agent-dock/protocol";
import {
  DockerSandboxTurnRunner,
  FileEventSpoolStore,
  LocalSandboxSupervisor,
  PiRpcTurnCancelledError,
  PiRpcTurnError,
  PiRpcTurnRunner,
  type SandboxAssignmentInventory,
  type SandboxRuntimeAssignment,
} from "@agent-dock/sandbox-supervisor";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import {
  CancellationDispatcher,
  AssignmentReconciler,
  DeterministicExecutionBackend,
  DurableEventStore,
  FileCheckpointObjectStore,
  LocalSupervisorExecutionBackend,
  OutboxDispatcher,
  OutboxDispatcherStaleClaimError,
  PostgresSessionEventNotifications,
  PostgresSandboxCheckpointStore,
  SessionLeaseCoordinator,
  TurnCancellationBackendError,
  type TurnCancellationBackend,
  type TurnExecutionBackend,
  type TurnExecutionLeaseManager,
  createControlPlaneApplication,
} from "../src/index.ts";

const IDS = {
  tenant: "00000000-0000-4000-8000-000000000001",
  credential: "30000000-0000-4000-8000-000000000001",
  profile: "40000000-0000-4000-8000-000000000001",
  sandbox: "50000000-0000-4000-8000-000000000001",
  sandboxBoot: "60000000-0000-4000-8000-000000000001",
  cancellationSandbox: "50000000-0000-4000-8000-000000000002",
  cancellationSandboxBoot: "60000000-0000-4000-8000-000000000002",
  dockerSandbox: "50000000-0000-4000-8000-000000000003",
  dockerSandboxBoot: "60000000-0000-4000-8000-000000000003",
  spoolSandbox: "50000000-0000-4000-8000-000000000004",
  spoolSandboxBoot: "60000000-0000-4000-8000-000000000004",
  reconciliationSandbox: "50000000-0000-4000-8000-000000000005",
  reconciliationSandboxBoot: "60000000-0000-4000-8000-000000000005",
  requeueSandbox: "50000000-0000-4000-8000-000000000006",
  requeueSandboxBoot: "60000000-0000-4000-8000-000000000006",
  failedReconciliationSandbox: "50000000-0000-4000-8000-000000000007",
  failedReconciliationSandboxBoot: "60000000-0000-4000-8000-000000000007",
  retirementSandbox: "50000000-0000-4000-8000-000000000008",
  retirementSandboxBoot: "60000000-0000-4000-8000-000000000008",
  mismatchedRuntimeSandbox: "50000000-0000-4000-8000-000000000009",
  mismatchedRuntimeSandboxBoot: "60000000-0000-4000-8000-000000000009",
  notificationFallbackSandbox: "50000000-0000-4000-8000-000000000010",
  notificationFallbackSandboxBoot: "60000000-0000-4000-8000-000000000010",
  notificationSandbox: "50000000-0000-4000-8000-000000000011",
  notificationSandboxBoot: "60000000-0000-4000-8000-000000000011",
};

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;
let databaseConnectionString: string;
let application: NestFastifyApplication;
let http: FastifyInstance;
let baseUrl: string;
let durableEventStore: DurableEventStore;
let project: ProjectResource;
let session: SessionResource;
let firstAccepted: AcceptedTurnResource;
let sessionEventNotifications: PostgresSessionEventNotifications | undefined;

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

type ParsedSseEvent = {
  id: number;
  event: string;
  data: Record<string, unknown>;
};

async function readSseEvents(
  response: Response,
  count: number,
  timeoutMs = 10_000,
): Promise<readonly ParsedSseEvent[]> {
  if (response.body === null) throw new Error("SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out reading SSE events")), timeoutMs);
    timer.unref();
  });
  const reading = (async () => {
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before all events arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (frame.startsWith(":")) continue;
        const fields = new Map(
          frame.split("\n").map((line) => {
            const separator = line.indexOf(":");
            return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
          }),
        );
        events.push({
          id: Number(fields.get("id")),
          event: fields.get("event") ?? "",
          data: JSON.parse(fields.get("data") ?? "{}") as Record<string, unknown>,
        });
        if (events.length === count) return events;
      }
    }
    return events;
  })();
  try {
    return await Promise.race([reading, timeout]);
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

class MemoryAssignmentInventory implements SandboxAssignmentInventory {
  readonly terminated: SandboxRuntimeAssignment[] = [];
  assignments: SandboxRuntimeAssignment[];
  failTermination = false;

  constructor(assignments: readonly SandboxRuntimeAssignment[]) {
    this.assignments = assignments.map((assignment) => ({ ...assignment }));
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    return this.assignments.map((assignment) => ({ ...assignment }));
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    if (this.failTermination) throw new Error("injected runtime termination failure");
    const current = this.assignments.find(
      (candidate) => candidate.runtimeId === assignment.runtimeId,
    );
    if (current === undefined) return;
    expect(current).toEqual(assignment);
    this.assignments = this.assignments.filter(
      (candidate) => candidate.runtimeId !== assignment.runtimeId,
    );
    this.terminated.push({ ...assignment });
  }
}

async function createAssignedTurn(options: {
  sandboxId: string;
  sandboxBootId: string;
  supervisorId: string;
  phase: "dispatched" | "acknowledged";
  expired: boolean;
}): Promise<{
  accepted: AcceptedTurnResource;
  assignedSession: SessionResource;
  runtime: SandboxRuntimeAssignment;
}> {
  const sessionResponse = await http.inject({
    method: "POST",
    url: `/v1/projects/${project.projectId}/sessions`,
    payload: { workspaceId: project.workspaceId },
  });
  expect(sessionResponse.statusCode).toBe(201);
  const assignedSession = sessionResponse.json() as SessionResource;
  const turnResponse = await http.inject({
    method: "POST",
    url: `/v1/sessions/${assignedSession.sessionId}/turns`,
    headers: { "idempotency-key": `reconcile-${options.sandboxId}` },
    payload: { prompt: "Simulate a supervisor disappearing during this turn." },
  });
  expect(turnResponse.statusCode).toBe(202);
  const accepted = turnResponse.json() as AcceptedTurnResource;
  const now = new Date();
  const acquiredAt = new Date(now.valueOf() - 10_000);
  const validUntil = new Date(now.valueOf() + (options.expired ? -5_000 : 60_000));
  const leaseId = globalThis.crypto.randomUUID();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("sandboxes")
      .values({
        id: options.sandboxId,
        supervisor_id: options.supervisorId,
        boot_id: options.sandboxBootId,
        state: "leased",
        max_concurrent_sessions: 1,
        active_sessions: 1,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("commands")
      .set({
        state: options.phase,
        dispatched_at: now,
        acknowledged_at: options.phase === "acknowledged" ? now : null,
      })
      .where("id", "=", accepted.commandId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("turns")
      .set({
        state: options.phase === "acknowledged" ? "running" : "dispatching",
        started_at: options.phase === "acknowledged" ? now : null,
      })
      .where("id", "=", accepted.turnId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("sessions")
      .set({
        state: options.phase === "acknowledged" ? "running" : "cold",
        last_fencing_token: 1,
      })
      .where("id", "=", assignedSession.sessionId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("outbox")
      .set({
        attempts: 1,
        published_at: options.phase === "acknowledged" ? now : null,
      })
      .where(sql<boolean>`${sql.ref("payload")} ->> 'commandId' = ${accepted.commandId}`)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("session_leases")
      .values({
        session_id: assignedSession.sessionId,
        lease_id: leaseId,
        sandbox_id: options.sandboxId,
        fencing_token: 1,
        acquired_at: acquiredAt,
        renewed_at: acquiredAt,
        valid_until: validUntil,
      })
      .executeTakeFirstOrThrow();
  });
  return {
    accepted,
    assignedSession,
    runtime: {
      runtimeId: `runtime-${options.sandboxId}`,
      runtimeName: `runtime-${options.sandboxId}`,
      supervisorId: options.supervisorId,
      bootId: options.sandboxBootId,
      sandboxId: options.sandboxId,
      commandId: accepted.commandId,
      sessionId: assignedSession.sessionId,
      turnId: accepted.turnId,
      leaseId,
      fencingToken: 1,
    },
  };
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
  databaseConnectionString = connectionString;
  database = createDatabase({
    connectionString,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  await seedSingleUserProfile();
  if (pglite === undefined) {
    sessionEventNotifications = new PostgresSessionEventNotifications({
      connectionString: databaseConnectionString,
      tenantId: IDS.tenant,
      applicationName: `agent-dock-api-test-${process.pid}`,
      initialReconnectDelayMs: 20,
      maxReconnectDelayMs: 100,
    });
  }
  application = await createControlPlaneApplication({
    database,
    tenantId: IDS.tenant,
    defaultModelProfileId: IDS.profile,
    ...(sessionEventNotifications === undefined ? {} : { sessionEventNotifications }),
  });
  await application.listen(0, "127.0.0.1");
  http = application.getHttpAdapter().getInstance() as FastifyInstance;
  baseUrl = await application.getUrl();
  durableEventStore = application.get(DurableEventStore);
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
      mailboxPosition: 1,
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

  it("does not report a queued turn as cancellable in the active-turn v0 API", async () => {
    const response = await http.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/turns/${firstAccepted.turnId}/cancellations`,
      headers: { "idempotency-key": "cancel-before-running" },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "conflict",
        message: "Only an active turn can accept a cancellation request",
      },
    });
    const count = await database
      .selectFrom("commands")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("session_id", "=", session.sessionId)
      .where("idempotency_key", "=", "cancel-before-running")
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("0");
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
      mailboxPosition: firstAccepted.mailboxPosition,
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

  it("runs five concurrently queued inputs in durable mailbox order without overlap", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const mailboxSession = sessionResponse.json() as SessionResource;

    type MailboxAcceptance = {
      resource: AcceptedTurnResource;
      idempotencyKey: string;
      prompt: string;
    };
    const acceptMailboxTurn = async (
      inputNumber: number,
      expectedPosition?: number,
    ): Promise<MailboxAcceptance> => {
      const idempotencyKey = `mailbox-input-${String(inputNumber)}`;
      const prompt = `mailbox prompt ${String(inputNumber)}`;
      const response = await http.inject({
        method: "POST",
        url: `/v1/sessions/${mailboxSession.sessionId}/turns`,
        headers: { "idempotency-key": idempotencyKey },
        payload: { prompt },
      });
      expect(response.statusCode).toBe(202);
      const resource = response.json() as AcceptedTurnResource;
      expect(resource).toMatchObject({
        sessionId: mailboxSession.sessionId,
        replayed: false,
      });
      if (expectedPosition !== undefined) {
        expect(resource.mailboxPosition).toBe(expectedPosition);
      }
      return { resource, idempotencyKey, prompt };
    };

    let reportFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolvePromise) => {
      reportFirstStarted = resolvePromise;
    });
    const firstRelease = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const executionOrder: string[] = [];
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        activeExecutions += 1;
        maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
        executionOrder.push(request.commandId);
        try {
          await lifecycle.started();
          if (executionOrder.length === 1) {
            reportFirstStarted();
            await firstRelease;
          }
          return { stopReason: `mailbox-${String(executionOrder.length)}` };
        } finally {
          activeExecutions -= 1;
        }
      },
    };
    const dispatcher = new OutboxDispatcher({ database, tenantId: IDS.tenant, backend });
    const competingDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
    });

    const firstAccepted = await acceptMailboxTurn(1, 1);
    const firstExecution = dispatcher.dispatchNext();
    await firstStarted;
    const concurrentAcceptances = await Promise.all(
      [2, 3, 4, 5].map((inputNumber) => acceptMailboxTurn(inputNumber)),
    );
    const accepted = [firstAccepted, ...concurrentAcceptances].sort(
      (left, right) => left.resource.mailboxPosition - right.resource.mailboxPosition,
    );
    expect(accepted.map((item) => item.resource.mailboxPosition)).toEqual([1, 2, 3, 4, 5]);

    const replayTarget = accepted.find((item) => item.resource.mailboxPosition === 3);
    if (replayTarget === undefined) throw new Error("Mailbox position 3 was not allocated");

    const replay = await http.inject({
      method: "POST",
      url: `/v1/sessions/${mailboxSession.sessionId}/turns`,
      headers: { "idempotency-key": replayTarget.idempotencyKey },
      payload: { prompt: replayTarget.prompt },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      commandId: replayTarget.resource.commandId,
      mailboxPosition: 3,
      replayed: true,
    });

    const tiedTimestamp = new Date("2026-07-19T00:00:00.000Z");
    await database
      .updateTable("commands")
      .set({ created_at: tiedTimestamp })
      .where(
        "id",
        "in",
        accepted.slice(1).map((item) => item.resource.commandId),
      )
      .execute();
    await expect(competingDispatcher.dispatchNext()).resolves.toEqual({ status: "idle" });

    releaseFirst();
    await expect(firstExecution).resolves.toMatchObject({
      status: "completed",
      commandId: firstAccepted.resource.commandId,
    });
    for (const expected of accepted.slice(1)) {
      await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
        status: "completed",
        commandId: expected.resource.commandId,
      });
    }

    expect(executionOrder).toEqual(accepted.map((item) => item.resource.commandId));
    expect(maximumActiveExecutions).toBe(1);
    const durableCommands = await database
      .selectFrom("commands")
      .select(["id", "mailbox_position", "state"])
      .where("session_id", "=", mailboxSession.sessionId)
      .where("kind", "=", "turn.execute")
      .orderBy("mailbox_position", "asc")
      .execute();
    expect(durableCommands).toEqual(
      accepted.map((item) => ({
        id: item.resource.commandId,
        mailbox_position: String(item.resource.mailboxPosition),
        state: "completed",
      })),
    );
    const mailboxCounter = await database
      .selectFrom("sessions")
      .select("next_mailbox_position")
      .where("id", "=", mailboxSession.sessionId)
      .executeTakeFirstOrThrow();
    expect(mailboxCounter.next_mailbox_position).toBe("6");

    await database
      .updateTable("sessions")
      .set({ state: "recovering" })
      .where("id", "=", mailboxSession.sessionId)
      .executeTakeFirstOrThrow();
    const rejectedDuringRecovery = await http.inject({
      method: "POST",
      url: `/v1/sessions/${mailboxSession.sessionId}/turns`,
      headers: { "idempotency-key": "mailbox-recovery-rejection" },
      payload: { prompt: "must wait for recovery" },
    });
    expect(rejectedDuringRecovery.statusCode).toBe(409);
    expect(rejectedDuringRecovery.json()).toEqual({
      error: {
        code: "conflict",
        message: "Session cannot accept a queued follow-up while it is recovering",
      },
    });
    expect(
      await database
        .selectFrom("sessions")
        .select("next_mailbox_position")
        .where("id", "=", mailboxSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ next_mailbox_position: "6" });
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

  it("records cancellation as too late when natural completion wins before its ACK", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const raceSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${raceSession.sessionId}/turns`,
      headers: { "idempotency-key": "completion-cancellation-race" },
      payload: { prompt: "Complete before cancellation delivery." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;

    let reportStarted!: () => void;
    let releaseExecution!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      reportStarted = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseExecution = resolvePromise;
    });
    const executionBackend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        await lifecycle.started();
        reportStarted();
        await release;
        return { stopReason: "natural_completion" };
      },
    };
    const executionDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: executionBackend,
    });
    const execution = executionDispatcher.dispatchNext();
    await started;

    const cancellationResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${raceSession.sessionId}/turns/${accepted.turnId}/cancellations`,
      headers: { "idempotency-key": "too-late-cancellation" },
      payload: {},
    });
    expect(cancellationResponse.statusCode).toBe(202);
    const cancellation = cancellationResponse.json() as AcceptedTurnCancellationResource;

    releaseExecution();
    await expect(execution).resolves.toMatchObject({ status: "completed" });
    const cancellationBackend: TurnCancellationBackend = {
      async cancel() {
        throw new TurnCancellationBackendError(
          "cancellation_too_late",
          "Turn completed before cancellation delivery",
          false,
        );
      },
    };
    const unusedLeaseManager: TurnExecutionLeaseManager = {
      async assertCurrent() {
        throw new Error("Too-late cancellation must not assert a lease");
      },
      async releaseCurrent() {
        throw new Error("Too-late cancellation must not release a lease");
      },
    };
    const cancellationDispatcher = new CancellationDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: cancellationBackend,
      leaseManager: unusedLeaseManager,
    });
    await expect(cancellationDispatcher.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      commandId: cancellation.commandId,
      targetCommandId: accepted.commandId,
      phase: "before_start",
      failureCode: "cancellation_too_late",
    });

    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "completed",
      turnState: "completed",
      sessionState: "idle",
      stopReason: "natural_completion",
    });
    const failedCancellation = await database
      .selectFrom("commands as cancellation")
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "cancellation.tenant_id")
          .on(
            sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${cancellation.commandId}`,
          ),
      )
      .select([
        "cancellation.state as commandState",
        "cancellation.failure_code as failureCode",
        "outbox.attempts as attempts",
        "outbox.published_at as publishedAt",
      ])
      .where("cancellation.id", "=", cancellation.commandId)
      .executeTakeFirstOrThrow();
    expect(failedCancellation).toMatchObject({
      commandState: "failed",
      failureCode: "cancellation_too_late",
      attempts: 1,
    });
    expect(failedCancellation.publishedAt).not.toBeNull();
  });

  it("retains the fenced reservation when cancellation fails after its durable ACK", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const failedSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${failedSession.sessionId}/turns`,
      headers: { "idempotency-key": "post-ack-cancellation-failure-target" },
      payload: { prompt: "Remain isolated if cancellation cannot confirm termination." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;

    const acknowledgement = {
      leaseId: "70000000-0000-4000-8000-000000000001",
      fencingToken: 7,
    };
    let reportExecutionStarted!: () => void;
    let interruptExecution!: () => void;
    const executionStarted = new Promise<void>((resolvePromise) => {
      reportExecutionStarted = resolvePromise;
    });
    const executionInterrupted = new Promise<void>((resolvePromise) => {
      interruptExecution = resolvePromise;
    });
    const executionBackend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        await lifecycle.started(acknowledgement);
        reportExecutionStarted();
        await executionInterrupted;
        throw new Error("Injected target interruption");
      },
    };
    let leaseAssertions = 0;
    let leaseReleases = 0;
    const retainedLeaseManager: TurnExecutionLeaseManager = {
      async assertCurrent(_transaction, _request, candidate) {
        expect(candidate).toEqual(acknowledgement);
        leaseAssertions += 1;
      },
      async releaseCurrent() {
        leaseReleases += 1;
      },
    };
    const executionDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: executionBackend,
      leaseManager: retainedLeaseManager,
    });
    const execution = executionDispatcher.dispatchNext();
    await executionStarted;

    const cancellationResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${failedSession.sessionId}/turns/${accepted.turnId}/cancellations`,
      headers: { "idempotency-key": "post-ack-cancellation-failure" },
      payload: { gracePeriodMs: 0 },
    });
    expect(cancellationResponse.statusCode).toBe(202);
    const cancellation = cancellationResponse.json() as AcceptedTurnCancellationResource;
    const cancellationBackend: TurnCancellationBackend = {
      async cancel(_request, lifecycle) {
        await lifecycle.started(acknowledgement);
        interruptExecution();
        throw new TurnCancellationBackendError(
          "pi_process_tree_alive",
          "Pi process tree termination could not be confirmed",
          false,
        );
      },
    };
    const cancellationDispatcher = new CancellationDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: cancellationBackend,
      leaseManager: retainedLeaseManager,
    });

    const [cancellationResult, executionResult] = await Promise.all([
      cancellationDispatcher.dispatchNext(),
      execution,
    ]);
    expect(cancellationResult).toMatchObject({
      status: "failed",
      commandId: cancellation.commandId,
      targetCommandId: accepted.commandId,
      phase: "after_start",
      failureCode: "pi_process_tree_alive",
    });
    expect(["cancellation_pending", "failed"]).toContain(executionResult.status);
    expect(leaseAssertions).toBe(2);
    expect(leaseReleases).toBe(0);

    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      commandFailureCode: "pi_process_tree_alive",
      turnState: "failed",
      turnFailureCode: "pi_process_tree_alive",
      failureMessage: "Pi process tree termination could not be confirmed",
      failureRetryable: false,
      sessionState: "failed",
    });
    const failedCancellation = await database
      .selectFrom("commands as cancellation")
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "cancellation.tenant_id")
          .on(
            sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${cancellation.commandId}`,
          ),
      )
      .select([
        "cancellation.state as commandState",
        "cancellation.failure_code as failureCode",
        "cancellation.acknowledged_at as acknowledgedAt",
        "outbox.published_at as publishedAt",
      ])
      .where("cancellation.id", "=", cancellation.commandId)
      .executeTakeFirstOrThrow();
    expect(failedCancellation).toMatchObject({
      commandState: "failed",
      failureCode: "pi_process_tree_alive",
    });
    expect(failedCancellation.acknowledgedAt).not.toBeNull();
    expect(failedCancellation.publishedAt).not.toBeNull();
  });

  it("executes a fenced command through pinned Pi RPC and the loopback fake model", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const piSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${piSession.sessionId}/turns`,
      headers: { "idempotency-key": "pinned-pi-fake-model" },
      payload: { prompt: "Return the deterministic fake response." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;

    await database
      .insertInto("sandboxes")
      .values({
        id: IDS.sandbox,
        supervisor_id: "local-pi-rpc-test",
        boot_id: IDS.sandboxBoot,
        state: "ready",
        max_concurrent_sessions: 1,
        active_sessions: 0,
      })
      .executeTakeFirstOrThrow();

    const fakeModel = new FakeModelServer();
    const workspaceDirectory = await mkdtemp(resolve(tmpdir(), "agent-dock-workspace-"));
    const events: EventPublishMessage[] = [];
    const acknowledgedSequences: number[] = [];
    const persistedSequencesBeforeAck: number[] = [];
    let rejectedGap = false;
    let rejectedStaleFence = false;
    const durableStatesAtPublish: Array<{
      commandState: string;
      turnState: string;
      sessionState: string;
      publishedAt: Date | string | null;
    }> = [];
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.sandbox,
      leaseDurationMs: 120_000,
    });

    try {
      await fakeModel.start();
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspaceDirectory,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
          reasoning: false,
        }),
      });
      const supervisor = new LocalSandboxSupervisor({ runner, maxConcurrentSessions: 1 });
      const backend = new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: {
          async ingest(value) {
            const message = parseSupervisorToControlMessage(value);
            if (message.type !== "event.publish") throw new Error("Expected event publication");
            if (message.payload.event.seq === 1) {
              const gap = structuredClone(message);
              gap.messageId = globalThis.crypto.randomUUID();
              gap.payload.event.eventId = globalThis.crypto.randomUUID();
              gap.payload.event.seq = 2;
              await expect(durableEventStore.ingest(gap)).rejects.toMatchObject({
                code: "sequence_gap",
              });
              rejectedGap = true;

              const stale = structuredClone(message);
              stale.messageId = globalThis.crypto.randomUUID();
              stale.payload.fencingToken += 1;
              await expect(durableEventStore.ingest(stale)).rejects.toMatchObject({
                code: "stale_fence",
              });
              rejectedStaleFence = true;
            }
            const acknowledgement = await durableEventStore.ingest(message);
            const persisted = await database
              .selectFrom("session_events")
              .select(["event_id", "seq"])
              .where("session_id", "=", message.payload.event.sessionId)
              .where("seq", "=", String(message.payload.event.seq))
              .executeTakeFirstOrThrow();
            expect(persisted.event_id).toBe(message.payload.event.eventId);
            persistedSequencesBeforeAck.push(Number(persisted.seq));
            acknowledgedSequences.push(acknowledgement.payload.acknowledgedThroughSeq);
            return acknowledgement;
          },
        },
        async onEvent(message) {
          events.push(message);
          const state = await readTurnExecution(accepted);
          durableStatesAtPublish.push({
            commandState: state.commandState,
            turnState: state.turnState,
            sessionState: state.sessionState,
            publishedAt: state.publishedAt,
          });
        },
      });
      const dispatcher = new OutboxDispatcher({
        database,
        tenantId: IDS.tenant,
        backend,
        leaseManager: leaseCoordinator,
      });

      const liveAbort = new AbortController();
      const liveResponse = await fetch(`${baseUrl}/v1/sessions/${piSession.sessionId}/events`, {
        signal: liveAbort.signal,
      });
      expect(liveResponse.status).toBe(200);
      expect(liveResponse.headers.get("content-type")).toContain("text/event-stream");
      const liveEventsPromise = readSseEvents(liveResponse, 4);
      const dispatchResult = await dispatcher.dispatchNext();
      const liveEvents = await liveEventsPromise;
      liveAbort.abort();
      expect(dispatchResult).toEqual({
        status: "completed",
        commandId: accepted.commandId,
        sessionId: piSession.sessionId,
        turnId: accepted.turnId,
        attempt: 1,
      });

      expect(events.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "assistant.text.delta",
        "assistant.text.delta",
        "turn.completed",
      ]);
      expect(events.map((message) => message.payload.event.seq)).toEqual([1, 2, 3, 4]);
      expect(acknowledgedSequences).toEqual([1, 2, 3, 4]);
      expect(persistedSequencesBeforeAck).toEqual([1, 2, 3, 4]);
      expect(rejectedGap).toBe(true);
      expect(rejectedStaleFence).toBe(true);
      expect(liveEvents.map((event) => event.id)).toEqual([1, 2, 3, 4]);
      expect(liveEvents.map((event) => event.event)).toEqual([
        "turn.started",
        "assistant.text.delta",
        "assistant.text.delta",
        "turn.completed",
      ]);
      expect(liveEvents.map((event) => event.data.seq)).toEqual([1, 2, 3, 4]);
      expect(
        events
          .filter((message) => message.payload.event.type === "assistant.text.delta")
          .map((message) =>
            message.payload.event.type === "assistant.text.delta"
              ? message.payload.event.payload.text
              : "",
          )
          .join(""),
      ).toBe("AgentDock fake stream OK.");
      expect(
        events.every(
          (message) =>
            message.payload.commandId === accepted.commandId &&
            message.payload.leaseId === events[0]?.payload.leaseId &&
            message.payload.fencingToken === 1,
        ),
      ).toBe(true);
      expect(durableStatesAtPublish).toHaveLength(4);
      expect(
        durableStatesAtPublish.every(
          (state) =>
            state.commandState === "acknowledged" &&
            state.turnState === "running" &&
            state.sessionState === "running" &&
            state.publishedAt !== null,
        ),
      ).toBe(true);
      expect(fakeModel.observations).toHaveLength(1);
      expect(fakeModel.observations[0]).toMatchObject({
        model: "gpt-5.4-mini",
        messageCount: 2,
        toolCount: 0,
        authorizationPresent: true,
        completion: "completed",
      });

      const durable = await readTurnExecution(accepted);
      expect(durable).toMatchObject({
        commandState: "completed",
        turnState: "completed",
        sessionState: "idle",
        stopReason: "stop",
        attempts: 1,
      });
      const sandbox = await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.sandbox)
        .executeTakeFirstOrThrow();
      expect(sandbox).toEqual({ state: "ready", active_sessions: 0 });
      const persistedSession = await database
        .selectFrom("sessions")
        .select(["last_fencing_token", "next_event_seq"])
        .where("id", "=", piSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(persistedSession).toEqual({ last_fencing_token: "1", next_event_seq: "5" });
      const persistedEvents = await database
        .selectFrom("session_events")
        .select(["seq", "type", "agent_id", "command_id", "lease_id", "fencing_token"])
        .where("session_id", "=", piSession.sessionId)
        .orderBy("seq", "asc")
        .execute();
      expect(persistedEvents).toEqual(
        events.map((message) => ({
          seq: String(message.payload.event.seq),
          type: message.payload.event.type,
          agent_id: "root",
          command_id: accepted.commandId,
          lease_id: message.payload.leaseId,
          fencing_token: String(message.payload.fencingToken),
        })),
      );
      const cursor = await database
        .selectFrom("session_event_cursors")
        .select(["last_persisted_seq", "acknowledged_through_seq"])
        .where("session_id", "=", piSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(cursor).toEqual({ last_persisted_seq: "4", acknowledged_through_seq: "4" });

      const duplicate = structuredClone(events[3]!);
      duplicate.messageId = globalThis.crypto.randomUUID();
      await expect(durableEventStore.ingest(duplicate)).resolves.toMatchObject({
        type: "event.ack",
        payload: { acknowledgedThroughSeq: 4 },
      });
      const conflict = structuredClone(events[3]!);
      conflict.messageId = globalThis.crypto.randomUUID();
      if (conflict.payload.event.type !== "turn.completed") {
        throw new Error("Expected terminal completion event");
      }
      conflict.payload.event.payload.stopReason = "conflicting-redelivery";
      await expect(durableEventStore.ingest(conflict)).rejects.toMatchObject({
        code: "event_conflict",
      });

      const replayAbort = new AbortController();
      const replayResponse = await fetch(`${baseUrl}/v1/sessions/${piSession.sessionId}/events`, {
        headers: { "Last-Event-ID": "2" },
        signal: replayAbort.signal,
      });
      expect(replayResponse.status).toBe(200);
      const replayedEvents = await readSseEvents(replayResponse, 2);
      replayAbort.abort();
      expect(replayedEvents.map((event) => event.id)).toEqual([3, 4]);

      const malformedCursor = await http.inject({
        method: "GET",
        url: `/v1/sessions/${piSession.sessionId}/events`,
        headers: { "last-event-id": "01" },
      });
      expect(malformedCursor.statusCode).toBe(400);
      const futureCursor = await http.inject({
        method: "GET",
        url: `/v1/sessions/${piSession.sessionId}/events`,
        headers: { "last-event-id": "5" },
      });
      expect(futureCursor.statusCode).toBe(409);
      await expect(
        leaseCoordinator.assertCurrentLease(
          {
            tenantId: IDS.tenant,
            projectId: project.projectId,
            workspaceId: project.workspaceId,
            sessionId: piSession.sessionId,
            turnId: accepted.turnId,
            commandId: accepted.commandId,
            idempotencyKey: "pinned-pi-fake-model",
            nextEventSeq: "1",
            input: { kind: "prompt", prompt: "Return the deterministic fake response." },
            model: {
              profileId: IDS.profile,
              provider: "openai-codex",
              modelId: "gpt-5.4-mini",
              thinkingLevel: "off",
              credentialBindingId: IDS.credential,
              credentialBindingVersion: "1",
            },
          },
          {
            leaseId: events[0]!.payload.leaseId,
            fencingToken: events[0]!.payload.fencingToken,
          },
        ),
      ).rejects.toThrow("stale");
    } finally {
      await fakeModel.stop();
      await rm(workspaceDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("recovers a cross-replica SSE stream from PostgreSQL on its bounded heartbeat", async () => {
    const assigned = await createAssignedTurn({
      sandboxId: IDS.notificationFallbackSandbox,
      sandboxBootId: IDS.notificationFallbackSandboxBoot,
      supervisorId: "notification-fallback-supervisor",
      phase: "acknowledged",
      expired: false,
    });
    const secondApplication = await createControlPlaneApplication({
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      sessionEventStreamOptions: { heartbeatIntervalMs: 25 },
    });
    const abort = new AbortController();
    try {
      await secondApplication.listen(0, "127.0.0.1");
      const response = await fetch(
        `${await secondApplication.getUrl()}/v1/sessions/${assigned.assignedSession.sessionId}/events`,
        { signal: abort.signal },
      );
      expect(response.status).toBe(200);
      const received = readSseEvents(response, 1, 2_000);
      const now = new Date().toISOString();
      const event: EventPublishMessage = {
        protocolVersion: 1,
        messageId: globalThis.crypto.randomUUID(),
        sentAt: now,
        type: "event.publish",
        payload: {
          commandId: assigned.accepted.commandId,
          leaseId: assigned.runtime.leaseId,
          fencingToken: assigned.runtime.fencingToken,
          event: {
            schemaVersion: 1,
            eventId: globalThis.crypto.randomUUID(),
            sessionId: assigned.assignedSession.sessionId,
            turnId: assigned.accepted.turnId,
            agentId: "root",
            seq: 1,
            occurredAt: now,
            type: "turn.started",
            payload: { inputKind: "prompt" },
          },
        },
      };
      await durableEventStore.ingest(event);
      await expect(received).resolves.toMatchObject([
        {
          id: 1,
          event: "turn.started",
          data: { sessionId: assigned.assignedSession.sessionId, seq: 1 },
        },
      ]);
    } finally {
      abort.abort();
      await secondApplication.close();
    }
  });

  it.skipIf(!process.env.AGENT_DOCK_TEST_DATABASE_URL)(
    "notifies a second control-plane replica without duplicating its durable SSE sequence",
    async () => {
      const assigned = await createAssignedTurn({
        sandboxId: IDS.notificationSandbox,
        sandboxBootId: IDS.notificationSandboxBoot,
        supervisorId: "notification-supervisor",
        phase: "acknowledged",
        expired: false,
      });
      const secondNotifications = new PostgresSessionEventNotifications({
        connectionString: databaseConnectionString,
        tenantId: IDS.tenant,
        applicationName: `agent-dock-second-api-test-${process.pid}`,
        initialReconnectDelayMs: 20,
        maxReconnectDelayMs: 100,
      });
      let secondApplication: NestFastifyApplication | undefined;
      const abort = new AbortController();
      try {
        secondApplication = await createControlPlaneApplication({
          database,
          tenantId: IDS.tenant,
          defaultModelProfileId: IDS.profile,
          sessionEventNotifications: secondNotifications,
          sessionEventStreamOptions: { heartbeatIntervalMs: 5_000 },
        });
        await secondApplication.listen(0, "127.0.0.1");
        const response = await fetch(
          `${await secondApplication.getUrl()}/v1/sessions/${assigned.assignedSession.sessionId}/events`,
          { signal: abort.signal },
        );
        expect(response.status).toBe(200);
        const received = readSseEvents(response, 2, 2_000);
        const firstAt = new Date().toISOString();
        const first: EventPublishMessage = {
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: firstAt,
          type: "event.publish",
          payload: {
            commandId: assigned.accepted.commandId,
            leaseId: assigned.runtime.leaseId,
            fencingToken: assigned.runtime.fencingToken,
            event: {
              schemaVersion: 1,
              eventId: globalThis.crypto.randomUUID(),
              sessionId: assigned.assignedSession.sessionId,
              turnId: assigned.accepted.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: firstAt,
              type: "turn.started",
              payload: { inputKind: "prompt" },
            },
          },
        };
        await durableEventStore.ingest(first);
        await database.transaction().execute((transaction) =>
          sessionEventNotifications!.publish(transaction, {
            schemaVersion: 1,
            tenantId: IDS.tenant,
            sessionId: assigned.assignedSession.sessionId,
            throughSequence: 1,
          }),
        );
        const secondAt = new Date().toISOString();
        const second: EventPublishMessage = {
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: secondAt,
          type: "event.publish",
          payload: {
            commandId: assigned.accepted.commandId,
            leaseId: assigned.runtime.leaseId,
            fencingToken: assigned.runtime.fencingToken,
            event: {
              schemaVersion: 1,
              eventId: globalThis.crypto.randomUUID(),
              sessionId: assigned.assignedSession.sessionId,
              turnId: assigned.accepted.turnId,
              agentId: "root",
              seq: 2,
              occurredAt: secondAt,
              type: "assistant.text.delta",
              payload: { text: "cross-replica" },
            },
          },
        };
        await durableEventStore.ingest(second);

        const events = await received;
        expect(events.map((event) => event.id)).toEqual([1, 2]);
        expect(events.map((event) => event.event)).toEqual([
          "turn.started",
          "assistant.text.delta",
        ]);
        expect(events[1]?.data).toMatchObject({
          sessionId: assigned.assignedSession.sessionId,
          seq: 2,
          payload: { text: "cross-replica" },
        });
      } finally {
        abort.abort();
        await secondApplication?.close();
        await secondNotifications.stop();
      }
    },
    10_000,
  );

  it.skipIf(process.env.AGENT_DOCK_DOCKER_SANDBOX_TEST !== "1")(
    "persists and streams a fenced Java repair produced inside the Docker Pi sandbox",
    async () => {
      const checkpointRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-docker-checkpoints-"));
      const sessionResponse = await http.inject({
        method: "POST",
        url: `/v1/projects/${project.projectId}/sessions`,
        payload: { workspaceId: project.workspaceId },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const dockerSession = sessionResponse.json() as SessionResource;
      const turnResponse = await http.inject({
        method: "POST",
        url: `/v1/sessions/${dockerSession.sessionId}/turns`,
        headers: { "idempotency-key": "docker-java-repair" },
        payload: { prompt: "Run the tests, repair the Java bug, and verify the result." },
      });
      expect(turnResponse.statusCode).toBe(202);
      const accepted = turnResponse.json() as AcceptedTurnResource;

      await database
        .insertInto("sandboxes")
        .values({
          id: IDS.dockerSandbox,
          supervisor_id: "local-docker-sandbox-test",
          boot_id: IDS.dockerSandboxBoot,
          state: "ready",
          max_concurrent_sessions: 1,
          active_sessions: 0,
        })
        .executeTakeFirstOrThrow();

      const published: EventPublishMessage[] = [];
      const persistedBeforeAck: number[] = [];
      let containerName: string | undefined;
      const leaseCoordinator = new SessionLeaseCoordinator({
        database,
        sandboxId: IDS.dockerSandbox,
        leaseDurationMs: 120_000,
      });
      const checkpointStore = new PostgresSandboxCheckpointStore({
        database,
        objectStore: new FileCheckpointObjectStore({ rootDirectory: checkpointRoot }),
      });
      const runner = new DockerSandboxTurnRunner({
        image: process.env.AGENT_DOCK_DOCKER_IMAGE ?? "agent-dock/pi-workspace:phase2",
        runtimeIdentity: {
          supervisorId: "local-docker-sandbox-test",
          bootId: IDS.dockerSandboxBoot,
          sandboxId: IDS.dockerSandbox,
        },
        dockerCommand: process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker",
        scenario: ({ restoring }) => (restoring ? "java_followup" : "java_repair"),
        checkpointStore,
        executionTimeoutMs: 60_000,
        onContainerReady(identity) {
          containerName = identity.containerName;
        },
      });
      const supervisor = new LocalSandboxSupervisor({ runner, maxConcurrentSessions: 1 });
      const backend = new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: {
          async ingest(value) {
            const message = parseSupervisorToControlMessage(value);
            if (message.type !== "event.publish") throw new Error("Expected event publication");
            const acknowledgement = await durableEventStore.ingest(message);
            const persisted = await database
              .selectFrom("session_events")
              .select(["event_id", "seq"])
              .where("session_id", "=", dockerSession.sessionId)
              .where("seq", "=", String(message.payload.event.seq))
              .executeTakeFirstOrThrow();
            expect(persisted.event_id).toBe(message.payload.event.eventId);
            persistedBeforeAck.push(Number(persisted.seq));
            return acknowledgement;
          },
        },
        onEvent(message) {
          published.push(message);
        },
      });
      const dispatcher = new OutboxDispatcher({
        database,
        tenantId: IDS.tenant,
        backend,
        leaseManager: leaseCoordinator,
      });

      const liveAbort = new AbortController();
      const liveResponse = await fetch(`${baseUrl}/v1/sessions/${dockerSession.sessionId}/events`, {
        signal: liveAbort.signal,
      });
      expect(liveResponse.status).toBe(200);
      const liveEventsPromise = readSseEvents(liveResponse, 10, 60_000);
      try {
        const dispatchResult = await dispatcher.dispatchNext();
        const liveEvents = await liveEventsPromise;
        expect(dispatchResult).toMatchObject({
          status: "completed",
          commandId: accepted.commandId,
          sessionId: dockerSession.sessionId,
          turnId: accepted.turnId,
          attempt: 1,
        });
        const expectedTypes = [
          "turn.started",
          "tool.started",
          "tool.completed",
          "tool.started",
          "tool.completed",
          "tool.started",
          "tool.completed",
          "assistant.text.delta",
          "assistant.text.delta",
          "turn.completed",
        ];
        expect(published.map((message) => message.payload.event.type)).toEqual(expectedTypes);
        expect(published.map((message) => message.payload.event.seq)).toEqual(
          Array.from({ length: 10 }, (_, index) => index + 1),
        );
        expect(persistedBeforeAck).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
        expect(liveEvents.map((event) => event.event)).toEqual(expectedTypes);
        expect(liveEvents.map((event) => event.id)).toEqual(
          Array.from({ length: 10 }, (_, index) => index + 1),
        );

        const terminal = published.at(-1)?.payload.event;
        if (terminal?.type !== "turn.completed") throw new Error("Expected completed Docker turn");
        expect(terminal.payload.workspacePatch).toMatchObject({
          format: "unified_diff",
          truncated: false,
        });
        expect(terminal.payload.workspacePatch?.patch).toContain("-        return left - right;");
        expect(terminal.payload.workspacePatch?.patch).toContain("+        return left + right;");
        expect(liveEvents.at(-1)?.data).toMatchObject({
          type: "turn.completed",
          payload: { workspacePatch: terminal.payload.workspacePatch },
        });

        const durable = await readTurnExecution(accepted);
        expect(durable).toMatchObject({
          commandState: "completed",
          turnState: "completed",
          sessionState: "idle",
          stopReason: "stop",
          attempts: 1,
        });
        const persistedTerminal = await database
          .selectFrom("session_events")
          .select(["seq", "type", "payload"])
          .where("session_id", "=", dockerSession.sessionId)
          .where("seq", "=", "10")
          .executeTakeFirstOrThrow();
        expect(persistedTerminal).toMatchObject({
          seq: "10",
          type: "turn.completed",
          payload: { workspacePatch: terminal.payload.workspacePatch },
        });
        const cursor = await database
          .selectFrom("session_event_cursors")
          .select(["last_persisted_seq", "acknowledged_through_seq"])
          .where("session_id", "=", dockerSession.sessionId)
          .executeTakeFirstOrThrow();
        expect(cursor).toEqual({ last_persisted_seq: "10", acknowledged_through_seq: "10" });
        const leaseCount = await database
          .selectFrom("session_leases")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("session_id", "=", dockerSession.sessionId)
          .executeTakeFirstOrThrow();
        expect(leaseCount.count).toBe("0");
        const sandbox = await database
          .selectFrom("sandboxes")
          .select(["state", "active_sessions"])
          .where("id", "=", IDS.dockerSandbox)
          .executeTakeFirstOrThrow();
        expect(sandbox).toEqual({ state: "ready", active_sessions: 0 });
        expect(containerName).toBeDefined();
        const serialized = JSON.stringify(published);
        expect(serialized).not.toContain(FAKE_MODEL_API_KEY);
        expect(serialized).not.toContain("broker://owner/openai-codex");
        expect(serialized).not.toContain("Run the tests, repair the Java bug");

        const checkpointRows = await database
          .selectFrom("artifacts")
          .select(["kind", "object_key", "sha256", "size_bytes"])
          .where("session_id", "=", dockerSession.sessionId)
          .orderBy("kind")
          .execute();
        expect(checkpointRows.map((row) => row.kind)).toEqual([
          "pi_session_snapshot",
          "workspace_snapshot",
        ]);
        expect(checkpointRows.every((row) => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);

        const followUpResponse = await http.inject({
          method: "POST",
          url: `/v1/sessions/${dockerSession.sessionId}/turns`,
          headers: { "idempotency-key": "docker-java-repair-followup" },
          payload: { prompt: "Verify the previous repair after a cold activation." },
        });
        expect(followUpResponse.statusCode).toBe(202);
        const followUp = followUpResponse.json() as AcceptedTurnResource;
        const followUpDispatch = await dispatcher.dispatchNext();
        expect(followUpDispatch).toMatchObject({
          status: "completed",
          commandId: followUp.commandId,
          sessionId: dockerSession.sessionId,
          turnId: followUp.turnId,
        });
        const followUpEvents = published.slice(10).map((message) => message.payload.event);
        expect(followUpEvents.map((event) => event.seq)).toEqual([11, 12, 13, 14, 15, 16]);
        expect(
          followUpEvents
            .filter((event) => event.type === "tool.started")
            .map((event) => event.payload.toolName),
        ).toEqual(["bash"]);
        expect(followUpEvents.find((event) => event.type === "tool.completed")).toMatchObject({
          payload: { isError: false },
        });
        expect(
          followUpEvents
            .filter((event) => event.type === "assistant.text.delta")
            .map((event) => event.payload.text)
            .join(""),
        ).toContain("Prior conversation and Java repair restored");
        const followUpTerminal = followUpEvents.at(-1);
        expect(followUpTerminal?.type).toBe("turn.completed");
        if (followUpTerminal?.type !== "turn.completed") {
          throw new Error("Expected completed Docker follow-up turn");
        }
        expect(followUpTerminal.payload.workspacePatch?.patch).toContain(
          "+        return left + right;",
        );
        expect(
          await database
            .selectFrom("artifacts")
            .select((expression) => expression.fn.countAll<string>().as("count"))
            .where("session_id", "=", dockerSession.sessionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ count: "4" });
        expect(
          await database
            .selectFrom("session_event_cursors")
            .select(["last_persisted_seq", "acknowledged_through_seq"])
            .where("session_id", "=", dockerSession.sessionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ last_persisted_seq: "16", acknowledged_through_seq: "16" });
      } finally {
        liveAbort.abort();
        await rm(checkpointRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it("durably cancels a live Pi turn through an independent fenced dispatcher", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const cancellationSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${cancellationSession.sessionId}/turns`,
      headers: { "idempotency-key": "live-pi-cancellation-target" },
      payload: { prompt: "Wait until this turn is cancelled." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;

    await database
      .insertInto("sandboxes")
      .values({
        id: IDS.cancellationSandbox,
        supervisor_id: "local-pi-rpc-cancellation-test",
        boot_id: IDS.cancellationSandboxBoot,
        state: "ready",
        max_concurrent_sessions: 1,
        active_sessions: 0,
      })
      .executeTakeFirstOrThrow();

    const fakeModel = new FakeModelServer({ defaultScenario: "timeout" });
    const workspaceDirectory = await mkdtemp(resolve(tmpdir(), "agent-dock-cancel-workspace-"));
    const events: EventPublishMessage[] = [];
    let rejectedLateCompletion = false;
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.cancellationSandbox,
      leaseDurationMs: 120_000,
    });
    try {
      await fakeModel.start();
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspaceDirectory,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
          reasoning: false,
        }),
        turnTimeoutMs: 20_000,
      });
      const supervisor = new LocalSandboxSupervisor({ runner, maxConcurrentSessions: 1 });
      const backend = new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: {
          async ingest(value) {
            const message = parseSupervisorToControlMessage(value);
            if (
              message.type === "event.publish" &&
              message.payload.event.type === "turn.cancelled"
            ) {
              await expect(
                durableEventStore.ingest({
                  ...message,
                  messageId: globalThis.crypto.randomUUID(),
                  payload: {
                    ...message.payload,
                    event: {
                      ...message.payload.event,
                      eventId: globalThis.crypto.randomUUID(),
                      type: "turn.completed",
                      payload: { stopReason: "late_completion" },
                    },
                  },
                }),
              ).rejects.toMatchObject({ code: "invalid_event" });
              rejectedLateCompletion = true;
            }
            return durableEventStore.ingest(message);
          },
        },
        onEvent(message) {
          events.push(message);
        },
      });
      const executionDispatcher = new OutboxDispatcher({
        database,
        tenantId: IDS.tenant,
        backend,
        leaseManager: leaseCoordinator,
      });
      const cancellationDispatcher = new CancellationDispatcher({
        database,
        tenantId: IDS.tenant,
        backend,
        leaseManager: leaseCoordinator,
      });

      const liveAbort = new AbortController();
      const liveResponse = await fetch(
        `${baseUrl}/v1/sessions/${cancellationSession.sessionId}/events`,
        { signal: liveAbort.signal },
      );
      expect(liveResponse.status).toBe(200);
      const liveEventsPromise = readSseEvents(liveResponse, 2);
      const execution = executionDispatcher.dispatchNext();
      void execution.catch(() => undefined);
      await waitForCondition(async () => {
        const lifecycle = await readTurnExecution(accepted);
        return (
          lifecycle.commandState === "acknowledged" &&
          lifecycle.turnState === "running" &&
          lifecycle.sessionState === "running" &&
          fakeModel.activeRequests === 1
        );
      });

      const cancellationResponse = await http.inject({
        method: "POST",
        url: `/v1/sessions/${cancellationSession.sessionId}/turns/${accepted.turnId}/cancellations`,
        headers: { "idempotency-key": "cancel-live-pi-turn" },
        payload: { gracePeriodMs: 2_000 },
      });
      expect(cancellationResponse.statusCode).toBe(202);
      const cancellation = cancellationResponse.json() as AcceptedTurnCancellationResource;
      expect(cancellation).toMatchObject({
        targetCommandId: accepted.commandId,
        sessionId: cancellationSession.sessionId,
        turnId: accepted.turnId,
        state: "pending",
        replayed: false,
      });

      const durableIntent = await database
        .selectFrom("commands as cancellation")
        .innerJoin("outbox", (join) =>
          join
            .onRef("outbox.tenant_id", "=", "cancellation.tenant_id")
            .on(
              sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${cancellation.commandId}`,
            ),
        )
        .select([
          "cancellation.kind as kind",
          "cancellation.state as commandState",
          "cancellation.payload as commandPayload",
          "outbox.topic as topic",
          "outbox.payload as outboxPayload",
          "outbox.published_at as publishedAt",
        ])
        .where("cancellation.id", "=", cancellation.commandId)
        .executeTakeFirstOrThrow();
      expect(durableIntent).toMatchObject({
        kind: "turn.cancel",
        commandState: "pending",
        commandPayload: {
          schemaVersion: 1,
          targetCommandId: accepted.commandId,
          reason: "user_request",
          gracePeriodMs: 2_000,
        },
        topic: "control.command.cancel.pending.v1",
        outboxPayload: {
          schemaVersion: 1,
          commandId: cancellation.commandId,
          targetCommandId: accepted.commandId,
          sessionId: cancellationSession.sessionId,
          turnId: accepted.turnId,
          kind: "turn.cancel",
        },
        publishedAt: null,
      });
      expect(JSON.stringify(durableIntent)).not.toContain("Wait until this turn is cancelled.");

      const replayResponse = await http.inject({
        method: "POST",
        url: `/v1/sessions/${cancellationSession.sessionId}/turns/${accepted.turnId}/cancellations`,
        headers: { "idempotency-key": "cancel-live-pi-turn" },
        payload: { gracePeriodMs: 2_000 },
      });
      expect(replayResponse.statusCode).toBe(202);
      expect(replayResponse.json()).toMatchObject({
        commandId: cancellation.commandId,
        replayed: true,
      });
      const changedReplay = await http.inject({
        method: "POST",
        url: `/v1/sessions/${cancellationSession.sessionId}/turns/${accepted.turnId}/cancellations`,
        headers: { "idempotency-key": "cancel-live-pi-turn" },
        payload: { gracePeriodMs: 1 },
      });
      expect(changedReplay.statusCode).toBe(409);
      const competingCancellation = await http.inject({
        method: "POST",
        url: `/v1/sessions/${cancellationSession.sessionId}/turns/${accepted.turnId}/cancellations`,
        headers: { "idempotency-key": "competing-live-pi-cancel" },
        payload: {},
      });
      expect(competingCancellation.statusCode).toBe(409);

      const cancellationDispatch = cancellationDispatcher.dispatchNext();
      const [cancellationResult, executionResult, liveEvents] = await Promise.all([
        cancellationDispatch,
        execution,
        liveEventsPromise,
      ]);
      liveAbort.abort();
      expect(cancellationResult).toMatchObject({
        status: "cancelled",
        commandId: cancellation.commandId,
        targetCommandId: accepted.commandId,
        sessionId: cancellationSession.sessionId,
        turnId: accepted.turnId,
        attempt: 1,
        forced: false,
      });
      expect(["cancellation_pending", "cancelled"]).toContain(executionResult.status);
      expect(liveEvents.map((event) => event.event)).toEqual(["turn.started", "turn.cancelled"]);
      expect(liveEvents.map((event) => event.id)).toEqual([1, 2]);
      expect(liveEvents[1]?.data).toMatchObject({
        type: "turn.cancelled",
        payload: { reason: "user_request", forced: false },
      });

      const executionState = await readTurnExecution(accepted);
      expect(executionState).toMatchObject({
        commandState: "completed",
        turnState: "cancelled",
        sessionState: "idle",
        stopReason: "cancelled",
        attempts: 1,
      });
      const cancellationState = await database
        .selectFrom("commands as cancellation")
        .innerJoin("outbox", (join) =>
          join
            .onRef("outbox.tenant_id", "=", "cancellation.tenant_id")
            .on(
              sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${cancellation.commandId}`,
            ),
        )
        .select([
          "cancellation.state as commandState",
          "cancellation.acknowledged_at as acknowledgedAt",
          "cancellation.completed_at as completedAt",
          "outbox.attempts as attempts",
          "outbox.published_at as publishedAt",
        ])
        .where("cancellation.id", "=", cancellation.commandId)
        .executeTakeFirstOrThrow();
      expect(cancellationState).toMatchObject({
        commandState: "completed",
        attempts: 1,
      });
      expect(cancellationState.acknowledgedAt).not.toBeNull();
      expect(cancellationState.completedAt).not.toBeNull();
      expect(cancellationState.publishedAt).not.toBeNull();
      expect(events.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "turn.cancelled",
      ]);
      expect(rejectedLateCompletion).toBe(true);
      expect(events.every((message) => message.payload.commandId === accepted.commandId)).toBe(
        true,
      );
      await waitForCondition(() => fakeModel.observations[0]?.completion === "client_aborted");
      expect(fakeModel.observations[0]).toMatchObject({ completion: "client_aborted" });

      const leaseCount = await database
        .selectFrom("session_leases")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("session_id", "=", cancellationSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(leaseCount.count).toBe("0");
      const sandbox = await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.cancellationSandbox)
        .executeTakeFirstOrThrow();
      expect(sandbox).toEqual({ state: "ready", active_sessions: 0 });

      const replayAfterSettlement = await http.inject({
        method: "POST",
        url: `/v1/sessions/${cancellationSession.sessionId}/turns/${accepted.turnId}/cancellations`,
        headers: { "idempotency-key": "cancel-live-pi-turn" },
        payload: { gracePeriodMs: 2_000 },
      });
      expect(replayAfterSettlement.statusCode).toBe(202);
      expect(replayAfterSettlement.json()).toMatchObject({
        commandId: cancellation.commandId,
        replayed: true,
      });
    } finally {
      await fakeModel.stop();
      await rm(workspaceDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("releases the fenced lease after a post-ACK supervisor failure", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const failedSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${failedSession.sessionId}/turns`,
      headers: { "idempotency-key": "fenced-post-ack-failure" },
      payload: { prompt: "Exercise fenced failure cleanup." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.sandbox,
      leaseDurationMs: 120_000,
    });
    const supervisor = new LocalSandboxSupervisor({
      runner: {
        async run() {
          throw new PiRpcTurnError("model_timeout", "Model request timed out", true);
        },
      },
    });
    const backend = new LocalSupervisorExecutionBackend({
      supervisor,
      leaseCoordinator,
      eventIngestor: durableEventStore,
    });
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend,
      leaseManager: leaseCoordinator,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      sessionId: failedSession.sessionId,
      turnId: accepted.turnId,
      attempt: 1,
      phase: "after_start",
      failureCode: "model_timeout",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      turnState: "failed",
      sessionState: "idle",
      turnFailureCode: "model_timeout",
      failureMessage: "Model request timed out",
      failureRetryable: true,
      attempts: 1,
    });
    const leaseCount = await database
      .selectFrom("session_leases")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("session_id", "=", failedSession.sessionId)
      .executeTakeFirstOrThrow();
    expect(leaseCount.count).toBe("0");
    const sandbox = await database
      .selectFrom("sandboxes")
      .select(["state", "active_sessions"])
      .where("id", "=", IDS.sandbox)
      .executeTakeFirstOrThrow();
    expect(sandbox).toEqual({ state: "ready", active_sessions: 0 });
  });

  it("renews a running assignment beyond its initial lease deadline", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const longSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${longSession.sessionId}/turns`,
      headers: { "idempotency-key": "heartbeat-renews-long-turn" },
      payload: { prompt: "Remain active across several lease periods." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;
    let releaseRunner: (() => void) | undefined;
    const runnerGate = new Promise<void>((resolvePromise) => {
      releaseRunner = resolvePromise;
    });
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.sandbox,
      leaseDurationMs: 90,
    });
    const supervisor = new LocalSandboxSupervisor({
      runner: {
        async run() {
          await runnerGate;
          return { stopReason: "long_turn_completed" };
        },
      },
    });
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        heartbeatIntervalMs: 20,
      }),
      leaseManager: leaseCoordinator,
    });

    const dispatch = dispatcher.dispatchNext();
    await waitForCondition(async () => {
      const row = await database
        .selectFrom("session_leases")
        .select("session_id")
        .where("session_id", "=", longSession.sessionId)
        .executeTakeFirst();
      return row !== undefined;
    });
    const initialLease = await database
      .selectFrom("session_leases")
      .select(["acquired_at", "renewed_at", "valid_until"])
      .where("session_id", "=", longSession.sessionId)
      .executeTakeFirstOrThrow();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 180));
    const renewedLease = await database
      .selectFrom("session_leases")
      .select(["renewed_at", "valid_until"])
      .where("session_id", "=", longSession.sessionId)
      .executeTakeFirstOrThrow();
    expect(new Date(renewedLease.renewed_at).valueOf()).toBeGreaterThan(
      new Date(initialLease.renewed_at).valueOf(),
    );
    expect(new Date(renewedLease.valid_until).valueOf()).toBeGreaterThan(
      new Date(initialLease.valid_until).valueOf(),
    );
    expect(new Date(renewedLease.valid_until).valueOf()).toBeGreaterThan(Date.now());

    releaseRunner?.();
    await expect(dispatch).resolves.toMatchObject({
      status: "completed",
      commandId: accepted.commandId,
      sessionId: longSession.sessionId,
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "completed",
      turnState: "completed",
      sessionState: "idle",
      stopReason: "long_turn_completed",
    });
  });

  it("never revives an expired lease and quarantines the stopped session", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const expiredSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${expiredSession.sessionId}/turns`,
      headers: { "idempotency-key": "heartbeat-rejects-expired-lease" },
      payload: { prompt: "Let this deliberately short lease expire." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.sandbox,
      leaseDurationMs: 60,
    });
    const supervisor = new LocalSandboxSupervisor({
      runner: {
        async run(_command, _publishEvent, signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const reason = signal.reason as { reason: "lease_revoked" };
                reject(new PiRpcTurnCancelledError(reason.reason, false));
              },
              { once: true },
            );
          });
        },
      },
    });
    const dispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        heartbeatIntervalMs: 120,
      }),
      leaseManager: leaseCoordinator,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      sessionId: expiredSession.sessionId,
      turnId: accepted.turnId,
      phase: "after_start",
      failureCode: "lease_renewal_failed",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      turnState: "failed",
      sessionState: "failed",
      turnFailureCode: "lease_renewal_failed",
      failureRetryable: false,
    });
    expect(supervisor.activeSessionCount).toBe(0);
    expect(
      await database
        .selectFrom("session_leases")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("session_id", "=", expiredSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
  });

  it("terminates expired and orphan runtimes before settling a lost assignment", async () => {
    const fixture = await createAssignedTurn({
      sandboxId: IDS.reconciliationSandbox,
      sandboxBootId: IDS.reconciliationSandboxBoot,
      supervisorId: "reconciliation-supervisor",
      phase: "acknowledged",
      expired: true,
    });
    const orphan: SandboxRuntimeAssignment = {
      ...fixture.runtime,
      runtimeId: "orphan-runtime",
      runtimeName: "orphan-runtime",
      commandId: globalThis.crypto.randomUUID(),
      sessionId: globalThis.crypto.randomUUID(),
      turnId: globalThis.crypto.randomUUID(),
      leaseId: globalThis.crypto.randomUUID(),
      fencingToken: 9,
    };
    const inventory = new MemoryAssignmentInventory([fixture.runtime, orphan]);
    const reconciler = new AssignmentReconciler({
      database,
      sandboxId: IDS.reconciliationSandbox,
      inventory,
    });

    await expect(reconciler.reconcileExpiredAssignments()).resolves.toEqual({
      inspectedRuntimes: 2,
      terminatedRuntimes: 2,
      orphanRuntimes: 1,
      settledAssignments: 1,
      requeuedAssignments: 0,
    });
    expect(inventory.assignments).toHaveLength(0);
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "failed",
      commandFailureCode: "assignment_lost",
      turnState: "failed",
      turnFailureCode: "assignment_lost",
      failureRetryable: false,
      sessionState: "failed",
    });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.reconciliationSandbox)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "ready", active_sessions: 0 });
  });

  it("requeues a confirmed-absent assignment that never reached durable ACK", async () => {
    const fixture = await createAssignedTurn({
      sandboxId: IDS.requeueSandbox,
      sandboxBootId: IDS.requeueSandboxBoot,
      supervisorId: "requeue-supervisor",
      phase: "dispatched",
      expired: true,
    });
    const inventory = new MemoryAssignmentInventory([fixture.runtime]);
    const reconciler = new AssignmentReconciler({
      database,
      sandboxId: IDS.requeueSandbox,
      inventory,
    });

    await expect(reconciler.reconcileExpiredAssignments()).resolves.toMatchObject({
      terminatedRuntimes: 1,
      settledAssignments: 0,
      requeuedAssignments: 1,
    });
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "pending",
      turnState: "queued",
      sessionState: "cold",
      publishedAt: null,
      lastError: "assignment_lost",
    });
    expect(
      await database
        .selectFrom("session_leases")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("session_id", "=", fixture.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const retryDispatcher = new OutboxDispatcher({
      database,
      tenantId: IDS.tenant,
      backend: new DeterministicExecutionBackend(),
    });
    await expect(retryDispatcher.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      commandId: fixture.accepted.commandId,
    });
  });

  it("fails closed when runtime termination is unconfirmed, then converges on retry", async () => {
    const fixture = await createAssignedTurn({
      sandboxId: IDS.failedReconciliationSandbox,
      sandboxBootId: IDS.failedReconciliationSandboxBoot,
      supervisorId: "failed-reconciliation-supervisor",
      phase: "acknowledged",
      expired: true,
    });
    const inventory = new MemoryAssignmentInventory([fixture.runtime]);
    inventory.failTermination = true;
    const reconciler = new AssignmentReconciler({
      database,
      sandboxId: IDS.failedReconciliationSandbox,
      inventory,
    });

    await expect(reconciler.reconcileExpiredAssignments()).rejects.toMatchObject({
      code: "assignment_reconciliation_failed",
      retryable: true,
    });
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "acknowledged",
      turnState: "running",
      sessionState: "running",
    });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.failedReconciliationSandbox)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed", active_sessions: 1 });

    inventory.failTermination = false;
    await expect(reconciler.reconcileExpiredAssignments()).resolves.toMatchObject({
      terminatedRuntimes: 1,
      settledAssignments: 1,
    });
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "failed",
      turnState: "failed",
      sessionState: "failed",
    });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.failedReconciliationSandbox)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed", active_sessions: 0 });
  });

  it("drains and retires an old supervisor sandbox without adopting its live runtime", async () => {
    const fixture = await createAssignedTurn({
      sandboxId: IDS.retirementSandbox,
      sandboxBootId: IDS.retirementSandboxBoot,
      supervisorId: "retirement-supervisor",
      phase: "acknowledged",
      expired: false,
    });
    const inventory = new MemoryAssignmentInventory([fixture.runtime]);
    const reconciler = new AssignmentReconciler({
      database,
      sandboxId: IDS.retirementSandbox,
      inventory,
    });

    await expect(reconciler.retireSandbox()).resolves.toMatchObject({
      sandboxState: "terminated",
      terminatedRuntimes: 1,
      settledAssignments: 1,
    });
    expect(inventory.assignments).toHaveLength(0);
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "failed",
      commandFailureCode: "assignment_lost",
      turnState: "failed",
      sessionState: "failed",
    });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions", "terminated_at"])
        .where("id", "=", IDS.retirementSandbox)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "terminated", active_sessions: 0 });
    await expect(reconciler.retireSandbox()).resolves.toEqual({
      inspectedRuntimes: 0,
      terminatedRuntimes: 0,
      orphanRuntimes: 0,
      settledAssignments: 0,
      requeuedAssignments: 0,
      sandboxState: "terminated",
    });
  });

  it("quarantines a conflicting runtime boot without guessing its ownership", async () => {
    const fixture = await createAssignedTurn({
      sandboxId: IDS.mismatchedRuntimeSandbox,
      sandboxBootId: IDS.mismatchedRuntimeSandboxBoot,
      supervisorId: "mismatched-runtime-supervisor",
      phase: "acknowledged",
      expired: true,
    });
    const inventory = new MemoryAssignmentInventory([
      {
        ...fixture.runtime,
        bootId: "60000000-0000-4000-8000-000000000099",
      },
    ]);
    const reconciler = new AssignmentReconciler({
      database,
      sandboxId: IDS.mismatchedRuntimeSandbox,
      inventory,
    });

    await expect(reconciler.reconcileExpiredAssignments()).rejects.toMatchObject({
      code: "runtime_identity_mismatch",
      retryable: false,
    });
    expect(inventory.terminated).toHaveLength(0);
    expect(await readTurnExecution(fixture.accepted)).toMatchObject({
      commandState: "acknowledged",
      turnState: "running",
      sessionState: "running",
    });
    expect(
      await database
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", IDS.mismatchedRuntimeSandbox)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "failed", active_sessions: 1 });
  });

  it("replays an ACK-lost event from a fresh supervisor spool without duplicating PostgreSQL", async () => {
    const spoolRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-durable-event-spool-"));
    try {
      const sessionResponse = await http.inject({
        method: "POST",
        url: `/v1/projects/${project.projectId}/sessions`,
        payload: { workspaceId: project.workspaceId },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const replaySession = sessionResponse.json() as SessionResource;
      const turnResponse = await http.inject({
        method: "POST",
        url: `/v1/sessions/${replaySession.sessionId}/turns`,
        headers: { "idempotency-key": "durable-spool-ack-loss" },
        payload: { prompt: "Publish one event, then lose its ACK." },
      });
      expect(turnResponse.statusCode).toBe(202);
      const accepted = turnResponse.json() as AcceptedTurnResource;
      await database
        .insertInto("sandboxes")
        .values({
          id: IDS.spoolSandbox,
          supervisor_id: "local-durable-spool-test",
          boot_id: IDS.spoolSandboxBoot,
          state: "ready",
          max_concurrent_sessions: 1,
          active_sessions: 0,
        })
        .executeTakeFirstOrThrow();

      const leaseCoordinator = new SessionLeaseCoordinator({
        database,
        sandboxId: IDS.spoolSandbox,
        leaseDurationMs: 120_000,
      });
      const firstStore = new FileEventSpoolStore({ rootDirectory: spoolRoot });
      const supervisor = new LocalSandboxSupervisor({
        runner: {
          async run(command, publishEvent) {
            const event: EventPublishMessage = {
              protocolVersion: 1,
              messageId: globalThis.crypto.randomUUID(),
              sentAt: new Date().toISOString(),
              type: "event.publish",
              payload: {
                commandId: command.payload.commandId,
                leaseId: command.payload.leaseId,
                fencingToken: command.payload.fencingToken,
                event: {
                  schemaVersion: 1,
                  eventId: globalThis.crypto.randomUUID(),
                  sessionId: command.payload.sessionId,
                  turnId: command.payload.turnId,
                  agentId: command.payload.agentId,
                  seq: command.payload.nextEventSeq,
                  occurredAt: new Date().toISOString(),
                  type: "turn.started",
                  payload: { inputKind: command.payload.input.kind },
                },
              },
            };
            await publishEvent(event);
            return { stopReason: "stop" };
          },
        },
        eventSpoolFactory: (options) => firstStore.open(options),
      });
      const backend = new LocalSupervisorExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        onEvent() {
          throw new Error("simulated ACK connection loss after PostgreSQL commit");
        },
      });
      const dispatcher = new OutboxDispatcher({
        database,
        tenantId: IDS.tenant,
        backend,
        leaseManager: leaseCoordinator,
      });

      await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
        status: "failed",
        commandId: accepted.commandId,
        phase: "after_start",
        failureCode: "local_supervisor_error",
      });
      const persistedBeforeReplay = await database
        .selectFrom("session_events")
        .select(["event_id", "seq", "type"])
        .where("session_id", "=", replaySession.sessionId)
        .execute();
      expect(persistedBeforeReplay).toHaveLength(1);
      expect(persistedBeforeReplay[0]).toMatchObject({ seq: "1", type: "turn.started" });

      const restartedStore = new FileEventSpoolStore({ rootDirectory: spoolRoot });
      const restartedSupervisor = new LocalSandboxSupervisor({
        runner: {
          async run() {
            throw new Error("Recovery must not start a new runner");
          },
        },
        eventSpoolFactory: (options) => restartedStore.open(options),
        eventSpoolRecovery: restartedStore,
      });
      await expect(
        restartedSupervisor.recoverPendingEvents((message) => durableEventStore.ingest(message)),
      ).resolves.toEqual({ scannedSpools: 1, replayedSpools: 1, replayedEvents: 1 });
      expect(
        await database
          .selectFrom("session_events")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("session_id", "=", replaySession.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "1" });
      await expect(
        new FileEventSpoolStore({ rootDirectory: spoolRoot }).redeliverPending(() => {
          throw new Error("A drained spool must not publish");
        }),
      ).resolves.toEqual({ scannedSpools: 1, replayedSpools: 0, replayedEvents: 0 });
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });

  it("rolls back the turn and command if the outbox write fails", async () => {
    const mailboxBeforeFailure = await database
      .selectFrom("sessions")
      .select("next_mailbox_position")
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
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
    const mailboxAfterFailure = await database
      .selectFrom("sessions")
      .select("next_mailbox_position")
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(turnCount.count).toBe("0");
    expect(commandCount.count).toBe("0");
    expect(mailboxAfterFailure).toEqual(mailboxBeforeFailure);
  });
});
