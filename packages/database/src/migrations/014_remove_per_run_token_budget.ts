import { sql, type Kysely } from "kysely";

const governanceConstraint = sql`maximum_model_requests_per_run between 1 and 1024
    and maximum_cost_microusd_per_run between 1 and 1000000000000
    and daily_token_budget between 1 and 1000000000000
    and monthly_cost_microusd_budget between 1 and 1000000000000000
    and maximum_tool_calls_per_run between 1 and 10000
    and maximum_tool_output_bytes between 1024 and 1048576
    and maximum_run_duration_ms between 1000 and 3600000
    and compaction_reserve_tokens between 1024 and 1000000
    and compaction_keep_recent_tokens between 1024 and 1000000`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_context_budget_valid")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_governance_positive")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropColumn("maximum_tokens_per_run")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addCheckConstraint("tenant_runtime_policies_governance_positive", governanceConstraint)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_governance_positive")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addColumn("maximum_tokens_per_run", "bigint", (column) => column.notNull().defaultTo(200_000))
    .execute();
  await sql`
    update tenant_runtime_policies
       set maximum_tokens_per_run = greatest(
         200000,
         compaction_reserve_tokens + compaction_keep_recent_tokens
       )
  `.execute(db);
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
}
