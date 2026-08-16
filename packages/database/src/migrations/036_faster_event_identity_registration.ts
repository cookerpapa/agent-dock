import { sql, type Kysely } from "kysely";

const originalFunction = `
  create function pi_cloud_register_session_event_id()
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
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop function pi_cloud_register_session_event_id() cascade`.execute(db);
  await sql
    .raw(
      `
    create function pi_cloud_register_session_event_id()
    returns trigger
    language plpgsql
    as $$
    declare
      registered_event_id uuid;
    begin
      insert into session_event_ids (event_id, session_id, seq)
      values (new.event_id, new.session_id, new.seq)
      on conflict (event_id) do update
        set event_id = excluded.event_id
        where session_event_ids.session_id = excluded.session_id
          and session_event_ids.seq = excluded.seq
      returning event_id into registered_event_id;

      if registered_event_id is null then
        raise exception 'session event id was reused' using errcode = '23505';
      end if;
      return new;
    end;
    $$
  `,
    )
    .execute(db);
  await sql`
    create trigger session_events_register_event_id
    before insert on session_events
    for each row execute function pi_cloud_register_session_event_id()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function pi_cloud_register_session_event_id() cascade`.execute(db);
  await sql.raw(originalFunction).execute(db);
  await sql`
    create trigger session_events_register_event_id
    before insert on session_events
    for each row execute function pi_cloud_register_session_event_id()
  `.execute(db);
}
