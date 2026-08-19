import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("turns").addColumn("pruned_at", "timestamptz").execute();
  await db.schema
    .createIndex("turns_visible_session_idx")
    .on("turns")
    .columns(["tenant_id", "session_id", "created_at"])
    .where(sql<boolean>`pruned_at is null`)
    .execute();
  await db.schema
    .createTable("conversation_prune_operations")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("request_sha256", "text", (column) => column.notNull())
    .addColumn("anchor_turn_id", "uuid", (column) => column.notNull())
    .addColumn("anchor_entry_id", "text", (column) => column.notNull())
    .addColumn("pruned_turn_count", "integer", (column) => column.notNull())
    .addColumn("archived_session_count", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("conversation_prune_operations_pkey", [
      "tenant_id",
      "session_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "conversation_prune_operations_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "conversation_prune_operations_turn_fk",
      ["tenant_id", "session_id", "anchor_turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "conversation_prune_operations_request_sha256_valid",
      sql`request_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "conversation_prune_operations_anchor_entry_valid",
      sql`char_length(anchor_entry_id) between 1 and 256`,
    )
    .addCheckConstraint(
      "conversation_prune_operations_counts_valid",
      sql`pruned_turn_count >= 0 and archived_session_count >= 0`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("conversation_prune_operations").execute();
  await db.schema.dropIndex("turns_visible_session_idx").execute();
  await db.schema.alterTable("turns").dropColumn("pruned_at").execute();
}
