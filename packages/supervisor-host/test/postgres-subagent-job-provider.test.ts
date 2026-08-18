import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { ControlPlaneStore, createPrivateTenant } from "@pi-cloud/control-plane";
import { PostgresPiSessionRepository } from "@pi-cloud/pi-session-postgres";
import { TURN_COMMAND_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSubagentJobError, PostgresSubagentJobProvider } from "../src/index.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let tenantId: string;
let parentSessionId: string;
let parentRunId: string;
let parentAttemptId: string;
let parentSandboxId: string;

const FENCE = 7;

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "pi-cloud-fake",
    model: "pi-cloud-fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
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
  const tenant = await createPrivateTenant(database, {
    slug: "subagent-provider",
    ownerDisplayName: "Subagent Provider",
    quotas: {
      maximumProjects: 8,
      maximumSessions: 32,
      maximumUnsettledTurns: 32,
      maximumConcurrentTurns: 8,
      maximumActiveSandboxes: 8,
    },
  });
  tenantId = tenant.tenantId;
  await database
    .insertInto("sandbox_domains")
    .values({
      id: "sandbox-domain-test",
      display_name: "test",
      state: "active",
      tool_broker_base_url: "http://tool-broker.internal",
      workspace_storage_key: "test-volume",
      maximum_active_sandboxes: 16,
    })
    .executeTakeFirstOrThrow();
  const store = new ControlPlaneStore({
    database,
    tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
  const project = await store.createProject({ name: "subagents", source: { kind: "empty" } });
  const parentSession = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Parent",
    "ephemeral",
  );
  parentSessionId = parentSession.sessionId;
  const accepted = await store.acceptTurn(parentSessionId, "parent-turn", {
    prompt: "Delegate repository inspection",
  });
  parentRunId = accepted.runId;
  parentAttemptId = crypto.randomUUID();
  parentSandboxId = crypto.randomUUID();

  const repository = new PostgresPiSessionRepository({ database, tenantId });
  const parentPi = await repository.create({ id: parentSessionId });
  await parentPi.appendMessage({ role: "user", content: "Earlier context", timestamp: Date.now() });
  await parentPi.appendMessage(assistant("Earlier answer"));

  await database
    .insertInto("sandboxes")
    .values({
      id: parentSandboxId,
      supervisor_id: "test-worker",
      boot_id: crypto.randomUUID(),
      state: "leased",
      max_concurrent_sessions: 1,
      active_sessions: 1,
      terminated_at: null,
    })
    .executeTakeFirstOrThrow();

  await database
    .insertInto("run_attempts")
    .values({
      id: parentAttemptId,
      tenant_id: tenantId,
      run_id: parentRunId,
      attempt_number: 1,
      state: "running",
      claim_owner_id: "test-worker",
      claim_expires_at: new Date(Date.now() + 60_000),
      sandbox_id: parentSandboxId,
      lease_id: crypto.randomUUID(),
      fencing_token: FENCE,
      checkpoint_revision: null,
      failure_code: null,
      failure_message: null,
      failure_retryable: null,
      provisioning_at: new Date(),
      restoring_at: new Date(),
      running_at: new Date(),
      checkpointing_at: null,
      last_heartbeat_at: new Date(),
      settled_at: null,
    })
    .executeTakeFirstOrThrow();
  const run = await database
    .selectFrom("runs")
    .select(["turn_id", "command_id"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", parentRunId)
    .executeTakeFirstOrThrow();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .updateTable("runs")
      .set({
        state: "running",
        current_attempt_id: parentAttemptId,
        attempt_count: 1,
        started_at: new Date(),
      })
      .where("id", "=", parentRunId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("turns")
      .set({ state: "running", started_at: new Date() })
      .where("id", "=", run.turn_id)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("sessions")
      .set({ state: "running" })
      .where("id", "=", parentSessionId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("commands")
      .set({ state: "acknowledged", acknowledged_at: new Date() })
      .where("id", "=", run.command_id)
      .executeTakeFirstOrThrow();
  });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe.sequential("PostgresSubagentJobProvider", () => {
  it("creates an idempotent Tool-free Child Session and queues it for the shared Worker pool", async () => {
    const provider = new PostgresSubagentJobProvider({ database });
    const request = {
      tenantId,
      parentSessionId,
      parentRunId,
      parentAttemptId,
      parentFencingToken: FENCE,
      parentToolCallId: "subagent-tool-none",
      workflowRunId: "workflow-none",
      stepIndex: 0,
      agentName: "oracle",
      prompt: "Review the approach without using tools",
      contextMode: "fresh" as const,
      workspaceMode: "none" as const,
    };
    const started = await provider.start(request);
    expect(await provider.start(request)).toEqual(started);
    await expect(
      provider.start({ ...request, prompt: "A conflicting retry" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const persisted = await database
      .selectFrom("subagent_executions as execution")
      .innerJoin("sessions as child", "child.id", "execution.child_session_id")
      .innerJoin("runs as child_run", "child_run.id", "execution.child_run_id")
      .select([
        "child.session_kind as sessionKind",
        "child.tool_capabilities as sessionTools",
        "child_run.tool_capability_snapshot as runTools",
      ])
      .where("execution.id", "=", started.executionId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      sessionKind: "subagent",
      sessionTools: [],
      runTools: [],
    });
    const piSession = await database
      .selectFrom("pi_sessions")
      .select("parent_session_id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", started.childSessionId)
      .executeTakeFirstOrThrow();
    expect(piSession.parent_session_id).toBe(parentSessionId);
    const outbox = await database
      .selectFrom("outbox")
      .select("topic")
      .where("aggregate_id", "=", started.childSessionId)
      .executeTakeFirstOrThrow();
    expect(outbox.topic).toBe(TURN_COMMAND_OUTBOX_TOPIC);
  });

  it("forks Pi context, narrows tools and reads the terminal result from PostgreSQL", async () => {
    const provider = new PostgresSubagentJobProvider({ database });
    const started = await provider.start({
      tenantId,
      parentSessionId,
      parentRunId,
      parentAttemptId,
      parentFencingToken: FENCE,
      parentToolCallId: "subagent-tool-shared",
      workflowRunId: "workflow-shared",
      stepIndex: 1,
      agentName: "scout",
      prompt: "Inspect the repository",
      contextMode: "fork",
      workspaceMode: "shared_serialized",
      requestedToolCapabilities: ["read", "bash"],
    });
    const repository = new PostgresPiSessionRepository({ database, tenantId });
    const childPi = await repository.openById(started.childSessionId);
    const inherited = await childPi.view("main").findEntriesOnBranch({ order: "oldestFirst" });
    expect(inherited).toHaveLength(1);
    expect(inherited[0]?.type).toBe("message");
    if (inherited[0]?.type === "message") expect(inherited[0].message.role).toBe("user");

    const child = await database
      .selectFrom("runs")
      .select(["turn_id", "command_id", "tool_capability_snapshot"])
      .where("id", "=", started.childRunId)
      .executeTakeFirstOrThrow();
    expect(child.tool_capability_snapshot).toEqual(["read", "bash"]);
    await childPi.appendMessage(assistant("Subagent result from PostgreSQL"));
    const now = new Date();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("runs")
        .set({ state: "completed", settled_at: now })
        .where("id", "=", started.childRunId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({ state: "completed", stop_reason: "stop", settled_at: now })
        .where("id", "=", child.turn_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("id", "=", started.childSessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("commands")
        .set({ state: "completed", completed_at: now })
        .where("id", "=", child.command_id)
        .executeTakeFirstOrThrow();
    });

    await expect(provider.result(tenantId, started.executionId)).resolves.toMatchObject({
      state: "completed",
      output: "Subagent result from PostgreSQL",
    });
  });

  it("rejects dispatch after the parent fencing authority changes", async () => {
    const provider = new PostgresSubagentJobProvider({ database });
    await expect(
      provider.start({
        tenantId,
        parentSessionId,
        parentRunId,
        parentAttemptId,
        parentFencingToken: FENCE + 1,
        parentToolCallId: "stale-tool",
        workflowRunId: "stale-workflow",
        stepIndex: 0,
        agentName: "scout",
        prompt: "Must not start",
        contextMode: "fresh",
        workspaceMode: "none",
      }),
    ).rejects.toBeInstanceOf(PostgresSubagentJobError);
  });
});
