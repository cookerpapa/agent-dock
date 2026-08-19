import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table pi_session_entry_refs (
      tenant_id uuid not null,
      session_id text not null,
      id text not null,
      seq bigint not null,
      source_session_id text not null,
      source_entry_id text not null,
      parent_id text,
      type text not null,
      custom_type text,
      timestamp_ms bigint not null,
      primary key (tenant_id, session_id, id),
      unique (tenant_id, session_id, seq),
      foreign key (tenant_id, session_id)
        references pi_sessions(tenant_id, id) on delete cascade,
      foreign key (tenant_id, source_session_id, source_entry_id)
        references pi_session_entries(tenant_id, session_id, id),
      constraint pi_session_entry_refs_not_self
        check (session_id <> source_session_id)
    )
  `.execute(db);
  await sql`
    create index pi_session_entry_refs_query
        on pi_session_entry_refs(tenant_id, session_id, type, seq)
  `.execute(db);
  await sql`
    create index pi_session_entry_refs_parent
        on pi_session_entry_refs(tenant_id, session_id, parent_id)
  `.execute(db);
  await sql`
    create index pi_session_entry_refs_source
        on pi_session_entry_refs(tenant_id, source_session_id, source_entry_id)
  `.execute(db);
  await sql`
    create view pi_session_visible_entries as
      select entry.tenant_id,
             entry.session_id,
             entry.id,
             entry.seq,
             entry.parent_id,
             entry.type,
             entry.custom_type,
             entry.timestamp_ms,
             entry.payload,
             entry.session_id as source_session_id,
             entry.id as source_entry_id,
             false as inherited
        from pi_session_entries entry
      union all
      select ref.tenant_id,
             ref.session_id,
             ref.id,
             ref.seq,
             ref.parent_id,
             ref.type,
             ref.custom_type,
             ref.timestamp_ms,
             source.payload,
             ref.source_session_id,
             ref.source_entry_id,
             true as inherited
        from pi_session_entry_refs ref
        join pi_session_entries source
          on source.tenant_id = ref.tenant_id
         and source.session_id = ref.source_session_id
         and source.id = ref.source_entry_id
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop view pi_session_visible_entries`.execute(db);
  await sql`drop table pi_session_entry_refs`.execute(db);
}
