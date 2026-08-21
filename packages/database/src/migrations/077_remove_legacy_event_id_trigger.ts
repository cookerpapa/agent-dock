import { sql, type Kysely } from "kysely";

/** Removes the pre-rename AgentDock trigger from already occupied databases. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists agent_dock_register_session_event_id() cascade`.execute(db);
  await sql`drop function if exists pi_cloud_register_session_event_id() cascade`.execute(db);
  await sql`drop table if exists session_event_ids`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Migration 076 owns the retired registry's reversible schema. This cleanup
  // exists only for databases created before the project rename.
}
