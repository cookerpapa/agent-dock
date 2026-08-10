import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table worker_event_outbox`.execute(db);
  await db.schema
    .alterTable("session_event_ids")
    .dropConstraint("session_event_ids_content_sha256_valid")
    .execute();
  await db.schema.alterTable("session_event_ids").dropColumn("content_sha256").execute();
  await sql`
    create table worker_event_projection_offsets (
      consumer_group varchar(249) not null,
      topic varchar(249) not null,
      partition integer not null,
      last_offset bigint not null,
      updated_at timestamptz not null default now(),
      primary key (consumer_group, topic, partition),
      check (partition >= 0),
      check (last_offset >= 0)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table worker_event_projection_offsets`.execute(db);
  await db.schema.alterTable("session_event_ids").addColumn("content_sha256", "char(64)").execute();
  await db.schema
    .alterTable("session_event_ids")
    .addCheckConstraint(
      "session_event_ids_content_sha256_valid",
      sql`content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute();
  await sql`
    create table worker_event_outbox (
      id uuid primary key,
      tenant_id uuid not null references tenants(id) on delete cascade,
      session_id uuid not null references sessions(id) on delete cascade,
      first_seq bigint not null,
      last_seq bigint not null,
      envelope jsonb not null,
      content_sha256 char(64) not null,
      state text not null default 'pending',
      attempts integer not null default 0,
      available_at timestamptz not null default now(),
      claimed_by text,
      claimed_until timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      published_at timestamptz,
      unique (session_id, first_seq),
      check (first_seq > 0 and last_seq >= first_seq),
      check (content_sha256 ~ '^[0-9a-f]{64}$'),
      check (state in ('pending', 'published')),
      check ((claimed_by is null) = (claimed_until is null)),
      check (jsonb_typeof(envelope) = 'object')
    )
  `.execute(db);
  await sql`
    create index worker_event_outbox_delivery_idx
      on worker_event_outbox (available_at, created_at)
      where state = 'pending'
  `.execute(db);
  await sql`
    create index worker_event_outbox_session_idx
      on worker_event_outbox (session_id, first_seq)
  `.execute(db);
}
