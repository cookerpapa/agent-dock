import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_origin_valid")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_execution_shape")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint(
      "workspace_versions_origin_valid",
      sql`origin_kind in ('checkpoint', 'fork', 'migration', 'promotion')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint(
      "workspace_versions_execution_shape",
      sql`(origin_kind = 'checkpoint' and run_id is not null and attempt_id is not null and turn_id is not null)
          or (origin_kind in ('fork', 'migration', 'promotion') and run_id is null and attempt_id is null and turn_id is null)`,
    )
    .execute();

  await db.schema
    .alterTable("workspace_operations")
    .dropConstraint("workspace_operations_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_operations")
    .addCheckConstraint(
      "workspace_operations_kind_valid",
      sql`kind in ('fork', 'rollback', 'archive', 'unarchive', 'promote')`,
    )
    .execute();

  await db.schema
    .createTable("orchestration_runs")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("parent_session_id", "uuid", (column) => column.notNull())
    .addColumn("base_workspace_version_id", "uuid", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull().defaultTo("candidate_race"))
    .addColumn("state", "text", (column) => column.notNull().defaultTo("running"))
    .addColumn("prompt", "text", (column) => column.notNull())
    .addColumn("candidate_specs", "jsonb", (column) => column.notNull())
    .addColumn("acceptance_policy", "jsonb", (column) => column.notNull())
    .addColumn("candidate_count", "integer", (column) => column.notNull())
    .addColumn("maximum_concurrent_candidates", "integer", (column) => column.notNull())
    .addColumn("created_by_user_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("winner_candidate_id", "uuid")
    .addColumn("cancel_idempotency_key", "text")
    .addColumn("cancel_requested_by_user_id", "uuid")
    .addColumn("cancel_requested_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("orchestration_runs_tenant_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("orchestration_runs_parent_key_unique", [
      "parent_session_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "orchestration_runs_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_runs_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_runs_parent_session_fk",
      ["tenant_id", "parent_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_runs_base_version_fk",
      ["tenant_id", "base_workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_runs_actor_fk",
      ["tenant_id", "created_by_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_runs_cancel_actor_fk",
      ["tenant_id", "cancel_requested_by_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint("orchestration_runs_kind_valid", sql`kind = 'candidate_race'`)
    .addCheckConstraint(
      "orchestration_runs_state_valid",
      sql`state in ('running', 'cancel_requested', 'awaiting_decision', 'completed', 'failed', 'cancelled')`,
    )
    .addCheckConstraint(
      "orchestration_runs_prompt_bounded",
      sql`octet_length(prompt) between 1 and 65536`,
    )
    .addCheckConstraint(
      "orchestration_runs_candidate_count_valid",
      sql`candidate_count between 2 and 4`,
    )
    .addCheckConstraint(
      "orchestration_runs_concurrency_valid",
      sql`maximum_concurrent_candidates between 1 and candidate_count`,
    )
    .addCheckConstraint(
      "orchestration_runs_idempotency_bounded",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .addCheckConstraint(
      "orchestration_runs_cancel_key_bounded",
      sql`cancel_idempotency_key is null
          or char_length(cancel_idempotency_key) between 1 and 256`,
    )
    .addCheckConstraint(
      "orchestration_runs_fingerprint_valid",
      sql`request_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "orchestration_runs_terminal_shape",
      sql`(state in ('completed', 'failed', 'cancelled') and settled_at is not null)
          or (state in ('running', 'cancel_requested', 'awaiting_decision') and settled_at is null)`,
    )
    .addCheckConstraint(
      "orchestration_runs_cancel_shape",
      sql`(cancel_requested_at is null and cancel_idempotency_key is null and cancel_requested_by_user_id is null)
          or (cancel_requested_at is not null and cancel_idempotency_key is not null and cancel_requested_by_user_id is not null)`,
    )
    .execute();

  await db.schema
    .createTable("orchestration_candidates")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("orchestration_id", "uuid", (column) => column.notNull())
    .addColumn("ordinal", "integer", (column) => column.notNull())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("strategy", "text", (column) => column.notNull())
    .addColumn("child_session_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("orchestration_candidates_tenant_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("orchestration_candidates_orchestration_id_unique", [
      "tenant_id",
      "orchestration_id",
      "id",
    ])
    .addUniqueConstraint("orchestration_candidates_ordinal_unique", ["orchestration_id", "ordinal"])
    .addUniqueConstraint("orchestration_candidates_run_unique", ["tenant_id", "run_id"])
    .addUniqueConstraint("orchestration_candidates_session_unique", [
      "tenant_id",
      "child_session_id",
    ])
    .addForeignKeyConstraint(
      "orchestration_candidates_orchestration_fk",
      ["tenant_id", "orchestration_id"],
      "orchestration_runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_candidates_session_fk",
      ["tenant_id", "child_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint("orchestration_candidates_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addCheckConstraint("orchestration_candidates_ordinal_valid", sql`ordinal between 1 and 4`)
    .addCheckConstraint(
      "orchestration_candidates_label_bounded",
      sql`octet_length(label) between 1 and 128`,
    )
    .addCheckConstraint(
      "orchestration_candidates_strategy_bounded",
      sql`octet_length(strategy) between 1 and 4096`,
    )
    .execute();

  await db.schema
    .alterTable("orchestration_runs")
    .addForeignKeyConstraint(
      "orchestration_runs_winner_candidate_fk",
      ["tenant_id", "id", "winner_candidate_id"],
      "orchestration_candidates",
      ["tenant_id", "orchestration_id", "id"],
    )
    .execute();

  await db.schema
    .createTable("orchestration_dispatches")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("orchestration_id", "uuid", (column) => column.notNull())
    .addColumn("candidate_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("generation", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("state", "text", (column) => column.notNull().defaultTo("accepted"))
    .addColumn("accepted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("orchestration_dispatches_tenant_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("orchestration_dispatches_candidate_generation_unique", [
      "candidate_id",
      "generation",
    ])
    .addForeignKeyConstraint(
      "orchestration_dispatches_orchestration_fk",
      ["tenant_id", "orchestration_id"],
      "orchestration_runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_dispatches_candidate_fk",
      ["tenant_id", "orchestration_id", "candidate_id"],
      "orchestration_candidates",
      ["tenant_id", "orchestration_id", "id"],
    )
    .addForeignKeyConstraint("orchestration_dispatches_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addCheckConstraint("orchestration_dispatches_generation_positive", sql`generation > 0`)
    .addCheckConstraint(
      "orchestration_dispatches_state_valid",
      sql`state in ('accepted', 'running', 'settled', 'cancelled')`,
    )
    .addCheckConstraint(
      "orchestration_dispatches_settlement_shape",
      sql`(state in ('settled', 'cancelled') and settled_at is not null)
          or (state in ('accepted', 'running') and settled_at is null)`,
    )
    .execute();

  await db.schema
    .createTable("orchestration_acceptance_results")
    .addColumn("candidate_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("orchestration_id", "uuid", (column) => column.notNull())
    .addColumn("verdict", "text", (column) => column.notNull())
    .addColumn("review_bundle_id", "uuid")
    .addColumn("workspace_version_id", "uuid")
    .addColumn("scorecard", "jsonb", (column) => column.notNull())
    .addColumn("evaluated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("orchestration_acceptance_tenant_candidate_unique", [
      "tenant_id",
      "candidate_id",
    ])
    .addForeignKeyConstraint(
      "orchestration_acceptance_candidate_fk",
      ["tenant_id", "orchestration_id", "candidate_id"],
      "orchestration_candidates",
      ["tenant_id", "orchestration_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_acceptance_orchestration_fk",
      ["tenant_id", "orchestration_id"],
      "orchestration_runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_acceptance_review_bundle_fk",
      ["tenant_id", "review_bundle_id"],
      "review_bundles",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_acceptance_workspace_version_fk",
      ["tenant_id", "workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "orchestration_acceptance_verdict_valid",
      sql`verdict in ('passed', 'failed')`,
    )
    .execute();

  await db.schema
    .createTable("orchestration_decision_gates")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("orchestration_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("selected_candidate_id", "uuid")
    .addColumn("resolved_by_user_id", "uuid")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .addUniqueConstraint("orchestration_decision_gates_orchestration_unique", [
      "tenant_id",
      "orchestration_id",
    ])
    .addForeignKeyConstraint(
      "orchestration_decision_gates_orchestration_fk",
      ["tenant_id", "orchestration_id"],
      "orchestration_runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_decision_gates_candidate_fk",
      ["tenant_id", "orchestration_id", "selected_candidate_id"],
      "orchestration_candidates",
      ["tenant_id", "orchestration_id", "id"],
    )
    .addForeignKeyConstraint(
      "orchestration_decision_gates_actor_fk",
      ["tenant_id", "resolved_by_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "orchestration_decision_gates_state_valid",
      sql`state in ('pending', 'resolved', 'cancelled')`,
    )
    .addCheckConstraint(
      "orchestration_decision_gates_resolution_shape",
      sql`(state = 'pending' and selected_candidate_id is null and resolved_by_user_id is null and resolved_at is null)
          or (state = 'resolved' and selected_candidate_id is not null and resolved_by_user_id is not null and resolved_at is not null)
          or (state = 'cancelled' and selected_candidate_id is null and resolved_at is not null)`,
    )
    .execute();

  await db.schema
    .createTable("candidate_promotions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("orchestration_id", "uuid", (column) => column.notNull())
    .addColumn("candidate_id", "uuid", (column) => column.notNull())
    .addColumn("parent_session_id", "uuid", (column) => column.notNull())
    .addColumn("from_workspace_version_id", "uuid", (column) => column.notNull())
    .addColumn("candidate_workspace_version_id", "uuid", (column) => column.notNull())
    .addColumn("promoted_workspace_version_id", "uuid", (column) => column.notNull())
    .addColumn("actor_user_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("candidate_promotions_orchestration_unique", [
      "tenant_id",
      "orchestration_id",
    ])
    .addUniqueConstraint("candidate_promotions_parent_key_unique", [
      "parent_session_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "candidate_promotions_orchestration_fk",
      ["tenant_id", "orchestration_id"],
      "orchestration_runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_candidate_fk",
      ["tenant_id", "orchestration_id", "candidate_id"],
      "orchestration_candidates",
      ["tenant_id", "orchestration_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_parent_session_fk",
      ["tenant_id", "parent_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_from_version_fk",
      ["tenant_id", "from_workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_candidate_version_fk",
      ["tenant_id", "candidate_workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_promoted_version_fk",
      ["tenant_id", "promoted_workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "candidate_promotions_actor_fk",
      ["tenant_id", "actor_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "candidate_promotions_idempotency_bounded",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .execute();

  await sql`
    create function agent_dock_reject_orchestration_acceptance_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'orchestration acceptance results are immutable';
    end
    $$
  `.execute(db);
  await sql`
    create trigger orchestration_acceptance_results_immutable
    before update or delete on orchestration_acceptance_results
    for each row execute function agent_dock_reject_orchestration_acceptance_mutation()
  `.execute(db);

  await db.schema
    .createIndex("orchestration_runs_parent_created_idx")
    .on("orchestration_runs")
    .columns(["tenant_id", "parent_session_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("orchestration_candidates_orchestration_idx")
    .on("orchestration_candidates")
    .columns(["tenant_id", "orchestration_id", "ordinal"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists orchestration_acceptance_results_immutable
    on orchestration_acceptance_results
  `.execute(db);
  await sql`
    drop function if exists agent_dock_reject_orchestration_acceptance_mutation()
  `.execute(db);
  await db.schema.dropTable("candidate_promotions").ifExists().execute();
  await db.schema.dropTable("orchestration_decision_gates").ifExists().execute();
  await db.schema.dropTable("orchestration_acceptance_results").ifExists().execute();
  await db.schema.dropTable("orchestration_dispatches").ifExists().execute();
  await db.schema
    .alterTable("orchestration_runs")
    .dropConstraint("orchestration_runs_winner_candidate_fk")
    .execute();
  await db.schema.dropTable("orchestration_candidates").ifExists().execute();
  await db.schema.dropTable("orchestration_runs").ifExists().execute();

  await db.schema
    .alterTable("workspace_operations")
    .dropConstraint("workspace_operations_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_operations")
    .addCheckConstraint(
      "workspace_operations_kind_valid",
      sql`kind in ('fork', 'rollback', 'archive', 'unarchive')`,
    )
    .execute();

  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_execution_shape")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_origin_valid")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint(
      "workspace_versions_origin_valid",
      sql`origin_kind in ('checkpoint', 'fork', 'migration')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint(
      "workspace_versions_execution_shape",
      sql`(origin_kind = 'checkpoint' and run_id is not null and attempt_id is not null and turn_id is not null)
          or (origin_kind in ('fork', 'migration') and run_id is null and attempt_id is null and turn_id is null)`,
    )
    .execute();
}
