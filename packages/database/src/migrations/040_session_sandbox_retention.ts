import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("sandbox_retention_policy", "text", (column) =>
      column.notNull().defaultTo("ephemeral"),
    )
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_sandbox_retention_policy_valid",
      sql`sandbox_retention_policy in ('ephemeral', 'persistent')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_sandbox_retention_policy_valid")
    .execute();
  await db.schema.alterTable("sessions").dropColumn("sandbox_retention_policy").execute();
}
