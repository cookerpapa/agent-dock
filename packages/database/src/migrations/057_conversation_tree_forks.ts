import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sessions
      add column conversation_parent_session_id uuid,
      add column conversation_fork_turn_id uuid,
      add column conversation_fork_entry_id uuid,
      add constraint sessions_conversation_parent_fk
        foreign key (tenant_id, conversation_parent_session_id)
        references sessions(tenant_id, id),
      add constraint sessions_conversation_fork_turn_fk
        foreign key (conversation_fork_turn_id)
        references turns(id),
      add constraint sessions_conversation_fork_shape
        check (
          (conversation_parent_session_id is null
           and conversation_fork_turn_id is null
           and conversation_fork_entry_id is null)
          or
          (conversation_parent_session_id is not null
           and conversation_fork_turn_id is not null
           and conversation_fork_entry_id is not null)
        )
  `.execute(db);
  await sql`
    create index sessions_conversation_parent_idx
      on sessions(tenant_id, conversation_parent_session_id, created_at)
      where conversation_parent_session_id is not null
  `.execute(db);
  await sql`
    create table conversation_fork_operations (
      tenant_id uuid not null references tenants(id),
      source_session_id uuid not null,
      idempotency_key text not null,
      request_sha256 text not null,
      source_turn_id uuid not null,
      source_entry_id uuid not null,
      child_session_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (tenant_id, source_session_id, idempotency_key),
      foreign key (tenant_id, source_session_id)
        references sessions(tenant_id, id),
      foreign key (source_turn_id)
        references turns(id),
      foreign key (tenant_id, child_session_id)
        references sessions(tenant_id, id),
      constraint conversation_fork_operations_key_valid
        check (char_length(idempotency_key) between 1 and 256),
      constraint conversation_fork_operations_sha_valid
        check (request_sha256 ~ '^[0-9a-f]{64}$')
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table conversation_fork_operations`.execute(db);
  await sql`drop index sessions_conversation_parent_idx`.execute(db);
  await sql`
    alter table sessions
      drop constraint sessions_conversation_fork_shape,
      drop constraint sessions_conversation_fork_turn_fk,
      drop constraint sessions_conversation_parent_fk,
      drop column conversation_fork_entry_id,
      drop column conversation_fork_turn_id,
      drop column conversation_parent_session_id
  `.execute(db);
}
