import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("runs").addColumn("agent_system_prompt", "text").execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_agent_system_prompt_valid",
      sql`agent_system_prompt is null or char_length(agent_system_prompt) between 1 and 100000`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("runs").dropConstraint("runs_agent_system_prompt_valid").execute();
  await db.schema.alterTable("runs").dropColumn("agent_system_prompt").execute();
}
