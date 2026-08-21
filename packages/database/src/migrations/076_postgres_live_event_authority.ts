import { sql, type Kysely } from "kysely";

/** Removes cursor state that existed only for Kafka-to-Valkey projection. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists agent_dock_register_session_event_id() cascade`.execute(db);
  await sql`drop function if exists pi_cloud_register_session_event_id() cascade`.execute(db);
  await sql`drop table if exists session_event_ids`.execute(db);
  await sql`drop table if exists worker_event_projection_offsets`.execute(db);
  await sql`
    alter table session_event_cursors
      drop constraint if exists session_event_cursors_replay_floor_valid,
      drop constraint if exists session_event_cursors_projection_valid,
      drop constraint if exists session_event_cursors_bounds_valid,
      drop column if exists last_projected_seq,
      drop column if exists acknowledged_through_seq
  `.execute(db);
  await sql`
    alter table session_event_cursors
      add constraint session_event_cursors_bounds_valid
      check (
        last_persisted_seq >= 0
        and replay_floor_seq >= 0
        and replay_floor_seq <= last_persisted_seq
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_event_ids (
      event_id uuid primary key,
      session_id uuid not null,
      seq bigint not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create function pi_cloud_register_session_event_id()
    returns trigger
    language plpgsql
    as $$
    begin
      insert into session_event_ids (event_id, session_id, seq)
      values (new.event_id, new.session_id, new.seq);
      return new;
    end;
    $$
  `.execute(db);
  await sql`
    create trigger session_events_register_event_id
    before insert on session_events
    for each row execute function pi_cloud_register_session_event_id()
  `.execute(db);
  await sql`
    alter table session_event_cursors
      drop constraint session_event_cursors_bounds_valid,
      add column last_projected_seq bigint not null default 0,
      add column acknowledged_through_seq bigint not null default 0
  `.execute(db);
  await sql`
    update session_event_cursors
       set last_projected_seq = last_persisted_seq,
           acknowledged_through_seq = last_persisted_seq
  `.execute(db);
  await sql`
    alter table session_event_cursors
      add constraint session_event_cursors_bounds_valid
      check (
        last_persisted_seq >= 0
        and acknowledged_through_seq >= 0
        and acknowledged_through_seq <= last_persisted_seq
      ),
      add constraint session_event_cursors_projection_valid
      check (last_projected_seq >= 0 and last_projected_seq <= last_persisted_seq),
      add constraint session_event_cursors_replay_floor_valid
      check (replay_floor_seq >= 0 and replay_floor_seq <= last_projected_seq)
  `.execute(db);
  await sql`
    create table worker_event_projection_offsets (
      consumer_group text not null,
      topic text not null,
      partition integer not null,
      last_offset bigint not null,
      updated_at timestamptz not null default now(),
      primary key (consumer_group, topic, partition)
    )
  `.execute(db);
}
