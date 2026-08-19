import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("subagent_supervisor_requests")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("execution_id", "uuid", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("message", "text", (column) => column.notNull())
    .addColumn("interview", "jsonb")
    .addColumn("expects_reply", "boolean", (column) => column.notNull())
    .addColumn("reply_message", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("replied_at", "timestamptz")
    .addUniqueConstraint("subagent_supervisor_requests_tenant_id_id_unique", ["tenant_id", "id"])
    .addForeignKeyConstraint(
      "subagent_supervisor_requests_execution_fk",
      ["tenant_id", "execution_id"],
      "subagent_executions",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "subagent_supervisor_requests_reason_valid",
      sql`reason in ('need_decision', 'interview_request', 'progress_update')`,
    )
    .addCheckConstraint(
      "subagent_supervisor_requests_message_valid",
      sql`char_length(message) between 1 and 65536`,
    )
    .addCheckConstraint(
      "subagent_supervisor_requests_reply_valid",
      sql`reply_message is null or char_length(reply_message) between 1 and 65536`,
    )
    .addCheckConstraint(
      "subagent_supervisor_requests_shape",
      sql`(expects_reply and expires_at is not null)
          or (not expects_reply and expires_at is null and reply_message is null and replied_at is null)`,
    )
    .addCheckConstraint(
      "subagent_supervisor_requests_reply_shape",
      sql`(reply_message is null and replied_at is null)
          or (reply_message is not null and replied_at is not null)`,
    )
    .execute();
  await db.schema
    .createIndex("subagent_supervisor_requests_execution_created_idx")
    .on("subagent_supervisor_requests")
    .columns(["tenant_id", "execution_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("subagent_supervisor_requests_execution_created_idx").execute();
  await db.schema.dropTable("subagent_supervisor_requests").execute();
}
