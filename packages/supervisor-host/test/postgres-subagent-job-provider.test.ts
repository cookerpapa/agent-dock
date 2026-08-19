import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  ControlPlaneStore,
  ConversationTreeService,
  createPrivateTenant,
} from "@pi-cloud/control-plane";
import { PostgresPiSessionRepository } from "@pi-cloud/pi-session-postgres";
import { TURN_COMMAND_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { RunCommandExecutor } from "@pi-cloud/runtime-core/run-command-executor";
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
    "persistent",
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
        "child.sandbox_retention_policy as sandboxRetention",
        "child.tool_capabilities as sessionTools",
        "child_run.tool_capability_snapshot as runTools",
        "child_run.command_id as commandId",
      ])
      .where("execution.id", "=", started.executionId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      sessionKind: "subagent",
      sandboxRetention: "ephemeral",
      sessionTools: [],
      runTools: [],
      commandId: persisted.commandId,
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
    const dispatched: string[] = [];
    const dispatcher = new RunCommandExecutor({
      database,
      backend: {
        async execute(request, lifecycle) {
          dispatched.push(request.runId);
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    await dispatcher.dispatchCommand(persisted.commandId);
    expect(dispatched).toEqual([started.childRunId]);
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
      systemPrompt: "You are a deployment-owned scout profile.",
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
      .select(["turn_id", "command_id", "tool_capability_snapshot", "agent_system_prompt"])
      .where("id", "=", started.childRunId)
      .executeTakeFirstOrThrow();
    expect(child.tool_capability_snapshot).toEqual(["read", "bash"]);
    expect(child.agent_system_prompt).toContain("You are a deployment-owned scout profile.");
    expect(child.agent_system_prompt).toContain("PiCloud delegated leaf boundary");
    const dispatched: string[] = [];
    const dispatcher = new RunCommandExecutor({
      database,
      backend: {
        async execute(request, lifecycle) {
          dispatched.push(request.runId);
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    await dispatcher.dispatchCommand(child.command_id);
    expect(dispatched).toEqual([started.childRunId]);
    await childPi.appendMessage(assistant("Subagent result from PostgreSQL"));

    await expect(provider.result(tenantId, started.executionId)).resolves.toMatchObject({
      state: "completed",
      output: "Subagent result from PostgreSQL",
    });
    const focusTree = await new ConversationTreeService({ database }).tree(
      tenantId,
      started.childSessionId,
      "focus",
    );
    expect(focusTree).toMatchObject({
      rootSessionId: started.childSessionId,
      currentSessionId: started.childSessionId,
      view: "focus",
      branches: [
        {
          kind: "subagent",
          sessionId: started.childSessionId,
          parentSessionId: null,
          current: true,
          agentName: "scout",
          contextMode: "fork",
          workspaceMode: "shared_serialized",
          entries: [
            { role: "user", text: "Earlier context" },
            { role: "assistant", text: "Subagent result from PostgreSQL" },
          ],
        },
      ],
    });
  });

  it("prepares an isolated internal Workspace before dispatching the Child Run", async () => {
    const parent = await database
      .selectFrom("runs")
      .select(["project_id", "workspace_id", "turn_id", "command_id"])
      .where("id", "=", parentRunId)
      .executeTakeFirstOrThrow();
    const requests: Array<{ targetWorkspaceId: string; targetSessionId: string }> = [];
    const provider = new PostgresSubagentJobProvider({
      database,
      forkWorkspace: async (request) => {
        requests.push({
          targetWorkspaceId: request.target.workspaceId,
          targetSessionId: request.target.sessionId,
        });
        return {
          toolBrokerProtocolVersion: 1,
          type: "workspace.forked",
          requestId: request.requestId,
          sourceActivationId: request.sourceActivationId,
          targetWorkspaceId: request.target.workspaceId,
          sourceRevision: "a".repeat(64),
          targetRevision: "b".repeat(64),
        };
      },
    });
    const started = await provider.start({
      tenantId,
      parentSessionId,
      parentRunId,
      parentAttemptId,
      parentFencingToken: FENCE,
      parentToolCallId: "subagent-tool-isolated",
      workflowRunId: "workflow-isolated",
      stepIndex: 2,
      agentName: "worker",
      prompt: "Implement an independent approach",
      contextMode: "fork",
      workspaceMode: "isolated",
      requestedToolCapabilities: ["read", "write", "edit", "bash"],
      parentActivation: {
        activationId: crypto.randomUUID(),
        assignment: {
          tenantId,
          projectId: parent.project_id,
          workspaceId: parent.workspace_id,
          supervisorId: "test-worker",
          bootId: crypto.randomUUID(),
          sandboxId: parentSandboxId,
          commandId: parent.command_id,
          sessionId: parentSessionId,
          turnId: parent.turn_id,
          attemptId: parentAttemptId,
          leaseId: crypto.randomUUID(),
          fencingToken: FENCE,
        },
      },
    });
    expect(started.state).toBe("queued");
    expect(requests).toHaveLength(1);
    const isolated = await database
      .selectFrom("subagent_executions as execution")
      .innerJoin("workspaces as workspace", "workspace.id", "execution.child_workspace_id")
      .innerJoin("runs as child_run", "child_run.id", "execution.child_run_id")
      .select([
        "execution.state",
        "execution.workspace_mode as workspaceMode",
        "workspace.id as workspaceId",
        "workspace.workspace_kind as workspaceKind",
        "workspace.parent_workspace_id as parentWorkspaceId",
        "child_run.workspace_id as runWorkspaceId",
      ])
      .where("execution.id", "=", started.executionId)
      .executeTakeFirstOrThrow();
    expect(isolated).toEqual({
      state: "queued",
      workspaceMode: "isolated",
      workspaceId: requests[0]!.targetWorkspaceId,
      workspaceKind: "subagent_isolated",
      parentWorkspaceId: parent.workspace_id,
      runWorkspaceId: requests[0]!.targetWorkspaceId,
    });
    await expect(
      database
        .selectFrom("outbox")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("aggregate_id", "=", started.childSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("cancels a queued Child Run durably before it consumes a Worker slot", async () => {
    const provider = new PostgresSubagentJobProvider({ database });
    const started = await provider.start({
      tenantId,
      parentSessionId,
      parentRunId,
      parentAttemptId,
      parentFencingToken: FENCE,
      parentToolCallId: "subagent-tool-cancel",
      workflowRunId: "workflow-cancel",
      stepIndex: 3,
      agentName: "oracle",
      prompt: "Cancel this queued review",
      contextMode: "fresh",
      workspaceMode: "none",
    });
    await expect(provider.cancel(tenantId, started.executionId)).resolves.toMatchObject({
      state: "cancelled",
    });
    await expect(
      database
        .selectFrom("runs")
        .select("state")
        .where("id", "=", started.childRunId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "cancelled" });
    await database
      .updateTable("subagent_executions")
      .set({ state: "running", settled_at: null, updated_at: new Date(0) })
      .where("id", "=", started.executionId)
      .executeTakeFirstOrThrow();
    await expect(provider.reapStalePreparations()).resolves.toBeGreaterThanOrEqual(1);
    await expect(provider.status(tenantId, started.executionId)).resolves.toMatchObject({
      state: "cancelled",
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
