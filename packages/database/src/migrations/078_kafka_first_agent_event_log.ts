import { sql, type Kysely } from "kysely";

/** Records the broker-acknowledged event boundary without storing hot deltas. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table run_attempts
      add column last_event_seq bigint not null default 0,
      add constraint run_attempts_last_event_seq_valid check (last_event_seq >= 0)
  `.execute(db);
  await sql`
    create index run_attempts_active_event_boundary_idx
      on run_attempts (tenant_id, run_id, id, last_event_seq)
      where state in ('provisioning', 'restoring', 'running', 'checkpointing', 'cancel_requested')
  `.execute(db);
  await sql`
    alter table pi_session_log
      add column mutation_id uuid,
      add column mutation_result jsonb
  `.execute(db);
  await sql`
    create unique index pi_session_log_mutation_id_unique
      on pi_session_log (tenant_id, session_id, mutation_id)
      where mutation_id is not null
  `.execute(db);
  await sql`
    create table pi_session_mutation_results (
      mutation_id uuid primary key,
      tenant_id uuid not null references tenants(id) on delete cascade,
      session_id text not null,
      run_id uuid not null,
      attempt_id uuid not null,
      state text not null check (state in ('completed', 'failed')),
      result jsonb,
      error_code text,
      error_message text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      check (
        (state = 'completed' and error_code is null and error_message is null)
        or (state = 'failed' and error_code is not null and error_message is not null)
      )
    )
  `.execute(db);
  await sql`
    create index pi_session_mutation_results_expiry_idx
      on pi_session_mutation_results (expires_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists pi_session_mutation_results`.execute(db);
  await sql`drop index if exists pi_session_log_mutation_id_unique`.execute(db);
  await sql`
    alter table pi_session_log
      drop column mutation_result,
      drop column mutation_id
  `.execute(db);
  await sql`drop index if exists run_attempts_active_event_boundary_idx`.execute(db);
  await sql`
    alter table run_attempts
      drop constraint run_attempts_last_event_seq_valid,
      drop column last_event_seq
  `.execute(db);
}
