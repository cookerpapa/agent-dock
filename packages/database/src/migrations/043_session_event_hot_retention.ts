import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("session_event_cursors")
    .addColumn("replay_floor_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("session_event_cursors")
    .addCheckConstraint(
      "session_event_cursors_replay_floor_valid",
      sql`replay_floor_seq >= 0 and replay_floor_seq <= last_projected_seq`,
    )
    .execute();

  await db.schema
    .createTable("session_event_archives")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("first_seq", "bigint", (column) => column.notNull())
    .addColumn("last_seq", "bigint", (column) => column.notNull())
    .addColumn("event_count", "integer", (column) => column.notNull())
    .addColumn("format", "text", (column) => column.notNull())
    .addColumn("object_key", "text")
    .addColumn("sha256", "char(64)")
    .addColumn("uncompressed_sha256", "char(64)")
    .addColumn("size_bytes", "bigint")
    .addColumn("uncompressed_size_bytes", "bigint")
    .addColumn("state", "text", (column) => column.notNull().defaultTo("uploading"))
    .addColumn("claim_owner", "text", (column) => column.notNull())
    .addColumn("claim_until", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("archived_at", "timestamptz")
    .addUniqueConstraint("session_event_archives_session_first_unique", ["session_id", "first_seq"])
    .addForeignKeyConstraint(
      "session_event_archives_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "session_event_archives_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "session_event_archives_sequence_valid",
      sql`first_seq > 0 and last_seq >= first_seq and event_count = last_seq - first_seq + 1`,
    )
    .addCheckConstraint(
      "session_event_archives_format_valid",
      sql`format = 'agent-dock.session-events.ndjson.gzip.v1'`,
    )
    .addCheckConstraint(
      "session_event_archives_state_valid",
      sql`state in ('uploading', 'committed')`,
    )
    .addCheckConstraint(
      "session_event_archives_claim_owner_valid",
      sql`char_length(claim_owner) between 1 and 256`,
    )
    .addCheckConstraint(
      "session_event_archives_committed_metadata_valid",
      sql`(
        state = 'uploading'
        and object_key is null
        and sha256 is null
        and uncompressed_sha256 is null
        and size_bytes is null
        and uncompressed_size_bytes is null
        and archived_at is null
      ) or (
        state = 'committed'
        and object_key is not null
        and char_length(object_key) between 1 and 2048
        and sha256 ~ '^[0-9a-f]{64}$'
        and uncompressed_sha256 ~ '^[0-9a-f]{64}$'
        and size_bytes > 0
        and uncompressed_size_bytes > 0
        and archived_at is not null
      )`,
    )
    .execute();
  await db.schema
    .createIndex("session_event_archives_claim_idx")
    .on("session_event_archives")
    .columns(["state", "claim_until", "created_at"])
    .execute();
  await db.schema
    .createIndex("session_event_archives_session_range_idx")
    .on("session_event_archives")
    .columns(["session_id", "first_seq", "last_seq"])
    .execute();

  // The hot table remains Session-hash partitioned because every interactive
  // replay is keyed by Session and sequence. Retention removes small terminal
  // Turn ranges continuously, so tune each leaf to reclaim those dead tuples
  // well before the default 20% threshold would fire on a large partition.
  await sql`
    do $$
    declare
      partition_name text;
    begin
      for partition_name in
        select child.relname
          from pg_inherits
          join pg_class parent on parent.oid = pg_inherits.inhparent
          join pg_class child on child.oid = pg_inherits.inhrelid
         where parent.relname = 'session_events'
      loop
        execute format(
          'alter table %I set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 5000)',
          partition_name
        );
      end loop;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("session_event_archives").execute();
  await db.schema
    .alterTable("session_event_cursors")
    .dropConstraint("session_event_cursors_replay_floor_valid")
    .execute();
  await db.schema.alterTable("session_event_cursors").dropColumn("replay_floor_seq").execute();
}
