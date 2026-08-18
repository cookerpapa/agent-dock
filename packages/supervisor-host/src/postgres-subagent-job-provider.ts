import { createHash, randomUUID } from "node:crypto";
import type {
  Database,
  SubagentContextMode,
  SubagentExecutionState,
  SubagentWorkspaceMode,
} from "@pi-cloud/database";
import {
  forkPostgresPiSessionInTransaction,
  PostgresPiSessionRepository,
} from "@pi-cloud/pi-session-postgres";
import {
  parseCloudToolCapabilitySnapshot,
  TURN_COMMAND_OUTBOX_TOPIC,
  type CloudToolCapabilitySnapshot,
} from "@pi-cloud/protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";

export type StartCloudSubagentJobInput = Readonly<{
  tenantId: string;
  parentSessionId: string;
  parentRunId: string;
  parentAttemptId: string;
  parentFencingToken: number;
  parentToolCallId: string;
  workflowRunId: string;
  stepIndex: number;
  agentName: string;
  prompt: string;
  systemPrompt?: string;
  contextMode: SubagentContextMode;
  workspaceMode: Exclude<SubagentWorkspaceMode, "isolated">;
  requestedToolCapabilities?: CloudToolCapabilitySnapshot;
}>;

export type CloudSubagentJobHandle = Readonly<{
  executionId: string;
  childSessionId: string;
  childRunId: string;
  state: SubagentExecutionState;
}>;

export type CloudSubagentJobResult = CloudSubagentJobHandle &
  Readonly<{
    output?: string;
    failureCode?: string;
    failureMessage?: string;
  }>;

export class PostgresSubagentJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresSubagentJobError";
    this.code = code;
  }
}

type IdGenerator = () => string;

function nonEmpty(value: string, name: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeStep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Subagent step is invalid");
  return value;
}

function safeFence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Subagent parent fence is invalid");
  }
  return value;
}

function requestSha256(input: StartCloudSubagentJobInput, tools: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        agentName: input.agentName,
        contextMode: input.contextMode,
        parentAttemptId: input.parentAttemptId,
        parentRunId: input.parentRunId,
        parentSessionId: input.parentSessionId,
        parentToolCallId: input.parentToolCallId,
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        stepIndex: input.stepIndex,
        tools,
        workflowRunId: input.workflowRunId,
        workspaceMode: input.workspaceMode,
      }),
      "utf8",
    )
    .digest("hex");
}

function traceId(runId: string): string {
  return createHash("sha256")
    .update("pi-cloud.run-trace.v1\0", "utf8")
    .update(runId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function intersectTools(
  parent: unknown,
  requested: CloudToolCapabilitySnapshot | undefined,
  workspaceMode: StartCloudSubagentJobInput["workspaceMode"],
): CloudToolCapabilitySnapshot {
  if (workspaceMode === "none") return [];
  const parentTools = parseCloudToolCapabilitySnapshot(parent);
  if (requested === undefined) return parentTools;
  const requestedTools = parseCloudToolCapabilitySnapshot(requested);
  const parentSet = new Set(parentTools);
  return requestedTools.filter((tool) => parentSet.has(tool));
}

function mapRunState(state: string): SubagentExecutionState {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
    case "superseded":
      return "cancelled";
    case "queued":
    case "claimed":
      return "queued";
    default:
      return "running";
  }
}

function assistantText(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length === 0 ? undefined : text;
}

export class PostgresSubagentJobProvider {
  readonly #database: Kysely<Database>;
  readonly #id: IdGenerator;

  constructor(options: { database: Kysely<Database>; idGenerator?: IdGenerator }) {
    this.#database = options.database;
    this.#id = options.idGenerator ?? randomUUID;
  }

  async start(input: StartCloudSubagentJobInput): Promise<CloudSubagentJobHandle> {
    nonEmpty(input.parentToolCallId, "Parent Tool call", 256);
    nonEmpty(input.workflowRunId, "Subagent workflow Run", 256);
    nonEmpty(input.agentName, "Subagent name", 128);
    nonEmpty(input.prompt, "Subagent prompt", 1_000_000);
    if (input.systemPrompt !== undefined) {
      nonEmpty(input.systemPrompt, "Subagent system prompt", 100_000);
    }
    safeStep(input.stepIndex);
    safeFence(input.parentFencingToken);
    if (input.contextMode !== "fresh" && input.contextMode !== "fork") {
      throw new TypeError("Subagent context mode is invalid");
    }
    if (input.workspaceMode !== "none" && input.workspaceMode !== "shared_serialized") {
      throw new TypeError("Subagent Workspace mode is invalid");
    }

    return this.#database.transaction().execute(async (transaction) => {
      const replay = await transaction
        .selectFrom("subagent_executions")
        .select(["id", "child_session_id", "child_run_id", "state", "request_sha256"])
        .where("tenant_id", "=", input.tenantId)
        .where("parent_run_id", "=", input.parentRunId)
        .where("parent_tool_call_id", "=", input.parentToolCallId)
        .where("workflow_run_id", "=", input.workflowRunId)
        .where("step_index", "=", input.stepIndex)
        .executeTakeFirst();

      const parent = await transaction
        .selectFrom("runs as parent_run")
        .innerJoin("run_attempts as parent_attempt", (join) =>
          join
            .onRef("parent_attempt.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_attempt.run_id", "=", "parent_run.id")
            .onRef("parent_attempt.id", "=", "parent_run.current_attempt_id"),
        )
        .innerJoin("sessions as parent_session", (join) =>
          join
            .onRef("parent_session.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_session.id", "=", "parent_run.session_id"),
        )
        .innerJoin("turns as parent_turn", (join) =>
          join
            .onRef("parent_turn.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_turn.id", "=", "parent_run.turn_id"),
        )
        .innerJoin("workspaces as parent_workspace", (join) =>
          join
            .onRef("parent_workspace.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_workspace.id", "=", "parent_run.workspace_id"),
        )
        .select([
          "parent_run.state as runState",
          "parent_run.current_attempt_id as currentAttemptId",
          "parent_run.project_id as projectId",
          "parent_run.workspace_id as workspaceId",
          "parent_run.environment_version_id as environmentVersionId",
          "parent_run.source_set_snapshot as sourceSetSnapshot",
          "parent_run.tool_capability_snapshot as parentTools",
          "parent_attempt.state as attemptState",
          "parent_attempt.fencing_token as fencingToken",
          "parent_session.id as sessionId",
          "parent_session.desired_model_profile_id as modelProfileId",
          "parent_session.sandbox_retention_policy as sandboxRetention",
          "parent_session.workspace_snapshot_key as workspaceSnapshotKey",
          "parent_session.current_workspace_version_id as sessionWorkspaceVersionId",
          "parent_session.forked_from_session_id as forkedFromSessionId",
          "parent_workspace.current_workspace_version_id as workspaceVersionId",
          "parent_turn.model_profile_id as turnModelProfileId",
          "parent_turn.provider as provider",
          "parent_turn.model_id as modelId",
          "parent_turn.thinking_level as thinkingLevel",
          "parent_turn.credential_binding_id as credentialBindingId",
          "parent_turn.credential_binding_version as credentialBindingVersion",
        ])
        .where("parent_run.tenant_id", "=", input.tenantId)
        .where("parent_run.id", "=", input.parentRunId)
        .where("parent_run.session_id", "=", input.parentSessionId)
        .forUpdate(["parent_run", "parent_attempt", "parent_session"])
        .executeTakeFirst();
      if (parent === undefined) {
        throw new PostgresSubagentJobError("parent_not_found", "Parent Agent Run was not found");
      }

      const tools = intersectTools(
        parent.parentTools,
        input.requestedToolCapabilities,
        input.workspaceMode,
      );
      const fingerprint = requestSha256(input, tools);
      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new PostgresSubagentJobError(
            "idempotency_conflict",
            "Subagent step identity was reused with a different request",
          );
        }
        return {
          executionId: replay.id,
          childSessionId: replay.child_session_id,
          childRunId: replay.child_run_id,
          state: replay.state,
        };
      }

      if (
        parent.currentAttemptId !== input.parentAttemptId ||
        parent.runState !== "running" ||
        parent.attemptState !== "running" ||
        Number(parent.fencingToken) !== input.parentFencingToken
      ) {
        throw new PostgresSubagentJobError(
          "parent_authority_expired",
          "Parent Agent Run no longer owns Subagent dispatch authority",
        );
      }

      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select(["maximum_sessions", "maximum_unsettled_turns"])
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const sessionCount = await transaction
        .selectFrom("sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirstOrThrow();
      const unsettledTurnCount = await transaction
        .selectFrom("turns")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.tenantId)
        .where("state", "in", [
          "queued",
          "dispatching",
          "running",
          "waiting_approval",
          "cancelling",
        ])
        .executeTakeFirstOrThrow();
      if (Number(sessionCount.count) >= policy.maximum_sessions) {
        throw new PostgresSubagentJobError(
          "tenant_session_quota",
          "Tenant Session quota does not have capacity for a Subagent",
        );
      }
      if (Number(unsettledTurnCount.count) >= policy.maximum_unsettled_turns) {
        throw new PostgresSubagentJobError(
          "tenant_run_quota",
          "Tenant unsettled Run quota does not have capacity for a Subagent",
        );
      }

      const executionId = this.#id();
      const childSessionId = this.#id();
      const childTurnId = this.#id();
      const childCommandId = this.#id();
      const childRunId = this.#id();
      const outboxId = this.#id();
      const idempotencyKey = `subagent:${executionId}`;
      const effectiveWorkspaceVersionId =
        parent.forkedFromSessionId === null
          ? parent.workspaceVersionId
          : parent.sessionWorkspaceVersionId;

      await transaction
        .insertInto("sessions")
        .values({
          id: childSessionId,
          title: `${input.agentName} · subagent`,
          tenant_id: input.tenantId,
          project_id: parent.projectId,
          workspace_id: parent.workspaceId,
          desired_model_profile_id: parent.modelProfileId,
          state: "cold",
          sandbox_retention_policy: parent.sandboxRetention,
          session_kind: "subagent",
          tool_capabilities: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
          workspace_snapshot_key: parent.workspaceSnapshotKey,
          current_workspace_version_id: effectiveWorkspaceVersionId,
          forked_from_session_id: null,
          conversation_parent_session_id: null,
          conversation_fork_turn_id: null,
          conversation_fork_entry_id: null,
          archived_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("session_event_cursors")
        .values({ session_id: childSessionId })
        .executeTakeFirstOrThrow();

      if (input.contextMode === "fork") {
        const leaf = await transaction
          .selectFrom("pi_session_lanes")
          .select("leaf_id")
          .where("tenant_id", "=", input.tenantId)
          .where("session_id", "=", input.parentSessionId)
          .where("lane", "=", "main")
          .executeTakeFirstOrThrow();
        await forkPostgresPiSessionInTransaction(
          transaction,
          input.tenantId,
          input.parentSessionId,
          childSessionId,
          {
            id: childSessionId,
            parentSessionId: input.parentSessionId,
            scope: "branch",
            ...(leaf.leaf_id === null
              ? {}
              : { entryId: leaf.leaf_id, position: "before" as const }),
          },
        );
      } else {
        await transaction
          .insertInto("pi_sessions")
          .values({
            tenant_id: input.tenantId,
            id: childSessionId,
            created_at_ms: Date.now(),
            parent_session_id: input.parentSessionId,
            next_seq: 1,
            name: `${input.agentName} · subagent`,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("pi_session_lanes")
          .values({
            tenant_id: input.tenantId,
            session_id: childSessionId,
            lane: "main",
            leaf_id: null,
          })
          .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto("turns")
        .values({
          id: childTurnId,
          tenant_id: input.tenantId,
          session_id: childSessionId,
          state: "queued",
          input_kind: "prompt",
          input_text: input.prompt,
          model_profile_id: parent.turnModelProfileId,
          provider: parent.provider,
          model_id: parent.modelId,
          thinking_level: parent.thinkingLevel,
          credential_binding_id: parent.credentialBindingId,
          credential_binding_version: parent.credentialBindingVersion,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
        })
        .executeTakeFirstOrThrow();
      const command = await transaction
        .insertInto("commands")
        .values({
          id: childCommandId,
          tenant_id: input.tenantId,
          session_id: childSessionId,
          turn_id: childTurnId,
          idempotency_key: idempotencyKey,
          kind: "turn.execute",
          state: "pending",
          mailbox_position: 1,
          payload: { schemaVersion: 1, requestHash: fingerprint },
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .returning("created_at")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("runs")
        .values({
          id: childRunId,
          trace_id: traceId(childRunId),
          tenant_id: input.tenantId,
          project_id: parent.projectId,
          workspace_id: parent.workspaceId,
          session_id: childSessionId,
          turn_id: childTurnId,
          command_id: childCommandId,
          environment_version_id: parent.environmentVersionId,
          agent_system_prompt: input.systemPrompt ?? null,
          tool_capability_snapshot: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
          source_set_snapshot: parent.sourceSetSnapshot,
          conversation_base_seq: 0,
          workspace_base_version_id: effectiveWorkspaceVersionId,
          idempotency_key: idempotencyKey,
          state: "queued",
          current_attempt_id: null,
          attempt_count: 0,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          started_at: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("outbox")
        .values({
          id: outboxId,
          tenant_id: input.tenantId,
          aggregate_type: "session",
          aggregate_id: childSessionId,
          topic: TURN_COMMAND_OUTBOX_TOPIC,
          payload: {
            schemaVersion: 1,
            commandId: childCommandId,
            sessionId: childSessionId,
            turnId: childTurnId,
            kind: "turn.execute",
          },
          published_at: null,
          last_error: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ next_mailbox_position: 2, updated_at: command.created_at })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", childSessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("subagent_executions")
        .values({
          id: executionId,
          tenant_id: input.tenantId,
          parent_session_id: input.parentSessionId,
          parent_run_id: input.parentRunId,
          parent_attempt_id: input.parentAttemptId,
          parent_tool_call_id: input.parentToolCallId,
          workflow_run_id: input.workflowRunId,
          step_index: input.stepIndex,
          request_sha256: fingerprint,
          child_session_id: childSessionId,
          child_run_id: childRunId,
          agent_name: input.agentName,
          context_mode: input.contextMode,
          workspace_mode: input.workspaceMode,
          state: "queued",
          result_entry_id: null,
          failure_code: null,
          failure_message: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();

      return { executionId, childSessionId, childRunId, state: "queued" };
    });
  }

  async status(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const row = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("runs as child_run", (join) =>
        join
          .onRef("child_run.tenant_id", "=", "execution.tenant_id")
          .onRef("child_run.id", "=", "execution.child_run_id"),
      )
      .select([
        "execution.id as executionId",
        "execution.child_session_id as childSessionId",
        "execution.child_run_id as childRunId",
        "child_run.state as runState",
        "child_run.failure_code as failureCode",
        "child_run.failure_message as failureMessage",
      ])
      .where("execution.tenant_id", "=", tenantId)
      .where("execution.id", "=", executionId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new PostgresSubagentJobError("not_found", "Subagent execution was not found");
    }
    const state = mapRunState(row.runState);
    const terminal = ["completed", "failed", "cancelled", "unknown"].includes(state);
    await this.#database
      .updateTable("subagent_executions")
      .set({
        state,
        failure_code: state === "failed" ? (row.failureCode ?? "child_run_failed") : null,
        failure_message: state === "failed" ? row.failureMessage : null,
        ...(terminal ? { settled_at: sql<Date>`coalesce(settled_at, now())` } : {}),
        updated_at: sql<Date>`now()`,
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", executionId)
      .executeTakeFirst();
    return {
      executionId: row.executionId,
      childSessionId: row.childSessionId,
      childRunId: row.childRunId,
      state,
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
      ...(row.failureMessage === null ? {} : { failureMessage: row.failureMessage }),
    };
  }

  async result(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const status = await this.status(tenantId, executionId);
    if (status.state !== "completed") return status;
    const repository = new PostgresPiSessionRepository({ database: this.#database, tenantId });
    const session = await repository.openById(status.childSessionId);
    const entries = await session.view("main").findEntriesOnBranch({ order: "newestFirst" });
    const final = entries.find(
      (
        entry,
      ): entry is typeof entry & {
        type: "message";
        message: Extract<AgentMessage, { role: "assistant" }>;
      } => entry.type === "message" && entry.message.role === "assistant",
    );
    const output = final === undefined ? undefined : assistantText(final.message);
    return { ...status, ...(output === undefined ? {} : { output }) };
  }
}
