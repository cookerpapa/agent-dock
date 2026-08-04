import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update session_events
       set payload = (payload - 'isError') || jsonb_build_object(
         'outcome',
         case when payload ->> 'isError' = 'true' then 'failed' else 'completed' end
       )
     where type = 'tool.completed'
       and payload ? 'isError'
       and not payload ? 'outcome'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update session_events
       set payload = (payload - 'outcome') || jsonb_build_object(
         'isError',
         payload ->> 'outcome' <> 'completed'
       )
     where type = 'tool.completed'
       and payload ? 'outcome'
       and not payload ? 'isError'
  `.execute(db);
}
