import { sql, type Kysely } from "kysely";

/** Kafka is the only retained hot event authority after the production cutover. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists session_live_stream_compactions`.execute(db);
  await sql`drop table if exists session_event_cursors`.execute(db);
  await sql`drop table if exists session_events`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error("PostgreSQL hot event tables cannot be restored after Kafka-first cutover");
}
