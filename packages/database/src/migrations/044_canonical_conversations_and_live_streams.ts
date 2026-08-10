import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Clean occupied development databases created before the Kafka/Valkey
  // cutover. No runtime compatibility path or archive reader is retained.
  await db.schema.dropTable("session_event_archives").ifExists().execute();

  await db.schema
    .createTable("session_terminal_events")
    .addColumn("event_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull().unique())
    .addColumn("agent_id", "text", (column) => column.notNull())
    .addColumn("command_id", "uuid", (column) => column.notNull())
    .addColumn("seq", "bigint", (column) => column.notNull())
    .addColumn("schema_version", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
    .addColumn("persisted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("session_terminal_events_session_seq_unique", ["session_id", "seq"])
    .addForeignKeyConstraint(
      "session_terminal_events_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "session_terminal_events_command_fk",
      ["tenant_id", "session_id", "turn_id", "command_id"],
      "commands",
      ["tenant_id", "session_id", "turn_id", "id"],
    )
    .addCheckConstraint("session_terminal_events_seq_positive", sql`seq > 0`)
    .addCheckConstraint("session_terminal_events_schema_valid", sql`schema_version = 1`)
    .addCheckConstraint(
      "session_terminal_events_type_valid",
      sql`type in ('turn.completed', 'turn.failed', 'turn.cancelled')`,
    )
    .addCheckConstraint(
      "session_terminal_events_payload_valid",
      sql`jsonb_typeof(payload) = 'object'`,
    )
    .execute();
  await db.schema
    .createIndex("session_terminal_events_replay_idx")
    .on("session_terminal_events")
    .columns(["tenant_id", "session_id", "seq"])
    .execute();

  // Compaction records make deletion from the rebuildable Valkey read model
  // reconcilable. PostgreSQL never stores the removed token deltas.
  await db.schema
    .createTable("session_live_stream_compactions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull().unique())
    .addColumn("through_seq", "bigint", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("available_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("claim_owner", "text")
    .addColumn("claim_until", "timestamptz")
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .addForeignKeyConstraint(
      "session_live_stream_compactions_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint("session_live_stream_compactions_seq_positive", sql`through_seq > 0`)
    .addCheckConstraint(
      "session_live_stream_compactions_state_valid",
      sql`state in ('pending', 'completed')`,
    )
    .addCheckConstraint("session_live_stream_compactions_attempts_valid", sql`attempts >= 0`)
    .execute();
  await db.schema
    .createIndex("session_live_stream_compactions_claim_idx")
    .on("session_live_stream_compactions")
    .columns(["state", "available_at", "claim_until"])
    .execute();

  // Compaction event identifiers remain useful metadata, but the canonical
  // event payload no longer lives in PostgreSQL.
  await db.schema
    .alterTable("context_compactions")
    .dropConstraint("context_compactions_started_event_fk")
    .execute();
  await db.schema
    .alterTable("context_compactions")
    .dropConstraint("context_compactions_completed_event_fk")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("context_compactions")
    .addForeignKeyConstraint(
      "context_compactions_started_event_fk",
      ["started_event_id"],
      "session_event_ids",
      ["event_id"],
    )
    .execute();
  await db.schema
    .alterTable("context_compactions")
    .addForeignKeyConstraint(
      "context_compactions_completed_event_fk",
      ["completed_event_id"],
      "session_event_ids",
      ["event_id"],
    )
    .execute();
  await db.schema.dropTable("session_live_stream_compactions").execute();
  await db.schema.dropTable("session_terminal_events").execute();
}
