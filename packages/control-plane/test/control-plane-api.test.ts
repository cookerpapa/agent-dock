import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type {
  AcceptedTurnResource,
  AcceptedTurnCancellationResource,
  ConversationDetailResource,
  ControlPlaneApiError,
  EventPublishBatchMessage,
  EventPublishMessage,
  ProjectResource,
  SessionResource,
} from "@pi-cloud/protocol";
import { parseControlToSupervisorMessage } from "@pi-cloud/protocol";
import {
  WalEventSpoolStore,
  AgentRunSupervisor,
  PiTurnCancelledError,
  PiTurnError,
  type SandboxAssignmentInventory,
  type SandboxRuntimeAssignment,
} from "@pi-cloud/sandbox-supervisor";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, TableNode, type Kysely, type KyselyPlugin } from "kysely";
import {
  RunCancellationExecutor,
  AssignmentReconciler,
  DeterministicExecutionBackend,
  DurableEventStore,
  AgentRunExecutionBackend,
  RunCommandExecutor,
  RunCommandExecutorStaleClaimError,
  TurnExecutionCancelledError,
  PostgresSessionEventNotifications,
  PostgresRunAttemptPhaseObserver,
  SessionLeaseCoordinator,
  TurnCancellationBackendError,
  type TurnCancellationBackend,
  type TurnExecutionBackend,
  type TurnExecutionLeaseManager,
  createControlPlaneApplication,
} from "../src/index.ts";
import { dispatchNextTestCommand } from "./dispatch-next-test-command.ts";
import type { WorkerEventLogBatch } from "@pi-cloud/runtime-core/worker-event-log";
import { commitTerminalTurnEvent } from "@pi-cloud/runtime-core/terminal-turn-event";
import { MemoryLiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import { LiveTerminalTurnProjectionSource } from "@pi-cloud/runtime-core/terminal-turn-projection";

const IDS = {
  tenant: "00000000-0000-4000-8000-000000000001",
  credential: "30000000-0000-4000-8000-000000000001",
  profile: "40000000-0000-4000-8000-000000000001",
  sandbox: "50000000-0000-4000-8000-000000000001",
  sandboxBoot: "60000000-0000-4000-8000-000000000001",
  phaseSandbox: "50000000-0000-4000-8000-000000000012",
  phaseSandboxBoot: "60000000-0000-4000-8000-000000000012",
  cancellationSandbox: "50000000-0000-4000-8000-000000000002",
  cancellationSandboxBoot: "60000000-0000-4000-8000-000000000002",
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
  batchSandbox: "50000000-0000-4000-8000-000000000013",
  batchSandboxBoot: "60000000-0000-4000-8000-000000000013",
  externalEventSandbox: "50000000-0000-4000-8000-000000000014",
  externalEventSandboxBoot: "60000000-0000-4000-8000-000000000014",
  heartbeatSandbox: "50000000-0000-4000-8000-000000000015",
  heartbeatSandboxBoot: "60000000-0000-4000-8000-000000000015",
  expiredLeaseSandbox: "50000000-0000-4000-8000-000000000016",
  expiredLeaseSandboxBoot: "60000000-0000-4000-8000-000000000016",
};

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;
let databaseConnectionString: string;
let application: NestFastifyApplication;
let http: FastifyInstance;
let durableEventStore: DurableEventStore;
let project: ProjectResource;
let session: SessionResource;
let firstAccepted: AcceptedTurnResource;
let sessionEventNotifications: PostgresSessionEventNotifications | undefined;

// Heartbeat, settlement and assertion queries intentionally overlap. Keeping
// only two PGLite socket slots intermittently interleaves PostgreSQL protocol
// frames under this load, so the fixture must admit the same bounded
// concurrency that the test exercises.
const PGLITE_CONNECTION_LIMIT = 8;

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
    .insertInto("users")
    .values({ id: IDS.tenant, tenant_id: IDS.tenant, display_name: "Development Operator" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "pi-cloud-fake",
      kind: "brokered",
      secret_ref: "broker://test/pi-cloud-fake",
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
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off", "low"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: IDS.tenant,
      default_model_profile_id: IDS.profile,
      maximum_projects: 10_000,
      maximum_sessions: 10_000,
      maximum_unsettled_turns: 10_000,
      maximum_concurrent_turns: 256,
    })
    .executeTakeFirstOrThrow();
}

async function createReadySandbox(options: {
  id: string;
  bootId: string;
  supervisorId: string;
}): Promise<void> {
  await database
    .insertInto("sandboxes")
    .values({
      id: options.id,
      supervisor_id: options.supervisorId,
      boot_id: options.bootId,
      state: "ready",
      max_concurrent_sessions: 1,
      active_sessions: 0,
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

async function dispatchClaimableWork(dispatcher: RunCommandExecutor) {
  const deadline = Date.now() + 2_000;
  do {
    const result = await dispatchNextTestCommand(database, dispatcher, IDS.tenant);
    if (result.status !== "idle") return result;
    // SKIP LOCKED makes a single poll legitimately idle while another
    // transaction is releasing a Session/policy row. Production pollers retry;
    // this helper retains a hard deadline so a stranded mailbox still fails.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  } while (Date.now() < deadline);
  throw new Error("Durable mailbox work did not become claimable before the deadline");
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
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out reading SSE events after ${events.length}/${count}: ${events
              .map((event) => event.event)
              .join(", ")}`,
          ),
        ),
      timeoutMs,
    );
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
  const projectResponse = await http.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: `runtime-${options.sandboxId}` },
  });
  expect(projectResponse.statusCode).toBe(201);
  const isolatedProject = projectResponse.json() as ProjectResource;
  const sessionResponse = await http.inject({
    method: "POST",
    url: `/v1/projects/${isolatedProject.projectId}/sessions`,
    payload: { workspaceId: isolatedProject.workspaceId, title: "Test conversation" },
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
  const attemptId = globalThis.crypto.randomUUID();
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
      .insertInto("run_attempts")
      .values({
        id: attemptId,
        tenant_id: IDS.tenant,
        run_id: accepted.runId,
        attempt_number: 1,
        state: options.phase === "acknowledged" ? "running" : "claimed",
        claim_owner_id: "reconciliation-test",
        claim_expires_at: validUntil,
        sandbox_id: options.sandboxId,
        lease_id: leaseId,
        fencing_token: 1,
        checkpoint_revision: null,
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        claimed_at: acquiredAt,
        provisioning_at: options.phase === "acknowledged" ? now : null,
        restoring_at: null,
        running_at: options.phase === "acknowledged" ? now : null,
        checkpointing_at: null,
        last_heartbeat_at: acquiredAt,
        settled_at: null,
        created_at: acquiredAt,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("run_attempt_transitions")
      .values({
        id: globalThis.crypto.randomUUID(),
        tenant_id: IDS.tenant,
        run_id: accepted.runId,
        attempt_id: attemptId,
        from_state: null,
        to_state: options.phase === "acknowledged" ? "running" : "claimed",
        reason: "reconciliation_test_seed",
        occurred_at: acquiredAt,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("runs")
      .set({
        state: options.phase === "acknowledged" ? "running" : "claimed",
        current_attempt_id: attemptId,
        attempt_count: 1,
        started_at: options.phase === "acknowledged" ? now : null,
        row_version: sql<string>`${sql.ref("row_version")} + 1`,
        updated_at: now,
      })
      .where("id", "=", accepted.runId)
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
      workspaceId: assignedSession.workspaceId,
      sessionId: assignedSession.sessionId,
      turnId: accepted.turnId,
      leaseId,
      fencingToken: 1,
    },
  };
}

beforeAll(async () => {
  let connectionString = process.env.PI_CLOUD_TEST_DATABASE_URL;
  if (!connectionString) {
    pglite = await PGlite.create();
    socketServer = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: PGLITE_CONNECTION_LIMIT,
    });
    await socketServer.start();
    connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  }
  databaseConnectionString = connectionString;
  database = createDatabase({
    connectionString,
    maxConnections: PGLITE_CONNECTION_LIMIT,
  });
  await runMigrations(database, "up");
  await seedSingleUserProfile();
  if (pglite === undefined) {
    sessionEventNotifications = new PostgresSessionEventNotifications({
      connectionString: databaseConnectionString,
      applicationName: `pi-cloud-api-test-${process.pid}`,
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
      payload: { name: "  Sample Java Repair  ", source: { kind: "sample_java" } },
    });
    expect(projectResponse.statusCode).toBe(201);
    project = projectResponse.json() as ProjectResource;
    expect(project).toMatchObject({
      name: "Sample Java Repair",
      source: { kind: "sample_java", status: "ready" },
    });

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
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    session = sessionResponse.json() as SessionResource;
    expect(session).toMatchObject({
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      title: "Test conversation",
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

  it("persists a public GitHub exact commit as pending source metadata", async () => {
    const commitSha = "a".repeat(40);
    const response = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Pinned public source",
        source: {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const imported = response.json<ProjectResource>();
    expect(imported.source).toEqual({
      kind: "github_public",
      repository: "octocat/hello-world",
      commitSha,
      status: "pending",
    });
    const persisted = await database
      .selectFrom("workspace_sources")
      .select(["kind", "repository", "commit_sha", "status", "object_key"])
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", imported.workspaceId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      kind: "github_public",
      repository: "octocat/hello-world",
      commit_sha: commitSha,
      status: "pending",
      object_key: null,
    });

    const rejectedUrl = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Rejected source",
        source: {
          kind: "github_public",
          repository: "https://github.com/octocat/hello-world",
          commitSha,
        },
      },
    });
    expect(rejectedUrl.statusCode).toBe(400);
    expect(rejectedUrl.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("persists a multi-repository layout and freezes it into the accepted Run", async () => {
    const webCommit = "b".repeat(40);
    const apiCommit = "c".repeat(40);
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Pinned full stack",
        source: {
          kind: "repository_set",
          repositories: [
            {
              root: "web",
              kind: "github_public",
              repository: "octocat/frontend",
              commitSha: webCommit,
            },
            {
              root: "api",
              kind: "github_public",
              repository: "octocat/backend",
              commitSha: apiCommit,
            },
          ],
        },
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const repositoryProject = projectResponse.json<ProjectResource>();
    expect(repositoryProject.source).toEqual({
      kind: "repository_set",
      repositories: [
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: webCommit,
        },
        {
          root: "api",
          kind: "github_public",
          repository: "octocat/backend",
          commitSha: apiCommit,
        },
      ],
      status: "pending",
    });
    const persisted = await database
      .selectFrom("workspace_repository_sources")
      .select(["ordinal", "root_path", "repository", "commit_sha"])
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", repositoryProject.workspaceId)
      .orderBy("ordinal", "asc")
      .execute();
    expect(persisted).toEqual([
      {
        ordinal: 1,
        root_path: "web",
        repository: "octocat/frontend",
        commit_sha: webCommit,
      },
      {
        ordinal: 2,
        root_path: "api",
        repository: "octocat/backend",
        commit_sha: apiCommit,
      },
    ]);

    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${repositoryProject.projectId}/sessions`,
      payload: { workspaceId: repositoryProject.workspaceId, title: "Test conversation" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const repositorySession = sessionResponse.json<SessionResource>();
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${repositorySession.sessionId}/turns`,
      headers: { "idempotency-key": "repository-set-run" },
      payload: { prompt: "Inspect both repositories" },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json<AcceptedTurnResource>();
    const runResponse = await http.inject({
      method: "GET",
      url: `/v1/runs/${accepted.runId}`,
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({
      sourceSet: {
        schemaVersion: 1,
        entries: [
          { root: "api", repository: "octocat/backend", commitSha: apiCommit },
          { root: "web", repository: "octocat/frontend", commitSha: webCommit },
        ],
      },
    });
    // This sequential suite shares one durable queue. The source-set Run is
    // inspected but intentionally not dispatched, so retire only its outbox
    // delivery before later scheduler tests exercise their own commands.
    await database
      .updateTable("outbox")
      .set({ attempts: 1, published_at: new Date() })
      .where("tenant_id", "=", IDS.tenant)
      .where("aggregate_id", "=", repositorySession.sessionId)
      .execute();

    await database
      .insertInto("github_app_installations")
      .values({
        tenant_id: IDS.tenant,
        installation_id: 701,
        account_id: 702,
        account_login: "octocat",
        target_type: "Organization",
        repository_selection: "selected",
        status: "active",
        permissions: { contents: "read" },
      })
      .execute();
    await database
      .insertInto("github_repositories")
      .values({
        tenant_id: IDS.tenant,
        repository_id: 703,
        installation_id: 701,
        full_name: "octocat/frontend",
        owner_login: "octocat",
        name: "frontend",
        private: true,
        default_branch: "main",
        enabled: true,
      })
      .execute();
    const duplicateResolvedRepository = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Ambiguous duplicate source",
        source: {
          kind: "repository_set",
          repositories: [
            {
              root: "public-copy",
              kind: "github_public",
              repository: "octocat/frontend",
              commitSha: webCommit,
            },
            {
              root: "private-copy",
              kind: "github_app",
              installationId: 701,
              repositoryId: 703,
              commitSha: webCommit,
            },
          ],
        },
      },
    });
    expect(duplicateResolvedRepository.statusCode).toBe(400);
    expect(duplicateResolvedRepository.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
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
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
    const queuedRuns = await http.inject({
      method: "GET",
      url: `/v1/sessions/${session.sessionId}/runs`,
    });
    expect(queuedRuns.statusCode).toBe(200);
    expect(queuedRuns.json()).toMatchObject({
      truncated: false,
      runs: [
        {
          runId: firstAccepted.runId,
          turnId: firstAccepted.turnId,
          commandId: firstAccepted.commandId,
          state: "queued",
          attemptCount: 0,
          attempts: [],
        },
      ],
    });
    const queuedRun = await http.inject({
      method: "GET",
      url: `/v1/runs/${firstAccepted.runId}`,
    });
    expect(queuedRun.statusCode).toBe(200);
    expect(queuedRun.json()).toMatchObject({
      runId: firstAccepted.runId,
      state: "queued",
      attemptCount: 0,
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
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
    });

    await expect(dispatcher.dispatchCommand(firstAccepted.commandId)).resolves.toMatchObject({
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
    const firstDispatcher = new RunCommandExecutor({
      database,
      backend,
    });
    const secondDispatcher = new RunCommandExecutor({
      database,
      backend,
    });

    const dispatches = [
      dispatchNextTestCommand(database, firstDispatcher, IDS.tenant),
      dispatchNextTestCommand(database, secondDispatcher, IDS.tenant),
    ];
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
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
    const dispatcher = new RunCommandExecutor({ database, backend });
    const competingDispatcher = new RunCommandExecutor({
      database,
      backend,
    });

    const firstAccepted = await acceptMailboxTurn(1, 1);
    const firstExecution = dispatchNextTestCommand(database, dispatcher, IDS.tenant);
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
    await expect(
      dispatchNextTestCommand(database, competingDispatcher, IDS.tenant),
    ).resolves.toEqual({ status: "idle" });

    releaseFirst();
    await expect(firstExecution).resolves.toMatchObject({
      status: "completed",
      commandId: firstAccepted.resource.commandId,
    });
    for (const expected of accepted.slice(1)) {
      await expect(dispatchClaimableWork(dispatcher)).resolves.toMatchObject({
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
  }, 15_000);

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
    const staleDispatcher = new RunCommandExecutor({
      database,
      backend: staleBackend,
      clock: () => new Date(now),
      claimLeaseMs: 10,
    });

    const staleDispatch = dispatchNextTestCommand(database, staleDispatcher, IDS.tenant);
    const staleOutcome = staleDispatch.then(
      () => undefined,
      (error: unknown) => error,
    );
    await claimed;

    now = new Date(now.valueOf() + 11);
    const currentBackend = new DeterministicExecutionBackend();
    const currentDispatcher = new RunCommandExecutor({
      database,
      backend: currentBackend,
      clock: () => new Date(now),
      claimLeaseMs: 10,
    });
    const currentResult = await dispatchNextTestCommand(database, currentDispatcher, IDS.tenant);
    releaseStaleClaim();
    const staleError = await staleOutcome;

    expect(currentResult).toMatchObject({
      status: "completed",
      commandId: accepted.commandId,
      attempt: 2,
    });
    expect(staleError).toBeInstanceOf(RunCommandExecutorStaleClaimError);
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
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
      clock: () => new Date(now),
    });

    await expect(dispatcher.dispatchCommand(accepted.commandId)).resolves.toMatchObject({
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
    await expect(dispatcher.dispatchCommand(follower.commandId)).resolves.toEqual({
      status: "idle",
    });
    expect(await readTurnExecution(follower)).toMatchObject({
      commandState: "pending",
      turnState: "queued",
      attempts: 0,
      publishedAt: null,
    });

    // The PostgreSQL available_at timestamp owns the retry delay. Once it is
    // reached, the exact original command becomes eligible again.
    now = new Date(now.valueOf() + 11);
    await expect(dispatcher.dispatchCommand(accepted.commandId)).resolves.toMatchObject({
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
    await expect(dispatcher.dispatchCommand(follower.commandId)).resolves.toMatchObject({
      status: "completed",
      commandId: follower.commandId,
      attempt: 1,
    });
    expect(backend.records).toHaveLength(3);
    expect(JSON.stringify(backend.records)).not.toContain("retry without leaking this prompt");
    const runResponse = await http.inject({
      method: "GET",
      url: `/v1/runs/${accepted.runId}`,
    });
    expect(runResponse.statusCode).toBe(200);
    const run = runResponse.json();
    expect(run).toMatchObject({
      runId: accepted.runId,
      state: "completed",
      attemptCount: 2,
      attempts: [
        {
          attemptNumber: 1,
          state: "failed",
          failure: { code: "runner_busy", retryable: true },
        },
        {
          attemptNumber: 2,
          state: "completed",
        },
      ],
    });
    expect(
      run.attempts.map((attempt: { transitions: Array<{ reason: string }> }) =>
        attempt.transitions.map((transition) => transition.reason),
      ),
    ).toEqual([
      ["outbox_claimed", "execution_retry_scheduled"],
      [
        "outbox_claimed",
        "command_acknowledged",
        "backend_settled_without_phase_signal",
        "execution_completed",
      ],
    ]);
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
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
      clock: () => new Date(now),
      maxAttempts: 2,
    });

    await expect(dispatcher.dispatchCommand(accepted.commandId)).resolves.toMatchObject({
      status: "retry_scheduled",
      attempt: 1,
    });
    now = new Date(now.valueOf() + 11);
    await expect(dispatcher.dispatchCommand(accepted.commandId)).resolves.toMatchObject({
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
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
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
    expect(backend.records).toHaveLength(1);

    // A repeated Worker delivery observes the committed terminal
    // state. It must not create another Attempt or invoke the backend again.
    await expect(dispatcher.dispatchCommand(accepted.commandId)).resolves.toEqual({
      status: "idle",
    });
    expect(backend.records).toHaveLength(1);
    expect(await readTurnExecution(accepted)).toMatchObject({ attempts: 1 });
  });

  it("persists trusted Runner phases and the committed checkpoint revision", async () => {
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Durable Run Phase Fixture" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const phaseProject = projectResponse.json() as ProjectResource;
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${phaseProject.projectId}/sessions`,
      payload: { workspaceId: phaseProject.workspaceId, title: "Test conversation" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const phaseSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${phaseSession.sessionId}/turns`,
      headers: { "idempotency-key": "durable-run-phases" },
      payload: { prompt: "Persist every trusted execution phase." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;
    await database
      .insertInto("sandboxes")
      .values({
        id: IDS.phaseSandbox,
        supervisor_id: "durable-phase-test",
        boot_id: IDS.phaseSandboxBoot,
        state: "ready",
        max_concurrent_sessions: 1,
        active_sessions: 0,
      })
      .executeTakeFirstOrThrow();
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: IDS.phaseSandbox,
      leaseDurationMs: 120_000,
    });
    const observer = new PostgresRunAttemptPhaseObserver({ database });
    const revision = "a".repeat(64);
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        const lease = await leaseCoordinator.acquire(request);
        await lifecycle.started(lease);
        const command = parseControlToSupervisorMessage({
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          type: "command.turn.execute",
          payload: {
            commandId: request.commandId,
            idempotencyKey: request.idempotencyKey,
            tenantId: request.tenantId,
            projectId: request.projectId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            runId: request.runId,
            turnId: request.turnId,
            attemptId: request.attemptId,
            agentId: "root",
            leaseId: lease.leaseId,
            fencingToken: lease.fencingToken,
            nextEventSeq: Number(request.nextEventSeq),
            input: { kind: "prompt", text: request.input.prompt },
            sandboxRetention: request.sandboxRetention,
            toolCapabilities: request.toolCapabilities,
            model: {
              ...request.model,
              credentialBindingVersion: Number(request.model.credentialBindingVersion),
            },
            environment: request.environment,
          },
        });
        if (command.type !== "command.turn.execute") throw new Error("Expected execute command");
        await observer.transition(command, "restoring");
        await observer.transition(command, "running");
        await observer.transition(command, "checkpointing");
        await observer.checkpointCommitted(command, revision);
        return { stopReason: "phase_protocol_verified" };
      },
    };
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
      leaseManager: leaseCoordinator,
    });
    const phaseResult = await dispatchNextTestCommand(database, dispatcher, IDS.tenant);
    expect(phaseResult.status, JSON.stringify(phaseResult)).toBe("completed");
    const response = await http.inject({ method: "GET", url: `/v1/runs/${accepted.runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "completed",
      stopReason: "phase_protocol_verified",
      attemptCount: 1,
      attempts: [
        {
          state: "completed",
          checkpointRevision: revision,
          transitions: [
            { fromState: null, toState: "claimed", reason: "outbox_claimed" },
            { fromState: "claimed", toState: "provisioning", reason: "command_acknowledged" },
            { fromState: "provisioning", toState: "restoring", reason: "trusted_runner_restoring" },
            { fromState: "restoring", toState: "running", reason: "trusted_runner_running" },
            {
              fromState: "running",
              toState: "checkpointing",
              reason: "trusted_runner_checkpointing",
            },
            { fromState: "checkpointing", toState: "completed", reason: "execution_completed" },
          ],
        },
      ],
    });
  });

  it("records cancellation as too late when natural completion wins before its ACK", async () => {
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
    const executionDispatcher = new RunCommandExecutor({
      database,
      backend: executionBackend,
    });
    const execution = dispatchNextTestCommand(database, executionDispatcher, IDS.tenant);
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
    const cancellationDispatcher = new RunCancellationExecutor({
      database,
      backend: cancellationBackend,
      leaseManager: unusedLeaseManager,
    });
    await expect(
      cancellationDispatcher.dispatchTargetCommand(accepted.commandId),
    ).resolves.toMatchObject({
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
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
    const executionDispatcher = new RunCommandExecutor({
      database,
      backend: executionBackend,
      leaseManager: retainedLeaseManager,
    });
    const execution = dispatchNextTestCommand(database, executionDispatcher, IDS.tenant);
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
    const cancellationDispatcher = new RunCancellationExecutor({
      database,
      backend: cancellationBackend,
      leaseManager: retainedLeaseManager,
    });

    const [cancellationResult, executionResult] = await Promise.all([
      cancellationDispatcher.dispatchTargetCommand(accepted.commandId),
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

  it("persists a mixed redelivery and new streaming suffix with one set-based write", async () => {
    const assigned = await createAssignedTurn({
      sandboxId: IDS.batchSandbox,
      sandboxBootId: IDS.batchSandboxBoot,
      supervisorId: "batch-ingest-supervisor",
      phase: "acknowledged",
      expired: false,
    });
    const lease = assigned.runtime;
    const occurredAt = new Date().toISOString();
    const events = Array.from({ length: 48 }, (_, index) => ({
      schemaVersion: 1 as const,
      eventId: globalThis.crypto.randomUUID(),
      sessionId: assigned.assignedSession.sessionId,
      turnId: assigned.accepted.turnId,
      agentId: "root",
      seq: index + 1,
      occurredAt,
      type: "assistant.text.delta" as const,
      payload: { text: `chunk-${String(index + 1)} ` },
    }));
    const batch = (selected: typeof events): EventPublishBatchMessage => ({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: occurredAt,
      type: "event.publish_batch",
      payload: {
        commandId: assigned.accepted.commandId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        events: selected,
      },
    });
    await expect(durableEventStore.ingest(batch(events.slice(0, 32)))).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 32 },
    });

    const writes = { events: 0, cursor: 0, session: 0 };
    const countedDatabase = database.withPlugin({
      transformQuery({ node }) {
        if (
          node.kind === "InsertQueryNode" &&
          node.into?.kind === "TableNode" &&
          node.into.table.identifier.name === "session_events"
        ) {
          writes.events += 1;
        }
        const updateTable = node.kind === "UpdateQueryNode" ? node.table : undefined;
        if (updateTable !== undefined && TableNode.is(updateTable)) {
          if (updateTable.table.identifier.name === "session_event_cursors") writes.cursor += 1;
          if (updateTable.table.identifier.name === "sessions") writes.session += 1;
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const countedStore = new DurableEventStore({ database: countedDatabase });
    await expect(countedStore.ingest(batch(events.slice(16)))).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 48 },
    });

    expect(writes).toEqual({ events: 1, cursor: 1, session: 1 });
    expect(
      await database
        .selectFrom("session_events")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "48" });
    expect(
      await database
        .selectFrom("session_event_cursors")
        .select(["last_persisted_seq", "acknowledged_through_seq"])
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_persisted_seq: "48", acknowledged_through_seq: "48" });
  });

  it("ACKs an external Worker event batch after Kafka and exposes it only after projection", async () => {
    const assigned = await createAssignedTurn({
      sandboxId: IDS.externalEventSandbox,
      sandboxBootId: IDS.externalEventSandboxBoot,
      supervisorId: "external-event-supervisor",
      phase: "acknowledged",
      expired: false,
    });
    const occurredAt = new Date().toISOString();
    const events = ["hello ", "from Kafka"].map((text, index) => ({
      schemaVersion: 1 as const,
      eventId: globalThis.crypto.randomUUID(),
      sessionId: assigned.assignedSession.sessionId,
      turnId: assigned.accepted.turnId,
      agentId: "root",
      seq: index + 1,
      occurredAt,
      type: "assistant.text.delta" as const,
      payload: { text },
    }));
    const batch: EventPublishBatchMessage = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: occurredAt,
      type: "event.publish_batch",
      payload: {
        commandId: assigned.accepted.commandId,
        leaseId: assigned.runtime.leaseId,
        fencingToken: assigned.runtime.fencingToken,
        events,
      },
    };
    const appended: WorkerEventLogBatch[] = [];
    const liveEventStore = new MemoryLiveSessionEventStore();
    const externalStore = new DurableEventStore({
      database,
      liveEventStore,
      workerEventLog: {
        append: (batches) => {
          appended.push(...batches);
          return Promise.resolve();
        },
      },
    });
    await expect(externalStore.ingest(batch)).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 2 },
    });
    expect(
      await database
        .selectFrom("session_events")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await externalStore.openReplayWindow(IDS.tenant, assigned.assignedSession.sessionId, 0),
    ).toEqual({ events: [], highWaterMark: 0 });
    await expect(
      database.transaction().execute((transaction) =>
        commitTerminalTurnEvent(transaction, {
          tenantId: IDS.tenant,
          sessionId: assigned.assignedSession.sessionId,
          turnId: assigned.accepted.turnId,
          commandId: assigned.accepted.commandId,
          agentId: "root",
          leaseId: assigned.runtime.leaseId,
          fencingToken: assigned.runtime.fencingToken,
          body: {
            type: "turn.failed",
            payload: {
              code: "projection_lag_test",
              message: "Projection lag must prevent terminal commit",
              retryable: false,
            },
          },
          now: new Date(),
          eventId: globalThis.crypto.randomUUID(),
        }),
      ),
    ).rejects.toThrow("Terminal event stream is not contiguous");

    expect(appended).toHaveLength(1);
    const envelope = {
      schemaVersion: 1 as const,
      tenantId: appended[0]!.tenantId,
      messages: appended[0]!.messages,
    };
    await externalStore.project(envelope, {
      consumerGroup: "test-projector",
      topic: "test-events",
      partition: 0,
      offset: "0",
    });
    await externalStore.project(envelope, {
      consumerGroup: "test-projector",
      topic: "test-events",
      partition: 0,
      offset: "0",
    });

    const replay = await externalStore.openReplayWindow(
      IDS.tenant,
      assigned.assignedSession.sessionId,
      0,
    );
    expect(replay.highWaterMark).toBe(2);
    expect(
      replay.events.map((event) =>
        event.type === "assistant.text.delta" ? event.payload.text : undefined,
      ),
    ).toEqual(["hello ", "from Kafka"]);
    const liveConversation = await http.inject({
      method: "GET",
      url: `/v1/conversations/${assigned.assignedSession.sessionId}`,
    });
    expect(liveConversation.statusCode).toBe(200);
    expect(liveConversation.json<ConversationDetailResource>().replayAfterSequence).toBe(0);
    expect(
      await database
        .selectFrom("session_event_cursors")
        .select(["last_persisted_seq", "last_projected_seq", "acknowledged_through_seq"])
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      last_persisted_seq: "2",
      last_projected_seq: "2",
      acknowledged_through_seq: "2",
    });

    const retryEvent: EventPublishMessage = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: occurredAt,
      type: "event.publish",
      payload: {
        commandId: assigned.accepted.commandId,
        leaseId: assigned.runtime.leaseId,
        fencingToken: assigned.runtime.fencingToken,
        event: {
          ...events[0]!,
          eventId: globalThis.crypto.randomUUID(),
          seq: 3,
          payload: { text: "after retry" },
        },
      },
    };
    const failingStore = new DurableEventStore({
      database,
      liveEventStore,
      workerEventLog: {
        append: () => Promise.reject(new Error("injected Kafka outage")),
      },
    });
    await expect(failingStore.ingest(retryEvent)).rejects.toThrow("injected Kafka outage");
    await expect(
      database
        .selectFrom("session_event_cursors")
        .select(["last_persisted_seq", "last_projected_seq"])
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      last_persisted_seq: "2",
      last_projected_seq: "2",
    });
    const retried: WorkerEventLogBatch[] = [];
    const retryStore = new DurableEventStore({
      database,
      liveEventStore,
      workerEventLog: {
        append: (batches) => {
          retried.push(...batches);
          return Promise.resolve();
        },
      },
    });
    await expect(retryStore.ingest(retryEvent)).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 3 },
    });
    expect(retried).toHaveLength(1);
    await retryStore.project(
      {
        schemaVersion: 1,
        tenantId: retried[0]!.tenantId,
        messages: retried[0]!.messages,
      },
      {
        consumerGroup: "test-projector",
        topic: "test-events",
        partition: 0,
        offset: "1",
      },
    );
    await expect(
      externalStore.openReplayWindow(IDS.tenant, assigned.assignedSession.sessionId, 2),
    ).resolves.toMatchObject({
      highWaterMark: 3,
      events: [{ seq: 3, type: "assistant.text.delta", payload: { text: "after retry" } }],
    });
    const terminalEventId = globalThis.crypto.randomUUID();
    const terminalNow = new Date();
    const terminalBody = {
      type: "turn.completed" as const,
      payload: { stopReason: "external_event_test_complete" },
    };
    const preparedProjection = await new LiveTerminalTurnProjectionSource({
      database,
      liveEvents: liveEventStore,
    }).prepare({
      tenantId: IDS.tenant,
      sessionId: assigned.assignedSession.sessionId,
      turnId: assigned.accepted.turnId,
      commandId: assigned.accepted.commandId,
      agentId: "root",
      body: terminalBody,
      eventId: terminalEventId,
      occurredAt: terminalNow.toISOString(),
    });
    await database.transaction().execute((transaction) =>
      commitTerminalTurnEvent(transaction, {
        tenantId: IDS.tenant,
        sessionId: assigned.assignedSession.sessionId,
        turnId: assigned.accepted.turnId,
        commandId: assigned.accepted.commandId,
        agentId: "root",
        leaseId: assigned.runtime.leaseId,
        fencingToken: assigned.runtime.fencingToken,
        body: terminalBody,
        now: terminalNow,
        eventId: terminalEventId,
        preparedProjection,
      }),
    );
    await expect(
      externalStore.openReplayWindow(IDS.tenant, assigned.assignedSession.sessionId, 3),
    ).resolves.toMatchObject({
      highWaterMark: 4,
      events: [{ seq: 4, type: "turn.completed" }],
    });
    expect(
      await database
        .selectFrom("conversation_turn_projections")
        .select("transcript")
        .where("turn_id", "=", assigned.accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      transcript: {
        throughSequence: 4,
        items: [{ kind: "text", text: "hello from Kafkaafter retry" }],
      },
    });
    expect(
      await database
        .selectFrom("session_events")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("session_id", "=", assigned.assignedSession.sessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    await liveEventStore.trimThrough(IDS.tenant, assigned.assignedSession.sessionId, 3);
    await expect(
      externalStore.openReplayWindow(IDS.tenant, assigned.assignedSession.sessionId, 0),
    ).rejects.toMatchObject({ code: "event_store_invariant", retryable: true });
  });

  it.skipIf(!process.env.PI_CLOUD_TEST_DATABASE_URL)(
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
        applicationName: `pi-cloud-second-api-test-${process.pid}`,
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

  it("releases the fenced lease after a post-ACK supervisor failure", async () => {
    await createReadySandbox({
      id: IDS.sandbox,
      bootId: IDS.sandboxBoot,
      supervisorId: "post-ack-failure-test",
    });
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run() {
          throw new PiTurnError("model_timeout", "Model request timed out", true);
        },
      },
    });
    const backend = new AgentRunExecutionBackend({
      supervisor,
      leaseCoordinator,
      eventIngestor: durableEventStore,
    });
    const dispatcher = new RunCommandExecutor({
      database,
      backend,
      leaseManager: leaseCoordinator,
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
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

  it("keeps a Run queued until a Workspace terminal releases its writer reservation", async () => {
    const accepted = await acceptTurn(
      "workspace-terminal-writer-gate",
      "wait for the human terminal writer before starting",
    );
    const workspace = await database
      .selectFrom("workspaces")
      .select("sandbox_domain_id")
      .where("tenant_id", "=", IDS.tenant)
      .where("id", "=", project.workspaceId)
      .executeTakeFirstOrThrow();
    const brokerId = "50000000-0000-4000-8000-000000000098";
    const terminalId = "50000000-0000-4000-8000-000000000099";
    const now = new Date();
    await database
      .insertInto("tool_broker_instances")
      .values({
        instance_id: brokerId,
        sandbox_domain_id: workspace.sandbox_domain_id,
        owner_base_url: "http://terminal-writer-gate.invalid",
        state: "ready",
        lease_expires_at: new Date(now.valueOf() + 60_000),
        last_heartbeat_at: now,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("workspace_terminal_sessions")
      .values({
        terminal_id: terminalId,
        sandbox_domain_id: workspace.sandbox_domain_id,
        owner_instance_id: brokerId,
        owner_base_url: "http://terminal-writer-gate.invalid",
        tenant_id: IDS.tenant,
        user_id: IDS.tenant,
        project_id: project.projectId,
        workspace_id: project.workspaceId,
        session_id: session.sessionId,
        state: "cleaning",
        lease_expires_at: new Date(now.valueOf() + 60_000),
        last_heartbeat_at: now,
      })
      .executeTakeFirstOrThrow();
    const dispatcher = new RunCommandExecutor({
      database,
      backend: new DeterministicExecutionBackend([{ kind: "complete", stopReason: "stop" }]),
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toEqual({
      status: "idle",
    });
    await expect(readTurnExecution(accepted)).resolves.toMatchObject({
      commandState: "pending",
      turnState: "queued",
      sessionState: "idle",
      attempts: 0,
    });

    await database
      .updateTable("workspace_terminal_sessions")
      .set({ state: "released", updated_at: new Date() })
      .where("terminal_id", "=", terminalId)
      .executeTakeFirstOrThrow();
    await expect(dispatchClaimableWork(dispatcher)).resolves.toMatchObject({
      status: "completed",
      commandId: accepted.commandId,
    });
  });

  it("settles the original failure when terminal projection preparation also fails", async () => {
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Projection failure project" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const failedProject = projectResponse.json() as ProjectResource;
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${failedProject.projectId}/sessions`,
      payload: {
        workspaceId: failedProject.workspaceId,
        title: "Projection failure settlement",
      },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const failedSession = sessionResponse.json() as SessionResource;
    const turnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${failedSession.sessionId}/turns`,
      headers: { "idempotency-key": "terminal-projection-secondary-failure" },
      payload: { prompt: "Exercise terminal projection failure settlement." },
    });
    expect(turnResponse.statusCode).toBe(202);
    const accepted = turnResponse.json() as AcceptedTurnResource;
    const dispatcher = new RunCommandExecutor({
      database,
      backend: {
        async execute(_request, lifecycle) {
          await lifecycle.started();
          throw new PiTurnError("model_timeout", "Model request timed out", true);
        },
      },
      terminalTurnProjectionSource: {
        async prepare() {
          throw new Error("terminal projection unavailable");
        },
      },
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      failureCode: "model_timeout",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      turnState: "failed",
      sessionState: "idle",
      turnFailureCode: "model_timeout",
      failureMessage: "Model request timed out",
    });
    await expect(
      database
        .selectFrom("session_terminal_events")
        .select(["type", "turn_id"])
        .where("session_id", "=", failedSession.sessionId)
        .where("turn_id", "=", accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ type: "turn.failed", turn_id: accepted.turnId });
    await expect(
      database
        .selectFrom("conversation_turn_projections")
        .select(["source_event_count", "transcript"])
        .where("turn_id", "=", accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      source_event_count: 1,
      transcript: {
        failure: {
          code: "model_timeout",
          message: "Model request timed out",
          retryable: true,
        },
      },
    });
  });

  it("renews a running assignment beyond its initial lease deadline", async () => {
    await createReadySandbox({
      id: IDS.heartbeatSandbox,
      bootId: IDS.heartbeatSandboxBoot,
      supervisorId: "lease-heartbeat-test",
    });
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
      sandboxId: IDS.heartbeatSandbox,
      leaseDurationMs: 90,
    });
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run() {
          await runnerGate;
          return { stopReason: "long_turn_completed" };
        },
      },
    });
    const dispatcher = new RunCommandExecutor({
      database,
      backend: new AgentRunExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        heartbeatIntervalMs: 20,
      }),
      leaseManager: leaseCoordinator,
    });

    const dispatch = dispatchNextTestCommand(database, dispatcher, IDS.tenant);
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
  }, 15_000);

  it("never revives an expired lease and quarantines the stopped session", async () => {
    await createReadySandbox({
      id: IDS.expiredLeaseSandbox,
      bootId: IDS.expiredLeaseSandboxBoot,
      supervisorId: "expired-lease-test",
    });
    const sessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
      sandboxId: IDS.expiredLeaseSandbox,
      leaseDurationMs: 60,
    });
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run(_command, _publishEvent, signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const reason = signal.reason as { reason: "lease_revoked" };
                reject(new PiTurnCancelledError(reason.reason, false));
              },
              { once: true },
            );
          });
        },
      },
    });
    const dispatcher = new RunCommandExecutor({
      database,
      backend: new AgentRunExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        heartbeatIntervalMs: 120,
      }),
      leaseManager: leaseCoordinator,
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
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
      terminalTurnProjectionSource: {
        async prepare() {
          throw new Error("terminal projection unavailable");
        },
      },
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
    await expect(
      database
        .selectFrom("session_terminal_events")
        .select("type")
        .where("session_id", "=", fixture.assignedSession.sessionId)
        .where("turn_id", "=", fixture.accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ type: "turn.failed" });
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

    const retryDispatcher = new RunCommandExecutor({
      database,
      backend: new DeterministicExecutionBackend(),
    });
    await expect(
      dispatchNextTestCommand(database, retryDispatcher, IDS.tenant),
    ).resolves.toMatchObject({
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
    const spoolRoot = await mkdtemp(resolve(tmpdir(), "pi-cloud-durable-event-spool-"));
    try {
      const sessionResponse = await http.inject({
        method: "POST",
        url: `/v1/projects/${project.projectId}/sessions`,
        payload: { workspaceId: project.workspaceId, title: "Test conversation" },
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
      const firstStore = new WalEventSpoolStore({ rootDirectory: spoolRoot });
      const supervisor = new AgentRunSupervisor({
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
      const backend = new AgentRunExecutionBackend({
        supervisor,
        leaseCoordinator,
        eventIngestor: durableEventStore,
        onEvent() {
          throw new Error("simulated ACK connection loss after PostgreSQL commit");
        },
      });
      const dispatcher = new RunCommandExecutor({
        database,
        backend,
        leaseManager: leaseCoordinator,
      });

      await expect(
        dispatchNextTestCommand(database, dispatcher, IDS.tenant),
      ).resolves.toMatchObject({
        status: "failed",
        commandId: accepted.commandId,
        phase: "after_start",
        failureCode: "invalid_event_delivery",
      });
      const persistedBeforeReplay = await database
        .selectFrom("session_events")
        .select(["event_id", "seq", "type"])
        .where("session_id", "=", replaySession.sessionId)
        .execute();
      expect(persistedBeforeReplay).toHaveLength(2);
      expect(persistedBeforeReplay[0]).toMatchObject({ seq: "1", type: "turn.started" });
      expect(persistedBeforeReplay[1]).toMatchObject({ seq: "2", type: "turn.failed" });

      const restartedStore = new WalEventSpoolStore({ rootDirectory: spoolRoot });
      const restartedSupervisor = new AgentRunSupervisor({
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
      ).resolves.toEqual({
        scannedSpools: 1,
        replayedSpools: 1,
        replayedEvents: 1,
        quarantinedSpools: 0,
        quarantinedEvents: 0,
      });
      expect(
        await database
          .selectFrom("session_events")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("session_id", "=", replaySession.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "2" });
      await expect(
        new WalEventSpoolStore({ rootDirectory: spoolRoot }).redeliverPending(() => {
          throw new Error("A drained spool must not publish");
        }),
      ).resolves.toEqual({
        scannedSpools: 1,
        replayedSpools: 0,
        replayedEvents: 0,
        quarantinedSpools: 0,
        quarantinedEvents: 0,
      });
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

  it("settles a completed backend execution when the external event projection cannot catch up", async () => {
    const accepted = await acceptTurn(
      "event-projection-boundary-failure",
      "finish the agent loop while the live projection is unavailable",
    );
    const dispatcher = new RunCommandExecutor({
      database,
      backend: new DeterministicExecutionBackend([{ kind: "complete", stopReason: "stop" }]),
      eventProjectionBarrier: {
        async waitForSession() {
          throw new Error("simulated event projection outage");
        },
      },
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      phase: "after_start",
      failureCode: "event_projection_unavailable",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      turnState: "failed",
      sessionState: "idle",
      commandFailureCode: "event_projection_unavailable",
      turnFailureCode: "event_projection_unavailable",
    });
  });

  it("settles an internally timed-out Pi turn without requiring a user cancellation command", async () => {
    const accepted = await acceptTurn(
      "internal-turn-timeout",
      "let the trusted Pi runtime reach its own deadline",
    );
    const backend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        await lifecycle.started();
        throw new TurnExecutionCancelledError("timeout", true);
      },
    };
    const dispatcher = new RunCommandExecutor({ database, backend });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).resolves.toMatchObject({
      status: "failed",
      commandId: accepted.commandId,
      phase: "after_start",
      failureCode: "pi_timeout",
    });
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "failed",
      commandFailureCode: "pi_timeout",
      turnState: "failed",
      turnFailureCode: "pi_timeout",
      sessionState: "idle",
    });
  });

  it("does not expose a terminal event when the final settlement transaction rolls back", async () => {
    const accepted = await acceptTurn(
      "terminal-transaction-rollback",
      "exercise the final settlement transaction",
    );
    const dispatcher = new RunCommandExecutor({
      database,
      backend: new DeterministicExecutionBackend([
        { kind: "complete", stopReason: "prepared-result" },
      ]),
      eventNotificationPublisher: {
        async publish() {
          throw new Error("simulated terminal notification failure");
        },
      },
    });

    await expect(dispatchNextTestCommand(database, dispatcher, IDS.tenant)).rejects.toThrow(
      "simulated terminal notification failure",
    );
    expect(await readTurnExecution(accepted)).toMatchObject({
      commandState: "acknowledged",
      turnState: "running",
      sessionState: "running",
      stopReason: null,
    });
    expect(
      await database
        .selectFrom("session_events")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("turn_id", "=", accepted.turnId)
        .where("type", "in", ["turn.completed", "turn.failed", "turn.cancelled"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await database
        .selectFrom("conversation_turn_projections")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("turn_id", "=", accepted.turnId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
  });
});
