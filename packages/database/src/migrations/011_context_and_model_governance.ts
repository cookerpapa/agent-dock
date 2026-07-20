import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addColumn("maximum_model_requests_per_run", "integer", (column) =>
      column.notNull().defaultTo(32),
    )
    .addColumn("maximum_tokens_per_run", "bigint", (column) => column.notNull().defaultTo(200_000))
    .addColumn("maximum_cost_microusd_per_run", "bigint", (column) =>
      column.notNull().defaultTo(5_000_000),
    )
    .addColumn("daily_token_budget", "bigint", (column) => column.notNull().defaultTo(2_000_000))
    .addColumn("monthly_cost_microusd_budget", "bigint", (column) =>
      column.notNull().defaultTo(50_000_000),
    )
    .addColumn("maximum_tool_calls_per_run", "integer", (column) => column.notNull().defaultTo(128))
    .addColumn("maximum_tool_output_bytes", "integer", (column) =>
      column.notNull().defaultTo(65_536),
    )
    .addColumn("maximum_run_duration_ms", "integer", (column) =>
      column.notNull().defaultTo(900_000),
    )
    .addColumn("compaction_reserve_tokens", "integer", (column) =>
      column.notNull().defaultTo(16_384),
    )
    .addColumn("compaction_keep_recent_tokens", "integer", (column) =>
      column.notNull().defaultTo(20_000),
    )
    .execute();

  await db.schema
    .alterTable("tenant_runtime_policies")
    .addCheckConstraint(
      "tenant_runtime_policies_governance_positive",
      sql`maximum_model_requests_per_run between 1 and 1024
          and maximum_tokens_per_run between 1 and 1000000000
          and maximum_cost_microusd_per_run between 1 and 1000000000000
          and daily_token_budget between 1 and 1000000000000
          and monthly_cost_microusd_budget between 1 and 1000000000000000
          and maximum_tool_calls_per_run between 1 and 10000
          and maximum_tool_output_bytes between 1024 and 1048576
          and maximum_run_duration_ms between 1000 and 3600000
          and compaction_reserve_tokens between 1024 and 1000000
          and compaction_keep_recent_tokens between 1024 and 1000000`,
    )
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addCheckConstraint(
      "tenant_runtime_policies_context_budget_valid",
      sql`compaction_reserve_tokens + compaction_keep_recent_tokens <= maximum_tokens_per_run`,
    )
    .execute();

  await db.schema
    .createTable("model_rates")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("input_microusd_per_million", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("output_microusd_per_million", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("cache_read_microusd_per_million", "bigint", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("cache_write_microusd_per_million", "bigint", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("model_rates_pk", ["tenant_id", "provider", "model_id"])
    .addForeignKeyConstraint("model_rates_tenant_fk", ["tenant_id"], "tenants", ["id"])
    .addCheckConstraint(
      "model_rates_identity_bounded",
      sql`char_length(provider) between 1 and 128 and char_length(model_id) between 1 and 256`,
    )
    .addCheckConstraint(
      "model_rates_nonnegative",
      sql`input_microusd_per_million >= 0 and output_microusd_per_million >= 0
          and cache_read_microusd_per_million >= 0
          and cache_write_microusd_per_million >= 0`,
    )
    .execute();

  await sql`
    insert into model_rates (tenant_id, provider, model_id)
    select distinct tenant_id, provider, model_id
      from model_profiles
    on conflict do nothing
  `.execute(db);

  await db.schema
    .createTable("model_routing_policies")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("fallback_provider", "text")
    .addColumn("fallback_model_id", "text")
    .addColumn("fallback_on_rate_limit", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("fallback_on_server_error", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("fallback_on_timeout", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("model_routing_policies_pk", ["tenant_id", "model_profile_id"])
    .addForeignKeyConstraint(
      "model_routing_policies_profile_fk",
      ["tenant_id", "model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "model_routing_policies_fallback_shape",
      sql`(fallback_provider is null and fallback_model_id is null)
          or (char_length(fallback_provider) between 1 and 128
              and char_length(fallback_model_id) between 1 and 256)`,
    )
    .addCheckConstraint(
      "model_routing_policies_enabled_shape",
      sql`not enabled or fallback_provider is not null`,
    )
    .execute();

  await sql`
    insert into model_routing_policies (tenant_id, model_profile_id)
    select tenant_id, id from model_profiles
    on conflict do nothing
  `.execute(db);

  await db.schema
    .createTable("model_requests")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_id", "uuid", (column) => column.notNull())
    .addColumn("model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("request_sequence", "integer", (column) => column.notNull())
    .addColumn("requested_provider", "text", (column) => column.notNull())
    .addColumn("requested_model_id", "text", (column) => column.notNull())
    .addColumn("actual_provider", "text")
    .addColumn("actual_model_id", "text")
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("fallback_reason", "text")
    .addColumn("reserved_input_tokens", "bigint", (column) => column.notNull())
    .addColumn("reserved_output_tokens", "bigint", (column) => column.notNull())
    .addColumn("reserved_cost_microusd", "bigint", (column) => column.notNull())
    .addColumn("actual_input_tokens", "bigint")
    .addColumn("actual_output_tokens", "bigint")
    .addColumn("actual_cache_read_tokens", "bigint")
    .addColumn("actual_cache_write_tokens", "bigint")
    .addColumn("actual_input_microusd_per_million", "bigint")
    .addColumn("actual_output_microusd_per_million", "bigint")
    .addColumn("actual_cache_read_microusd_per_million", "bigint")
    .addColumn("actual_cache_write_microusd_per_million", "bigint")
    .addColumn("actual_cost_microusd", "bigint")
    .addColumn("upstream_status", "integer")
    .addColumn("failure_code", "text")
    .addColumn("reservation_expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("started_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("model_requests_attempt_sequence_unique", [
      "run_id",
      "attempt_id",
      "request_sequence",
    ])
    .addForeignKeyConstraint(
      "model_requests_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addForeignKeyConstraint(
      "model_requests_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "model_requests_profile_fk",
      ["tenant_id", "model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "model_requests_state_valid",
      sql`state in ('reserved', 'completed', 'failed', 'aborted', 'budget_denied')`,
    )
    .addCheckConstraint("model_requests_sequence_positive", sql`request_sequence > 0`)
    .addCheckConstraint(
      "model_requests_values_nonnegative",
      sql`reserved_input_tokens >= 0 and reserved_output_tokens >= 0
          and reserved_cost_microusd >= 0
          and (actual_input_tokens is null or actual_input_tokens >= 0)
          and (actual_output_tokens is null or actual_output_tokens >= 0)
          and (actual_cache_read_tokens is null or actual_cache_read_tokens >= 0)
          and (actual_cache_write_tokens is null or actual_cache_write_tokens >= 0)
          and (actual_input_microusd_per_million is null or actual_input_microusd_per_million >= 0)
          and (actual_output_microusd_per_million is null or actual_output_microusd_per_million >= 0)
          and (actual_cache_read_microusd_per_million is null or actual_cache_read_microusd_per_million >= 0)
          and (actual_cache_write_microusd_per_million is null or actual_cache_write_microusd_per_million >= 0)
          and (actual_cost_microusd is null or actual_cost_microusd >= 0)`,
    )
    .addCheckConstraint(
      "model_requests_settlement_shape",
      sql`(state = 'reserved' and settled_at is null)
          or (state <> 'reserved' and settled_at is not null)`,
    )
    .addCheckConstraint(
      "model_requests_actual_shape",
      sql`(state = 'completed'
            and actual_provider is not null and actual_model_id is not null
            and actual_input_tokens is not null and actual_output_tokens is not null
            and actual_cache_read_tokens is not null and actual_cache_write_tokens is not null
            and actual_input_microusd_per_million is not null
            and actual_output_microusd_per_million is not null
            and actual_cache_read_microusd_per_million is not null
            and actual_cache_write_microusd_per_million is not null
            and actual_cost_microusd is not null and failure_code is null)
          or (state <> 'completed' and actual_cost_microusd is null
            and actual_input_microusd_per_million is null
            and actual_output_microusd_per_million is null
            and actual_cache_read_microusd_per_million is null
            and actual_cache_write_microusd_per_million is null)`,
    )
    .addCheckConstraint(
      "model_requests_identity_bounded",
      sql`char_length(requested_provider) between 1 and 128
          and char_length(requested_model_id) between 1 and 256
          and (actual_provider is null or char_length(actual_provider) between 1 and 128)
          and (actual_model_id is null or char_length(actual_model_id) between 1 and 256)`,
    )
    .execute();

  await db.schema
    .createIndex("model_requests_active_reservations")
    .on("model_requests")
    .columns(["tenant_id", "reservation_expires_at"])
    .where(sql<boolean>`state = 'reserved'`)
    .execute();
  await db.schema
    .createIndex("model_requests_by_run")
    .on("model_requests")
    .columns(["tenant_id", "run_id", "started_at"])
    .execute();

  await db.schema
    .alterTable("usage_ledger")
    .addColumn("run_id", "uuid")
    .addColumn("attempt_id", "uuid")
    .addColumn("model_request_id", "uuid")
    .addColumn("model_profile_id", "uuid")
    .addColumn("cost_microusd", "bigint")
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .addForeignKeyConstraint("usage_ledger_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .addForeignKeyConstraint(
      "usage_ledger_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .addForeignKeyConstraint(
      "usage_ledger_profile_fk",
      ["tenant_id", "model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .addForeignKeyConstraint(
      "usage_ledger_model_request_fk",
      ["model_request_id"],
      "model_requests",
      ["id"],
    )
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .addCheckConstraint(
      "usage_ledger_governed_shape",
      sql`(run_id is null and attempt_id is null and model_request_id is null
            and model_profile_id is null and cost_microusd is null)
          or (run_id is not null and attempt_id is not null and model_request_id is not null
            and model_profile_id is not null and cost_microusd >= 0)`,
    )
    .execute();
  await db.schema
    .createIndex("usage_ledger_model_request_unique")
    .unique()
    .on("usage_ledger")
    .column("model_request_id")
    .where(sql<boolean>`model_request_id is not null`)
    .execute();
  await db.schema
    .createIndex("usage_ledger_tenant_created")
    .on("usage_ledger")
    .columns(["tenant_id", "created_at"])
    .execute();

  await db.schema
    .createTable("context_compactions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_id", "uuid", (column) => column.notNull())
    .addColumn("started_event_id", "uuid", (column) => column.notNull().unique())
    .addColumn("completed_event_id", "uuid", (column) => column.unique())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("running"))
    .addColumn("tokens_before", "bigint")
    .addColumn("estimated_tokens_after", "bigint")
    .addColumn("first_kept_entry_id", "text")
    .addColumn("summary_sha256", "text")
    .addColumn("summary_version", "integer")
    .addColumn("will_retry", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("started_at", "timestamptz", (column) => column.notNull())
    .addColumn("completed_at", "timestamptz")
    .addForeignKeyConstraint(
      "context_compactions_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addForeignKeyConstraint(
      "context_compactions_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "context_compactions_started_event_fk",
      ["started_event_id"],
      "session_events",
      ["event_id"],
    )
    .addForeignKeyConstraint(
      "context_compactions_completed_event_fk",
      ["completed_event_id"],
      "session_events",
      ["event_id"],
    )
    .addCheckConstraint(
      "context_compactions_reason_valid",
      sql`reason in ('manual', 'threshold', 'overflow')`,
    )
    .addCheckConstraint(
      "context_compactions_state_valid",
      sql`state in ('running', 'completed', 'aborted', 'failed')`,
    )
    .addCheckConstraint(
      "context_compactions_settlement_shape",
      sql`(state = 'running' and completed_event_id is null and completed_at is null)
          or (state <> 'running' and completed_event_id is not null and completed_at is not null)`,
    )
    .addCheckConstraint(
      "context_compactions_values_valid",
      sql`(tokens_before is null or tokens_before >= 0)
          and (estimated_tokens_after is null or estimated_tokens_after >= 0)
          and (summary_sha256 is null or summary_sha256 ~ '^[0-9a-f]{64}$')
          and ((summary_sha256 is null and summary_version is null)
            or (summary_sha256 is not null and summary_version >= 1))`,
    )
    .execute();

  await db.schema
    .createIndex("context_compactions_by_session")
    .on("context_compactions")
    .columns(["tenant_id", "session_id", "started_at"])
    .execute();
  await db.schema
    .createIndex("context_compactions_active_turn")
    .unique()
    .on("context_compactions")
    .column("attempt_id")
    .where(sql<boolean>`state = 'running'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("context_compactions").ifExists().execute();
  await db.schema.dropIndex("usage_ledger_tenant_created").ifExists().execute();
  await db.schema.dropIndex("usage_ledger_model_request_unique").ifExists().execute();
  await db.schema
    .alterTable("usage_ledger")
    .dropConstraint("usage_ledger_governed_shape")
    .execute();
  await db.schema
    .alterTable("usage_ledger")
    .dropConstraint("usage_ledger_model_request_fk")
    .execute();
  await db.schema.alterTable("usage_ledger").dropConstraint("usage_ledger_profile_fk").execute();
  await db.schema.alterTable("usage_ledger").dropConstraint("usage_ledger_attempt_fk").execute();
  await db.schema.alterTable("usage_ledger").dropConstraint("usage_ledger_run_fk").execute();
  for (const column of [
    "cost_microusd",
    "model_profile_id",
    "model_request_id",
    "attempt_id",
    "run_id",
  ]) {
    await db.schema.alterTable("usage_ledger").dropColumn(column).execute();
  }
  await db.schema.dropTable("model_requests").ifExists().execute();
  await db.schema.dropTable("model_routing_policies").ifExists().execute();
  await db.schema.dropTable("model_rates").ifExists().execute();

  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_context_budget_valid")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_governance_positive")
    .execute();
  for (const column of [
    "compaction_keep_recent_tokens",
    "compaction_reserve_tokens",
    "maximum_run_duration_ms",
    "maximum_tool_output_bytes",
    "maximum_tool_calls_per_run",
    "monthly_cost_microusd_budget",
    "daily_token_budget",
    "maximum_cost_microusd_per_run",
    "maximum_tokens_per_run",
    "maximum_model_requests_per_run",
  ]) {
    await db.schema.alterTable("tenant_runtime_policies").dropColumn(column).execute();
  }
}
