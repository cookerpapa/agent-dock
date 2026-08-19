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
  TURN_CANCELLATION_OUTBOX_TOPIC,
  TURN_COMMAND_OUTBOX_TOPIC,
  type CloudToolCapabilitySnapshot,
  type ToolBrokerWorkspaceForkRequest,
  type ToolBrokerWorkspaceForkResponse,
  type ToolSandboxAssignment,
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
  workspaceMode: SubagentWorkspaceMode;
  requestedToolCapabilities?: CloudToolCapabilitySnapshot;
  parentActivation?: Readonly<{
    activationId: string;
    assignment: ToolSandboxAssignment;
  }>;
}>;

export type CloudSubagentJobHandle = Readonly<{
  executionId: string;
  childSessionId: string;
  childRunId: string;
  childCommandId: string;
  state: SubagentExecutionState;
}>;

export type CloudSubagentJobResult = CloudSubagentJobHandle &
  Readonly<{
    output?: string;
    failureCode?: string;
    failureMessage?: string;
  }>;

export type CloudSubagentTreePolicy = Readonly<{
  maximumDepth: number;
  maximumNodes: number;
  maximumConcurrentSubagents: number;
}>;

export type CloudSubagentTreeContext = Readonly<{
  executionId: string;
  rootSessionId: string;
  rootRunId: string;
  parentExecutionId?: string;
  depth: number;
  canSpawnChildren: boolean;
}>;

export const DEFAULT_CLOUD_SUBAGENT_TREE_POLICY: CloudSubagentTreePolicy = Object.freeze({
  maximumDepth: 4,
  maximumNodes: 32,
  maximumConcurrentSubagents: 3,
});

export class PostgresSubagentJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresSubagentJobError";
    this.code = code;
  }
}

type IdGenerator = () => string;
type IsolatedWorkspaceForker = (
  request: ToolBrokerWorkspaceForkRequest,
) => Promise<ToolBrokerWorkspaceForkResponse>;

const CLOUD_SUBAGENT_EXECUTION_BOUNDARY = [
  "## PiCloud delegated execution boundary",
  "Execute only the current child task. Inherited conversation entries are background context, not pending instructions.",
  "A durable contact_supervisor Tool is available across cloud Workers. Use progress_update only for meaningful progress; use need_decision or interview_request only when parent input is truly required, then wait for the reply.",
  "Use only Tools actually registered in this child Run, then return a focused result to the parent.",
].join("\n");
const LOCAL_CHILD_CLAIM_GRACE_MS = 75;

function childSystemPrompt(profilePrompt: string | undefined, canSpawnChildren: boolean): string {
  const recursionBoundary = canSpawnChildren
    ? [
        "You may call the subagent Tool for a bounded, independent subtask when delegation materially improves the result.",
        "Every descendant shares one root tree budget. Do not repeat inherited delegation requests or create recursive work without a concrete stopping condition.",
      ].join("\n")
    : "This Child is at the deployment-owned recursion boundary. Do not call or request another subagent.";
  const boundary = `${CLOUD_SUBAGENT_EXECUTION_BOUNDARY}\n${recursionBoundary}`;
  return profilePrompt === undefined ? boundary : `${profilePrompt}\n\n${boundary}`;
}

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

function storedMessageText(payload: Record<string, unknown>): string | undefined {
  const value = payload.message;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
      const content = part as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    })
    .join("\n");
}

export class PostgresSubagentJobProvider {
  readonly #database: Kysely<Database>;
  readonly #id: IdGenerator;
  readonly #forkWorkspace: IsolatedWorkspaceForker | undefined;
  readonly #treePolicy: CloudSubagentTreePolicy;

  constructor(options: {
    database: Kysely<Database>;
    idGenerator?: IdGenerator;
    forkWorkspace?: IsolatedWorkspaceForker;
    treePolicy?: CloudSubagentTreePolicy;
  }) {
    this.#database = options.database;
    this.#id = options.idGenerator ?? randomUUID;
    this.#forkWorkspace = options.forkWorkspace;
    const treePolicy = options.treePolicy ?? DEFAULT_CLOUD_SUBAGENT_TREE_POLICY;
    for (const [name, value] of Object.entries(treePolicy)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new TypeError(`Subagent tree policy ${name} is invalid`);
      }
    }
    if (treePolicy.maximumConcurrentSubagents > treePolicy.maximumNodes) {
      throw new TypeError("Subagent tree concurrency exceeds its node budget");
    }
    this.#treePolicy = { ...treePolicy };
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
    if (
      input.workspaceMode !== "none" &&
      input.workspaceMode !== "shared_serialized" &&
      input.workspaceMode !== "isolated"
    ) {
      throw new TypeError("Subagent Workspace mode is invalid");
    }
    if (input.workspaceMode === "isolated" && input.parentActivation === undefined) {
      throw new PostgresSubagentJobError(
        "parent_sandbox_unavailable",
        "Isolated Subagent execution requires an active parent Sandbox",
      );
    }

    const pending = await this.#database.transaction().execute(async (transaction) => {
      const replay = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as child_run", (join) =>
          join
            .onRef("child_run.tenant_id", "=", "execution.tenant_id")
            .onRef("child_run.id", "=", "execution.child_run_id"),
        )
        .select([
          "execution.id",
          "execution.child_session_id",
          "execution.child_run_id",
          "execution.state",
          "execution.request_sha256",
          "child_run.command_id as childCommandId",
        ])
        .where("execution.tenant_id", "=", input.tenantId)
        .where("execution.parent_run_id", "=", input.parentRunId)
        .where("execution.parent_tool_call_id", "=", input.parentToolCallId)
        .where("execution.workflow_run_id", "=", input.workflowRunId)
        .where("execution.step_index", "=", input.stepIndex)
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
          "parent_session.session_kind as sessionKind",
          "parent_session.workspace_snapshot_key as workspaceSnapshotKey",
          "parent_session.current_workspace_version_id as sessionWorkspaceVersionId",
          "parent_session.forked_from_session_id as forkedFromSessionId",
          "parent_workspace.current_workspace_version_id as workspaceVersionId",
          "parent_workspace.sandbox_domain_id as sandboxDomainId",
          "parent_turn.model_profile_id as turnModelProfileId",
          "parent_turn.input_text as parentPrompt",
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
          childCommandId: replay.childCommandId,
          state: replay.state,
          prepareIsolated: replay.state === "preparing",
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

      const parentExecution =
        parent.sessionKind === "subagent"
          ? await transaction
              .selectFrom("subagent_executions")
              .select([
                "id",
                "root_session_id as rootSessionId",
                "root_run_id as rootRunId",
                "depth",
              ])
              .where("tenant_id", "=", input.tenantId)
              .where("child_session_id", "=", input.parentSessionId)
              .where("child_run_id", "=", input.parentRunId)
              .executeTakeFirst()
          : undefined;
      if (parent.sessionKind === "subagent" && parentExecution === undefined) {
        throw new PostgresSubagentJobError(
          "parent_tree_invalid",
          "Parent Subagent is missing its durable tree identity",
        );
      }
      const treeContext = {
        rootSessionId: parentExecution?.rootSessionId ?? input.parentSessionId,
        rootRunId: parentExecution?.rootRunId ?? input.parentRunId,
        parentExecutionId: parentExecution?.id ?? null,
        depth: (parentExecution?.depth ?? 0) + 1,
      };
      if (treeContext.depth > this.#treePolicy.maximumDepth) {
        throw new PostgresSubagentJobError(
          "subagent_tree_depth_exhausted",
          `Subagent tree depth limit ${String(this.#treePolicy.maximumDepth)} was reached`,
        );
      }
      if (treeContext.rootRunId !== input.parentRunId) {
        const rootRun = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", treeContext.rootRunId)
          .forUpdate()
          .executeTakeFirst();
        if (rootRun === undefined) {
          throw new PostgresSubagentJobError(
            "parent_tree_invalid",
            "Subagent root Run was not found",
          );
        }
      }
      const treeNodes = await transaction
        .selectFrom("subagent_executions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.tenantId)
        .where("root_run_id", "=", treeContext.rootRunId)
        .executeTakeFirstOrThrow();
      const activeTreeNodes = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as child_run", (join) =>
          join
            .onRef("child_run.tenant_id", "=", "execution.tenant_id")
            .onRef("child_run.id", "=", "execution.child_run_id"),
        )
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("execution.tenant_id", "=", input.tenantId)
        .where("execution.root_run_id", "=", treeContext.rootRunId)
        .where("child_run.state", "in", ["queued", "claimed", "running"])
        .executeTakeFirstOrThrow();
      if (Number(treeNodes.count) >= this.#treePolicy.maximumNodes) {
        throw new PostgresSubagentJobError(
          "subagent_tree_node_budget_exhausted",
          `Subagent tree node limit ${String(this.#treePolicy.maximumNodes)} was reached`,
        );
      }
      if (Number(activeTreeNodes.count) >= this.#treePolicy.maximumConcurrentSubagents) {
        throw new PostgresSubagentJobError(
          "subagent_tree_concurrency_exhausted",
          `Subagent tree concurrency limit ${String(this.#treePolicy.maximumConcurrentSubagents)} was reached`,
        );
      }

      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select(["maximum_sessions", "maximum_unsettled_turns", "maximum_concurrent_turns"])
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (Number(activeTreeNodes.count) + 2 > policy.maximum_concurrent_turns) {
        throw new PostgresSubagentJobError(
          "tenant_subagent_concurrency_exhausted",
          "Tenant concurrent-Run quota has no lane for another recursive Subagent",
        );
      }
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
      const childWorkspaceId = input.workspaceMode === "isolated" ? this.#id() : parent.workspaceId;
      const idempotencyKey = `subagent:${executionId}`;
      const effectiveWorkspaceVersionId =
        input.workspaceMode === "isolated"
          ? null
          : parent.forkedFromSessionId === null
            ? parent.workspaceVersionId
            : parent.sessionWorkspaceVersionId;

      if (input.workspaceMode === "isolated") {
        await transaction
          .insertInto("workspaces")
          .values({
            id: childWorkspaceId,
            tenant_id: input.tenantId,
            project_id: parent.projectId,
            sandbox_domain_id: parent.sandboxDomainId,
            object_snapshot_key: null,
            workspace_kind: "subagent_isolated",
            parent_workspace_id: parent.workspaceId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("workspace_sources")
          .values({
            tenant_id: input.tenantId,
            workspace_id: childWorkspaceId,
            kind: "empty",
            repository: null,
            commit_sha: null,
            status: "ready",
            object_key: null,
            sha256: null,
            size_bytes: null,
            import_lease_id: null,
            lease_expires_at: null,
            failure_code: null,
            github_installation_id: null,
            github_repository_id: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("sandbox_domains")
          .set({
            assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where("id", "=", parent.sandboxDomainId)
          .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto("sessions")
        .values({
          id: childSessionId,
          title: `${input.agentName} · subagent`,
          tenant_id: input.tenantId,
          project_id: parent.projectId,
          workspace_id: childWorkspaceId,
          desired_model_profile_id: parent.modelProfileId,
          state: "cold",
          sandbox_retention_policy: "ephemeral",
          session_kind: "subagent",
          tool_capabilities: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
          workspace_snapshot_key:
            input.workspaceMode === "isolated" ? null : parent.workspaceSnapshotKey,
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
        let forkBoundaryEntryId = leaf.leaf_id;
        if (leaf.leaf_id !== null && parent.parentPrompt !== null) {
          const branch = await sql<{
            id: string;
            seq: string;
            type: string;
            payload: Record<string, unknown>;
          }>`
            with recursive branch as (
              select id, seq, parent_id, type, payload
                from pi_session_visible_entries
               where tenant_id = ${input.tenantId}::uuid
                 and session_id = ${input.parentSessionId}
                 and id = ${leaf.leaf_id}
              union all
              select parent.id, parent.seq, parent.parent_id, parent.type, parent.payload
                from pi_session_visible_entries parent
                join branch child on child.parent_id = parent.id
               where parent.tenant_id = ${input.tenantId}::uuid
                 and parent.session_id = ${input.parentSessionId}
            )
            select id, seq, type, payload
              from branch
             where type = 'message'
             order by seq::bigint desc
          `.execute(transaction);
          const currentPrompt = branch.rows.find(
            (entry) => storedMessageText(entry.payload) === parent.parentPrompt,
          );
          if (currentPrompt !== undefined) forkBoundaryEntryId = currentPrompt.id;
        }
        await forkPostgresPiSessionInTransaction(
          transaction,
          input.tenantId,
          input.parentSessionId,
          childSessionId,
          {
            id: childSessionId,
            parentSessionId: input.parentSessionId,
            scope: "branch",
            ...(forkBoundaryEntryId === null
              ? {}
              : { entryId: forkBoundaryEntryId, position: "before" as const }),
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
          workspace_id: childWorkspaceId,
          session_id: childSessionId,
          turn_id: childTurnId,
          command_id: childCommandId,
          environment_version_id: parent.environmentVersionId,
          agent_system_prompt: childSystemPrompt(
            input.systemPrompt,
            treeContext.depth < this.#treePolicy.maximumDepth,
          ),
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
      if (input.workspaceMode !== "isolated") {
        await transaction
          .insertInto("outbox")
          .values({
            id: this.#id(),
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
            // The creating Worker may immediately claim this durable Child by
            // command ID when its reserved Child lane is free. The shared
            // queue becomes eligible shortly afterwards, so locality never
            // turns into a persistent affinity or capacity wait.
            available_at: new Date(Date.now() + LOCAL_CHILD_CLAIM_GRACE_MS),
            published_at: null,
            last_error: null,
          })
          .executeTakeFirstOrThrow();
      }
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
          root_session_id: treeContext.rootSessionId,
          root_run_id: treeContext.rootRunId,
          parent_execution_id: treeContext.parentExecutionId,
          depth: treeContext.depth,
          workflow_run_id: input.workflowRunId,
          step_index: input.stepIndex,
          request_sha256: fingerprint,
          child_session_id: childSessionId,
          child_run_id: childRunId,
          child_workspace_id: input.workspaceMode === "isolated" ? childWorkspaceId : null,
          agent_name: input.agentName,
          context_mode: input.contextMode,
          workspace_mode: input.workspaceMode,
          state: input.workspaceMode === "isolated" ? "preparing" : "queued",
          result_entry_id: null,
          failure_code: null,
          failure_message: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();

      return {
        executionId,
        childSessionId,
        childRunId,
        childCommandId,
        state: input.workspaceMode === "isolated" ? ("preparing" as const) : ("queued" as const),
        prepareIsolated: input.workspaceMode === "isolated",
      };
    });
    if (pending.prepareIsolated) return this.#prepareIsolated(input, pending);
    return pending;
  }

  async #prepareIsolated(
    input: StartCloudSubagentJobInput,
    pending: CloudSubagentJobHandle,
  ): Promise<CloudSubagentJobHandle> {
    const activation = input.parentActivation;
    const forkWorkspace = this.#forkWorkspace;
    if (activation === undefined || forkWorkspace === undefined) {
      await this.#failPreparation(input.tenantId, pending, "workspace_fork_unavailable");
      throw new PostgresSubagentJobError(
        "workspace_fork_unavailable",
        "Isolated Workspace fork service is unavailable",
      );
    }
    const target = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("sessions as child", (join) =>
        join
          .onRef("child.tenant_id", "=", "execution.tenant_id")
          .onRef("child.id", "=", "execution.child_session_id"),
      )
      .select([
        "execution.state",
        "execution.child_workspace_id as workspaceId",
        "child.project_id as projectId",
        "child.id as sessionId",
      ])
      .where("execution.tenant_id", "=", input.tenantId)
      .where("execution.id", "=", pending.executionId)
      .executeTakeFirstOrThrow();
    if (target.state !== "preparing") return { ...pending, state: target.state };
    if (
      target.workspaceId === null ||
      activation.assignment.tenantId !== input.tenantId ||
      activation.assignment.projectId !== target.projectId ||
      activation.assignment.workspaceId === target.workspaceId ||
      activation.assignment.sessionId !== input.parentSessionId ||
      activation.assignment.attemptId !== input.parentAttemptId ||
      activation.assignment.fencingToken !== input.parentFencingToken
    ) {
      await this.#failPreparation(input.tenantId, pending, "workspace_fork_identity_invalid");
      throw new PostgresSubagentJobError(
        "workspace_fork_identity_invalid",
        "Isolated Workspace fork did not match the parent Run authority",
      );
    }
    try {
      await forkWorkspace({
        toolBrokerProtocolVersion: 1,
        type: "workspace.fork",
        requestId: pending.executionId,
        sourceActivationId: activation.activationId,
        sourceAssignment: activation.assignment,
        target: {
          tenantId: input.tenantId,
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
        },
      });
      return await this.#database.transaction().execute(async (transaction) => {
        const authority = await transaction
          .selectFrom("runs as parent_run")
          .innerJoin("run_attempts as parent_attempt", (join) =>
            join
              .onRef("parent_attempt.tenant_id", "=", "parent_run.tenant_id")
              .onRef("parent_attempt.run_id", "=", "parent_run.id")
              .onRef("parent_attempt.id", "=", "parent_run.current_attempt_id"),
          )
          .select([
            "parent_run.state as runState",
            "parent_run.current_attempt_id as attemptId",
            "parent_attempt.state as attemptState",
            "parent_attempt.fencing_token as fencingToken",
          ])
          .where("parent_run.tenant_id", "=", input.tenantId)
          .where("parent_run.id", "=", input.parentRunId)
          .forUpdate(["parent_run", "parent_attempt"])
          .executeTakeFirst();
        const execution = await transaction
          .selectFrom("subagent_executions")
          .select(["state", "child_session_id", "child_run_id"])
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", pending.executionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (execution.state !== "preparing") {
          return { ...pending, state: execution.state };
        }
        if (
          authority?.runState !== "running" ||
          authority.attemptState !== "running" ||
          authority.attemptId !== input.parentAttemptId ||
          Number(authority.fencingToken) !== input.parentFencingToken
        ) {
          throw new PostgresSubagentJobError(
            "parent_authority_expired",
            "Parent Agent Run lost authority while preparing the isolated Workspace",
          );
        }
        await transaction
          .insertInto("outbox")
          .values({
            id: this.#id(),
            tenant_id: input.tenantId,
            aggregate_type: "session",
            aggregate_id: execution.child_session_id,
            topic: TURN_COMMAND_OUTBOX_TOPIC,
            payload: {
              schemaVersion: 1,
              commandId: await transaction
                .selectFrom("runs")
                .select("command_id")
                .where("id", "=", execution.child_run_id)
                .executeTakeFirstOrThrow()
                .then((run) => run.command_id),
              sessionId: execution.child_session_id,
              turnId: await transaction
                .selectFrom("runs")
                .select("turn_id")
                .where("id", "=", execution.child_run_id)
                .executeTakeFirstOrThrow()
                .then((run) => run.turn_id),
              kind: "turn.execute",
            },
            available_at: new Date(Date.now() + LOCAL_CHILD_CLAIM_GRACE_MS),
            published_at: null,
            last_error: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "queued", updated_at: sql<Date>`now()` })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", pending.executionId)
          .where("state", "=", "preparing")
          .executeTakeFirstOrThrow();
        return { ...pending, state: "queued" as const };
      });
    } catch (error: unknown) {
      await this.#failPreparation(input.tenantId, pending, "workspace_fork_failed").catch(
        () => undefined,
      );
      throw error;
    }
  }

  async #failPreparation(
    tenantId: string,
    pending: CloudSubagentJobHandle,
    failureCode: string,
  ): Promise<void> {
    const now = new Date();
    await this.#database.transaction().execute(async (transaction) => {
      const execution = await transaction
        .selectFrom("subagent_executions")
        .select(["state", "child_session_id", "child_run_id", "child_workspace_id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", pending.executionId)
        .forUpdate()
        .executeTakeFirst();
      if (execution === undefined || execution.state !== "preparing") return;
      const run = await transaction
        .selectFrom("runs")
        .select(["turn_id", "command_id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_run_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("subagent_executions")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: "Isolated Workspace preparation failed",
          settled_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", pending.executionId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: "Isolated Workspace preparation failed",
          failure_retryable: false,
          settled_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_run_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: "Isolated Workspace preparation failed",
          failure_retryable: false,
          settled_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", run.turn_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("commands")
        .set({ state: "failed", failure_code: failureCode, completed_at: now })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", run.command_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "failed", updated_at: now })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_session_id)
        .executeTakeFirstOrThrow();
      if (execution.child_workspace_id !== null) {
        const workspace = await transaction
          .updateTable("workspaces")
          .set({ deleted_at: now, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", execution.child_workspace_id)
          .where("deleted_at", "is", null)
          .returning("sandbox_domain_id")
          .executeTakeFirst();
        if (workspace !== undefined) {
          await transaction
            .updateTable("sandbox_domains")
            .set({
              assigned_workspaces: sql<string>`greatest(${sql.ref("assigned_workspaces")} - 1, 0)`,
              updated_at: now,
            })
            .where("id", "=", workspace.sandbox_domain_id)
            .executeTakeFirst();
        }
      }
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
        "child_run.command_id as childCommandId",
        "execution.child_workspace_id as childWorkspaceId",
        "execution.workspace_mode as workspaceMode",
        "execution.state as executionState",
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
    if (row.executionState === "preparing") {
      return {
        executionId: row.executionId,
        childSessionId: row.childSessionId,
        childRunId: row.childRunId,
        childCommandId: row.childCommandId,
        state: "preparing",
      };
    }
    const state = mapRunState(row.runState);
    const terminal = ["completed", "failed", "cancelled", "unknown"].includes(state);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
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
      if (terminal && row.workspaceMode === "isolated" && row.childWorkspaceId !== null) {
        const workspace = await transaction
          .updateTable("workspaces")
          .set({ deleted_at: sql<Date>`coalesce(deleted_at, now())`, updated_at: sql<Date>`now()` })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.childWorkspaceId)
          .where("deleted_at", "is", null)
          .returning("sandbox_domain_id")
          .executeTakeFirst();
        if (workspace !== undefined) {
          await transaction
            .updateTable("sandbox_domains")
            .set({
              assigned_workspaces: sql<string>`greatest(${sql.ref("assigned_workspaces")} - 1, 0)`,
              updated_at: sql<Date>`now()`,
            })
            .where("id", "=", workspace.sandbox_domain_id)
            .executeTakeFirst();
        }
      }
    });
    return {
      executionId: row.executionId,
      childSessionId: row.childSessionId,
      childRunId: row.childRunId,
      childCommandId: row.childCommandId,
      state,
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
      ...(row.failureMessage === null ? {} : { failureMessage: row.failureMessage }),
    };
  }

  async treeContext(tenantId: string, childRunId: string): Promise<CloudSubagentTreeContext> {
    const row = await this.#database
      .selectFrom("subagent_executions")
      .select([
        "id as executionId",
        "root_session_id as rootSessionId",
        "root_run_id as rootRunId",
        "parent_execution_id as parentExecutionId",
        "depth",
      ])
      .where("tenant_id", "=", tenantId)
      .where("child_run_id", "=", childRunId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new PostgresSubagentJobError(
        "parent_tree_invalid",
        "Subagent Run is missing its durable tree identity",
      );
    }
    const nodeCount = await this.#database
      .selectFrom("subagent_executions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("root_run_id", "=", row.rootRunId)
      .executeTakeFirstOrThrow();
    return {
      executionId: row.executionId,
      rootSessionId: row.rootSessionId,
      rootRunId: row.rootRunId,
      ...(row.parentExecutionId === null ? {} : { parentExecutionId: row.parentExecutionId }),
      depth: row.depth,
      canSpawnChildren:
        row.depth < this.#treePolicy.maximumDepth &&
        Number(nodeCount.count) < this.#treePolicy.maximumNodes,
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
    const assistantOutput = final === undefined ? undefined : assistantText(final.message);
    const patch = await this.#database
      .selectFrom("workspace_versions as version")
      .innerJoin("artifacts as artifact", "artifact.id", "version.patch_artifact_id")
      .innerJoin("checkpoint_objects as object", "object.object_key", "artifact.object_key")
      .select(["object.bytes", "object.sha256", "object.size_bytes as sizeBytes"])
      .where("version.tenant_id", "=", tenantId)
      .where("version.run_id", "=", status.childRunId)
      .where("version.state", "=", "settled")
      .executeTakeFirst();
    let patchOutput: string | undefined;
    if (patch !== undefined) {
      const bytes = Buffer.from(patch.bytes);
      if (
        Number(patch.sizeBytes) === bytes.byteLength &&
        createHash("sha256").update(bytes).digest("hex") === patch.sha256
      ) {
        const maximumPatchBytes = 128 * 1_024;
        const visible = bytes.subarray(0, maximumPatchBytes).toString("utf8");
        patchOutput = [
          "Isolated Workspace patch:",
          "```diff",
          visible,
          bytes.byteLength > maximumPatchBytes
            ? "\n[patch truncated; inspect the child artifact for the complete diff]"
            : "",
          "```",
        ].join("\n");
      }
    }
    const outputParts = [assistantOutput, patchOutput].filter(
      (value): value is string => value !== undefined,
    );
    const output = outputParts.length === 0 ? undefined : outputParts.join("\n\n");
    return { ...status, ...(output === undefined ? {} : { output }) };
  }

  async cancel(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const childExecutions = await this.#database
      .selectFrom("subagent_executions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("parent_execution_id", "=", executionId)
      .orderBy("created_at", "desc")
      .execute();
    for (const child of childExecutions) await this.cancel(tenantId, child.id);
    await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "execution.tenant_id")
            .onRef("run.id", "=", "execution.child_run_id"),
        )
        .innerJoin("commands as target", (join) =>
          join
            .onRef("target.tenant_id", "=", "run.tenant_id")
            .onRef("target.id", "=", "run.command_id"),
        )
        .select([
          "execution.state as executionState",
          "execution.child_session_id as sessionId",
          "execution.child_run_id as runId",
          "run.state as runState",
          "run.turn_id as turnId",
          "target.id as targetCommandId",
          "target.state as targetCommandState",
        ])
        .where("execution.tenant_id", "=", tenantId)
        .where("execution.id", "=", executionId)
        .forUpdate(["execution", "run", "target"])
        .executeTakeFirst();
      if (row === undefined) {
        throw new PostgresSubagentJobError("not_found", "Subagent execution was not found");
      }
      if (["completed", "failed", "cancelled", "unknown"].includes(row.executionState)) return;
      const now = new Date();
      if (
        row.executionState === "preparing" ||
        (row.runState === "queued" && row.targetCommandState !== "acknowledged")
      ) {
        await transaction
          .updateTable("outbox")
          .set({ published_at: now, last_error: "subagent_cancelled_before_start" })
          .where("tenant_id", "=", tenantId)
          .where("aggregate_id", "=", row.sessionId)
          .where("published_at", "is", null)
          .execute();
        await transaction
          .updateTable("commands")
          .set({ state: "failed", failure_code: "subagent_cancelled", completed_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.targetCommandId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("runs")
          .set({ state: "cancelled", settled_at: now, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.runId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("turns")
          .set({ state: "cancelled", settled_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.turnId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "cancelled", settled_at: now, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", executionId)
          .executeTakeFirstOrThrow();
        return;
      }
      const existing = await transaction
        .selectFrom("commands")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", row.sessionId)
        .where("turn_id", "=", row.turnId)
        .where("kind", "=", "turn.cancel")
        .where("state", "in", ["pending", "dispatched", "acknowledged"])
        .executeTakeFirst();
      if (existing !== undefined) return;
      const commandId = this.#id();
      await transaction
        .insertInto("commands")
        .values({
          id: commandId,
          tenant_id: tenantId,
          session_id: row.sessionId,
          turn_id: row.turnId,
          idempotency_key: `subagent-cancel:${executionId}`,
          kind: "turn.cancel",
          state: "pending",
          mailbox_position: null,
          payload: {
            schemaVersion: 1,
            targetCommandId: row.targetCommandId,
            reason: "user_request",
            gracePeriodMs: 2_000,
          },
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("outbox")
        .values({
          id: this.#id(),
          tenant_id: tenantId,
          aggregate_type: "session",
          aggregate_id: row.sessionId,
          topic: TURN_CANCELLATION_OUTBOX_TOPIC,
          payload: {
            schemaVersion: 1,
            commandId,
            targetCommandId: row.targetCommandId,
            sessionId: row.sessionId,
            turnId: row.turnId,
            kind: "turn.cancel",
          },
          published_at: null,
          last_error: null,
        })
        .executeTakeFirstOrThrow();
    });
    return this.status(tenantId, executionId);
  }

  async reapStalePreparations(maximumAgeMs = 20 * 60_000, limit = 32): Promise<number> {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 60_000) {
      throw new TypeError("Subagent preparation maximum age is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Subagent preparation reaper limit is invalid");
    }
    const terminal = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("runs as child_run", (join) =>
        join
          .onRef("child_run.tenant_id", "=", "execution.tenant_id")
          .onRef("child_run.id", "=", "execution.child_run_id"),
      )
      .select(["execution.tenant_id as tenantId", "execution.id"])
      .where("execution.state", "in", ["queued", "running"])
      .where("child_run.state", "in", [
        "completed",
        "failed",
        "cancelled",
        "timed_out",
        "superseded",
      ])
      .orderBy("child_run.settled_at", "asc")
      .limit(limit)
      .execute();
    for (const row of terminal) {
      const activeChildren = await this.#database
        .selectFrom("subagent_executions")
        .select("id")
        .where("tenant_id", "=", row.tenantId)
        .where("parent_execution_id", "=", row.id)
        .where("state", "in", ["preparing", "queued", "running"])
        .execute();
      for (const child of activeChildren) await this.cancel(row.tenantId, child.id);
      await this.status(row.tenantId, row.id);
    }

    const stale = await this.#database
      .selectFrom("subagent_executions")
      .select([
        "tenant_id as tenantId",
        "id",
        "child_session_id as childSessionId",
        "child_run_id as childRunId",
        "state",
      ])
      .where("state", "=", "preparing")
      .where("updated_at", "<", new Date(Date.now() - maximumAgeMs))
      .orderBy("updated_at", "asc")
      .limit(limit)
      .execute();
    let reaped = terminal.length;
    for (const row of stale) {
      await this.#failPreparation(
        row.tenantId,
        {
          executionId: row.id,
          childSessionId: row.childSessionId,
          childRunId: row.childRunId,
          childCommandId: await this.#database
            .selectFrom("runs")
            .select("command_id")
            .where("tenant_id", "=", row.tenantId)
            .where("id", "=", row.childRunId)
            .executeTakeFirstOrThrow()
            .then((run) => run.command_id),
          state: row.state,
        },
        "workspace_fork_abandoned",
      );
      reaped += 1;
    }
    return reaped;
  }
}
