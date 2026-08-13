import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    create table pi_sessions (
      tenant_id uuid not null references tenants(id),
      id uuid not null,
      created_at_ms bigint not null,
      parent_session_id uuid,
      next_seq bigint not null default 1,
      name text,
      primary key (tenant_id, id),
      constraint pi_sessions_next_seq_valid check (next_seq >= 1)
    )
  `.execute(db);
  await sql`
    create table pi_session_lanes (
      tenant_id uuid not null,
      session_id uuid not null,
      lane text not null,
      leaf_id uuid,
      primary key (tenant_id, session_id, lane),
      foreign key (tenant_id, session_id) references pi_sessions(tenant_id, id) on delete cascade,
      constraint pi_session_lanes_name_valid check (length(lane) between 1 and 128)
    )
  `.execute(db);
  await sql`
    create table pi_session_entries (
      tenant_id uuid not null,
      session_id uuid not null,
      id uuid not null,
      seq bigint not null,
      parent_id uuid,
      type text not null,
      custom_type text,
      timestamp_ms bigint not null,
      payload jsonb not null,
      primary key (tenant_id, session_id, id),
      unique (tenant_id, session_id, seq),
      foreign key (tenant_id, session_id) references pi_sessions(tenant_id, id) on delete cascade
    )
  `.execute(db);
  await sql`create index pi_session_entries_query on pi_session_entries(tenant_id, session_id, type, seq)`.execute(
    db,
  );
  await sql`create index pi_session_entries_parent on pi_session_entries(tenant_id, session_id, parent_id)`.execute(
    db,
  );
  await sql`
    create table pi_session_records (
      tenant_id uuid not null,
      session_id uuid not null,
      id uuid not null,
      seq bigint not null,
      lane text not null,
      type text not null,
      run_id uuid,
      operation_kind text,
      timestamp_ms bigint not null,
      payload jsonb not null,
      primary key (tenant_id, session_id, id),
      unique (tenant_id, session_id, seq),
      foreign key (tenant_id, session_id) references pi_sessions(tenant_id, id) on delete cascade
    )
  `.execute(db);
  await sql`create index pi_session_records_query on pi_session_records(tenant_id, session_id, lane, type, run_id, seq)`.execute(
    db,
  );
  await sql`
    create table pi_session_labels (
      tenant_id uuid not null,
      session_id uuid not null,
      target_id uuid not null,
      label text not null,
      updated_seq bigint not null,
      primary key (tenant_id, session_id, target_id),
      foreign key (tenant_id, session_id) references pi_sessions(tenant_id, id) on delete cascade
    )
  `.execute(db);
  await sql`
    create table pi_session_log (
      tenant_id uuid not null,
      session_id uuid not null,
      seq bigint not null,
      kind text not null,
      payload jsonb not null,
      primary key (tenant_id, session_id, seq),
      foreign key (tenant_id, session_id) references pi_sessions(tenant_id, id) on delete cascade,
      constraint pi_session_log_kind_valid check (kind in ('entry', 'record', 'lane', 'fact'))
    )
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`drop table pi_session_log`.execute(db);
  await sql`drop table pi_session_labels`.execute(db);
  await sql`drop table pi_session_records`.execute(db);
  await sql`drop table pi_session_entries`.execute(db);
  await sql`drop table pi_session_lanes`.execute(db);
  await sql`drop table pi_sessions`.execute(db);
}
