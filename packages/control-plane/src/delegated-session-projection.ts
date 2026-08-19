import type { Database } from "@pi-cloud/database";
import type { DelegatedSessionSummaryResource } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";

export async function loadDelegatedSessionSummaries(
  database: Kysely<Database>,
  input: {
    tenantId: string;
    parentSessionIds: readonly string[];
    maximum: number;
  },
): Promise<{
  items: DelegatedSessionSummaryResource[];
  truncated: boolean;
}> {
  if (input.parentSessionIds.length === 0) return { items: [], truncated: false };
  const rows = await database
    .selectFrom("subagent_executions as execution")
    .innerJoin("sessions as child", (join) =>
      join
        .onRef("child.tenant_id", "=", "execution.tenant_id")
        .onRef("child.id", "=", "execution.child_session_id"),
    )
    .innerJoin("runs as parent_run", (join) =>
      join
        .onRef("parent_run.tenant_id", "=", "execution.tenant_id")
        .onRef("parent_run.id", "=", "execution.parent_run_id"),
    )
    .innerJoin("turns as parent_turn", (join) =>
      join
        .onRef("parent_turn.tenant_id", "=", "parent_run.tenant_id")
        .onRef("parent_turn.id", "=", "parent_run.turn_id"),
    )
    .innerJoin("projects as project", (join) =>
      join
        .onRef("project.tenant_id", "=", "child.tenant_id")
        .onRef("project.id", "=", "child.project_id"),
    )
    .select([
      "execution.id as executionId",
      "execution.child_session_id as sessionId",
      "execution.parent_session_id as parentSessionId",
      "parent_run.turn_id as parentTurnId",
      "child.title as title",
      "execution.agent_name as agentName",
      "execution.context_mode as contextMode",
      "execution.workspace_mode as workspaceMode",
      "execution.state as state",
      "project.name as workspaceName",
      "execution.created_at as createdAt",
      "execution.settled_at as settledAt",
    ])
    .where("execution.tenant_id", "=", input.tenantId)
    .where("execution.parent_session_id", "in", input.parentSessionIds)
    .where("parent_turn.pruned_at", "is", null)
    .where("child.archived_at", "is", null)
    .orderBy("execution.created_at", "asc")
    .orderBy("execution.id", "asc")
    .limit(input.maximum + 1)
    .execute();
  return {
    items: rows.slice(0, input.maximum).map((row) => ({
      executionId: row.executionId,
      sessionId: row.sessionId,
      parentSessionId: row.parentSessionId,
      parentTurnId: row.parentTurnId,
      title: row.title,
      agentName: row.agentName,
      contextMode: row.contextMode,
      workspaceMode: row.workspaceMode,
      state: row.state,
      workspaceName: row.workspaceName,
      createdAt: new Date(row.createdAt).toISOString(),
      ...(row.settledAt === null ? {} : { settledAt: new Date(row.settledAt).toISOString() }),
    })),
    truncated: rows.length > input.maximum,
  };
}
