import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

const SESSION_CHILDREN = [
  ["pi_session_lanes", "pi_session_lanes_tenant_id_session_id_fkey"],
  ["pi_session_entries", "pi_session_entries_tenant_id_session_id_fkey"],
  ["pi_session_records", "pi_session_records_tenant_id_session_id_fkey"],
  ["pi_session_labels", "pi_session_labels_tenant_id_session_id_fkey"],
  ["pi_session_log", "pi_session_log_tenant_id_session_id_fkey"],
] as const;

async function dropSessionForeignKeys(db: Kysely<Database>): Promise<void> {
  for (const [table, constraint] of SESSION_CHILDREN) {
    await sql.raw(`alter table ${table} drop constraint ${constraint}`).execute(db);
  }
}

async function addSessionForeignKeys(db: Kysely<Database>): Promise<void> {
  for (const [table] of SESSION_CHILDREN) {
    await sql
      .raw(
        `
      alter table ${table}
      add foreign key (tenant_id, session_id)
      references pi_sessions(tenant_id, id) on delete cascade
    `,
      )
      .execute(db);
  }
}

/** Pi IDs are opaque strings; AgentDock product UUIDs are a valid subset. */
export async function up(db: Kysely<Database>): Promise<void> {
  await dropSessionForeignKeys(db);
  for (const statement of [
    "alter table pi_sessions alter column id type text using id::text, alter column parent_session_id type text using parent_session_id::text",
    "alter table pi_session_lanes alter column session_id type text using session_id::text, alter column leaf_id type text using leaf_id::text",
    "alter table pi_session_entries alter column session_id type text using session_id::text, alter column id type text using id::text, alter column parent_id type text using parent_id::text",
    "alter table pi_session_records alter column session_id type text using session_id::text, alter column id type text using id::text, alter column run_id type text using run_id::text",
    "alter table pi_session_labels alter column session_id type text using session_id::text, alter column target_id type text using target_id::text",
    "alter table pi_session_log alter column session_id type text using session_id::text",
  ]) {
    await sql.raw(statement).execute(db);
  }
  await addSessionForeignKeys(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await dropSessionForeignKeys(db);
  for (const statement of [
    "alter table pi_sessions alter column id type uuid using id::uuid, alter column parent_session_id type uuid using parent_session_id::uuid",
    "alter table pi_session_lanes alter column session_id type uuid using session_id::uuid, alter column leaf_id type uuid using leaf_id::uuid",
    "alter table pi_session_entries alter column session_id type uuid using session_id::uuid, alter column id type uuid using id::uuid, alter column parent_id type uuid using parent_id::uuid",
    "alter table pi_session_records alter column session_id type uuid using session_id::uuid, alter column id type uuid using id::uuid, alter column run_id type uuid using run_id::uuid",
    "alter table pi_session_labels alter column session_id type uuid using session_id::uuid, alter column target_id type uuid using target_id::uuid",
    "alter table pi_session_log alter column session_id type uuid using session_id::uuid",
  ]) {
    await sql.raw(statement).execute(db);
  }
  await addSessionForeignKeys(db);
}
