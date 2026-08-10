import { sql, type Kysely } from "kysely";

/**
 * Adds the replay floor used by bounded live-event stores. Migration 044
 * completed the Kafka/Valkey cutover; no raw-event archive schema is retained.
 */
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

  // The PostgreSQL-only deterministic adapter remains Session-partitioned.
  // Keep its leaf tables inexpensive to clean during test and local workloads.
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
  await db.schema
    .alterTable("session_event_cursors")
    .dropConstraint("session_event_cursors_replay_floor_valid")
    .execute();
  await db.schema.alterTable("session_event_cursors").dropColumn("replay_floor_seq").execute();
}
