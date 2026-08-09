import { sql, type Kysely } from "kysely";

const PARTITIONS = 32;

async function createPartitionedEventTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_events_partitioned (
      event_id uuid not null,
      tenant_id uuid not null,
      session_id uuid not null,
      turn_id uuid,
      agent_node_id uuid,
      agent_id text not null,
      command_id uuid,
      seq bigint not null,
      schema_version integer not null,
      type text not null,
      payload jsonb not null,
      lease_id uuid not null,
      fencing_token bigint not null,
      occurred_at timestamptz not null,
      persisted_at timestamptz not null default now(),
      primary key (session_id, seq),
      unique (session_id, event_id),
      foreign key (tenant_id, session_id)
        references sessions (tenant_id, id),
      foreign key (tenant_id, session_id, turn_id)
        references turns (tenant_id, session_id, id),
      foreign key (tenant_id, session_id, agent_node_id)
        references agent_nodes (tenant_id, session_id, id),
      foreign key (tenant_id, session_id, turn_id, command_id)
        references commands (tenant_id, session_id, turn_id, id),
      check (seq > 0),
      check (schema_version > 0),
      check (char_length(type) between 1 and 256),
      check (fencing_token > 0),
      check (char_length(agent_id) between 1 and 256),
      check (command_id is null or turn_id is not null)
    ) partition by hash (session_id)
  `.execute(db);
  for (let remainder = 0; remainder < PARTITIONS; remainder += 1) {
    await sql
      .raw(
        `create table session_events_p${String(remainder).padStart(2, "0")} ` +
          `partition of session_events_partitioned for values with ` +
          `(modulus ${String(PARTITIONS)}, remainder ${String(remainder)})`,
      )
      .execute(db);
  }
  await sql`
    create index session_events_partitioned_command_id_idx
      on session_events_partitioned (command_id)
      where command_id is not null
  `.execute(db);
  await sql`
    create index session_events_partitioned_turn_type_seq_idx
      on session_events_partitioned (session_id, turn_id, type, seq desc)
  `.execute(db);
}

async function createUnpartitionedEventTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_events_unpartitioned (
      event_id uuid primary key,
      tenant_id uuid not null,
      session_id uuid not null,
      turn_id uuid,
      agent_node_id uuid,
      agent_id text not null,
      command_id uuid,
      seq bigint not null,
      schema_version integer not null,
      type text not null,
      payload jsonb not null,
      lease_id uuid not null,
      fencing_token bigint not null,
      occurred_at timestamptz not null,
      persisted_at timestamptz not null default now(),
      unique (session_id, seq),
      foreign key (tenant_id, session_id)
        references sessions (tenant_id, id),
      foreign key (tenant_id, session_id, turn_id)
        references turns (tenant_id, session_id, id),
      foreign key (tenant_id, session_id, agent_node_id)
        references agent_nodes (tenant_id, session_id, id),
      foreign key (tenant_id, session_id, turn_id, command_id)
        references commands (tenant_id, session_id, turn_id, id),
      check (seq > 0),
      check (schema_version > 0),
      check (char_length(type) between 1 and 256),
      check (fencing_token > 0),
      check (char_length(agent_id) between 1 and 256),
      check (command_id is null or turn_id is not null)
    )
  `.execute(db);
  await sql`
    create index session_events_unpartitioned_command_id_idx
      on session_events_unpartitioned (command_id)
      where command_id is not null
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`lock table session_events in access exclusive mode`.execute(db);
  await sql`
    create table session_event_ids (
      event_id uuid primary key,
      session_id uuid not null,
      seq bigint not null,
      created_at timestamptz not null default now(),
      unique (session_id, seq)
    )
  `.execute(db);
  await sql`
    insert into session_event_ids (event_id, session_id, seq, created_at)
    select event_id, session_id, seq, persisted_at
      from session_events
  `.execute(db);
  await sql`
    alter table context_compactions
      drop constraint context_compactions_started_event_fk,
      drop constraint context_compactions_completed_event_fk,
      add constraint context_compactions_started_event_fk
        foreign key (started_event_id) references session_event_ids (event_id),
      add constraint context_compactions_completed_event_fk
        foreign key (completed_event_id) references session_event_ids (event_id)
  `.execute(db);
  await createPartitionedEventTable(db);
  await sql`
    insert into session_events_partitioned (
      event_id, tenant_id, session_id, turn_id, agent_node_id, agent_id,
      command_id, seq, schema_version, type, payload, lease_id,
      fencing_token, occurred_at, persisted_at
    )
    select
      event_id, tenant_id, session_id, turn_id, agent_node_id, agent_id,
      command_id, seq, schema_version, type, payload, lease_id,
      fencing_token, occurred_at, persisted_at
    from session_events
  `.execute(db);
  await sql`drop table session_events`.execute(db);
  await sql`alter table session_events_partitioned rename to session_events`.execute(db);
  await sql`
    create function agent_dock_register_session_event_id()
    returns trigger
    language plpgsql
    as $$
    begin
      insert into session_event_ids (event_id, session_id, seq)
      values (new.event_id, new.session_id, new.seq)
      on conflict (event_id) do nothing;

      if not exists (
        select 1
          from session_event_ids
         where event_id = new.event_id
           and session_id = new.session_id
           and seq = new.seq
      ) then
        raise exception 'session event id was reused' using errcode = '23505';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  await sql`
    create trigger session_events_register_event_id
    before insert on session_events
    for each row execute function agent_dock_register_session_event_id()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`lock table session_events in access exclusive mode`.execute(db);
  await createUnpartitionedEventTable(db);
  await sql`
    insert into session_events_unpartitioned
    select * from session_events
  `.execute(db);
  await sql`drop table session_events`.execute(db);
  await sql`alter table session_events_unpartitioned rename to session_events`.execute(db);
  await sql`alter index session_events_unpartitioned_command_id_idx rename to session_events_command_id_idx`.execute(
    db,
  );
  await sql`
    alter table context_compactions
      drop constraint context_compactions_started_event_fk,
      drop constraint context_compactions_completed_event_fk,
      add constraint context_compactions_started_event_fk
        foreign key (started_event_id) references session_events (event_id),
      add constraint context_compactions_completed_event_fk
        foreign key (completed_event_id) references session_events (event_id)
  `.execute(db);
  await sql`drop function agent_dock_register_session_event_id()`.execute(db);
  await sql`drop table session_event_ids`.execute(db);
}
