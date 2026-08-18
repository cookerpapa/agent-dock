import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("session_kind", "text", (column) => column.notNull().defaultTo("conversation"))
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_kind_valid", sql`session_kind in ('conversation', 'subagent')`)
    .execute();

  await db.schema
    .createTable("subagent_executions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("parent_session_id", "uuid", (column) => column.notNull())
    .addColumn("parent_run_id", "uuid", (column) => column.notNull())
    .addColumn("parent_attempt_id", "uuid", (column) => column.notNull())
    .addColumn("parent_tool_call_id", "text", (column) => column.notNull())
    .addColumn("workflow_run_id", "text", (column) => column.notNull())
    .addColumn("step_index", "integer", (column) => column.notNull())
    .addColumn("request_sha256", "text", (column) => column.notNull())
    .addColumn("child_session_id", "uuid", (column) => column.notNull())
    .addColumn("child_run_id", "uuid", (column) => column.notNull())
    .addColumn("agent_name", "text", (column) => column.notNull())
    .addColumn("context_mode", "text", (column) => column.notNull())
    .addColumn("workspace_mode", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("queued"))
    .addColumn("result_entry_id", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_message", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("subagent_executions_tenant_id_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("subagent_executions_child_session_unique", [
      "tenant_id",
      "child_session_id",
    ])
    .addUniqueConstraint("subagent_executions_child_run_unique", ["tenant_id", "child_run_id"])
    .addUniqueConstraint("subagent_executions_parent_step_unique", [
      "tenant_id",
      "parent_run_id",
      "parent_tool_call_id",
      "workflow_run_id",
      "step_index",
    ])
    .addForeignKeyConstraint(
      "subagent_executions_parent_session_fk",
      ["tenant_id", "parent_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "subagent_executions_parent_run_fk",
      ["tenant_id", "parent_run_id"],
      "runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "subagent_executions_parent_attempt_fk",
      ["tenant_id", "parent_run_id", "parent_attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "subagent_executions_child_session_fk",
      ["tenant_id", "child_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "subagent_executions_child_run_fk",
      ["tenant_id", "child_run_id"],
      "runs",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "subagent_executions_parent_tool_call_valid",
      sql`char_length(parent_tool_call_id) between 1 and 256`,
    )
    .addCheckConstraint(
      "subagent_executions_workflow_run_valid",
      sql`char_length(workflow_run_id) between 1 and 256`,
    )
    .addCheckConstraint(
      "subagent_executions_agent_name_valid",
      sql`char_length(agent_name) between 1 and 128`,
    )
    .addCheckConstraint("subagent_executions_step_index_valid", sql`step_index >= 0`)
    .addCheckConstraint(
      "subagent_executions_request_sha256_valid",
      sql`request_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "subagent_executions_context_mode_valid",
      sql`context_mode in ('fresh', 'fork')`,
    )
    .addCheckConstraint(
      "subagent_executions_workspace_mode_valid",
      sql`workspace_mode in ('none', 'shared_serialized', 'isolated')`,
    )
    .addCheckConstraint(
      "subagent_executions_state_valid",
      sql`state in ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')`,
    )
    .addCheckConstraint(
      "subagent_executions_settlement_shape",
      sql`(state in ('completed', 'failed', 'cancelled', 'unknown') and settled_at is not null)
          or (state in ('queued', 'running') and settled_at is null)`,
    )
    .addCheckConstraint(
      "subagent_executions_failure_shape",
      sql`(state in ('failed', 'unknown') and failure_code is not null)
          or (state not in ('failed', 'unknown') and failure_code is null and failure_message is null)`,
    )
    .execute();

  await db.schema
    .createIndex("subagent_executions_parent_active_idx")
    .on("subagent_executions")
    .columns(["tenant_id", "parent_run_id", "state", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("subagent_executions_parent_active_idx").execute();
  await db.schema.dropTable("subagent_executions").execute();
  await db.schema.alterTable("sessions").dropConstraint("sessions_kind_valid").execute();
  await db.schema.alterTable("sessions").dropColumn("session_kind").execute();
}
