import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Terminal sessions are short-lived authorities, not durable user data. Old
  // rows cannot prove a monotonic Workspace fence and are intentionally
  // discarded while the product is still pre-production.
  await sql`delete from workspace_terminal_sessions`.execute(db);
  await db.schema
    .alterTable("workspace_terminal_sessions")
    .addColumn("fencing_token", "bigint", (column) => column.notNull())
    .execute();
  await db.schema
    .alterTable("workspace_terminal_sessions")
    .addCheckConstraint("workspace_terminal_fence_positive", sql`fencing_token > 0`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_terminal_sessions")
    .dropConstraint("workspace_terminal_fence_positive")
    .execute();
  await db.schema.alterTable("workspace_terminal_sessions").dropColumn("fencing_token").execute();
}
