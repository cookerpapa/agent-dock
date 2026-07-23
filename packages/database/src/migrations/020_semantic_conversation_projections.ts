import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("conversation_turn_projections")
    .addColumn("turn_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("schema_version", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("through_seq", "bigint", (column) => column.notNull())
    .addColumn("source_event_count", "integer", (column) => column.notNull())
    .addColumn("transcript", "jsonb", (column) => column.notNull())
    .addColumn("projected_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "conversation_turn_projections_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint(
      "conversation_turn_projections_schema_version_valid",
      sql`schema_version = 1`,
    )
    .addCheckConstraint("conversation_turn_projections_through_seq_positive", sql`through_seq > 0`)
    .addCheckConstraint(
      "conversation_turn_projections_source_count_positive",
      sql`source_event_count > 0`,
    )
    .addCheckConstraint(
      "conversation_turn_projections_transcript_shape",
      sql`jsonb_typeof(transcript) = 'object'
          and transcript ->> 'schemaVersion' = '1'
          and jsonb_typeof(transcript -> 'items') = 'array'
          and (transcript ->> 'throughSequence')::bigint = through_seq`,
    )
    .execute();

  await db.schema
    .createIndex("conversation_turn_projections_session_seq_idx")
    .on("conversation_turn_projections")
    .columns(["tenant_id", "session_id", "through_seq"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("conversation_turn_projections").execute();
}
