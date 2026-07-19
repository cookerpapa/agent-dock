import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sessions").addColumn("next_mailbox_position", "bigint").execute();
  await db.schema.alterTable("commands").addColumn("mailbox_position", "bigint").execute();

  await sql`
    with ranked as (
      select id,
             row_number() over (
               partition by tenant_id, session_id
               order by created_at, id
             ) as mailbox_position
        from commands
       where kind = 'turn.execute'
    )
    update commands as command_row
       set mailbox_position = ranked.mailbox_position
      from ranked
     where command_row.id = ranked.id
  `.execute(db);

  await sql`
    update sessions as session_row
       set next_mailbox_position = coalesce(
         (
           select max(command_row.mailbox_position) + 1
             from commands as command_row
            where command_row.tenant_id = session_row.tenant_id
              and command_row.session_id = session_row.id
              and command_row.kind = 'turn.execute'
         ),
         1
       )
  `.execute(db);

  await sql`
    alter table sessions
      alter column next_mailbox_position set default 1,
      alter column next_mailbox_position set not null
  `.execute(db);

  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_next_mailbox_position_positive", sql`next_mailbox_position > 0`)
    .execute();
  await db.schema
    .alterTable("commands")
    .addCheckConstraint(
      "commands_mailbox_position_valid",
      sql`(
        kind = 'turn.execute'
        and mailbox_position is not null
        and mailbox_position > 0
      ) or (
        kind <> 'turn.execute'
        and mailbox_position is null
      )`,
    )
    .execute();

  await db.schema
    .createIndex("commands_execute_mailbox_unique")
    .unique()
    .on("commands")
    .columns(["tenant_id", "session_id", "mailbox_position"])
    .where(sql<boolean>`kind = 'turn.execute'`)
    .execute();
  await db.schema
    .createIndex("commands_pending_execute_mailbox")
    .on("commands")
    .columns(["tenant_id", "session_id", "mailbox_position"])
    .where(sql<boolean>`kind = 'turn.execute' and state = 'pending'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("commands_pending_execute_mailbox").execute();
  await db.schema.dropIndex("commands_execute_mailbox_unique").execute();
  await db.schema
    .alterTable("commands")
    .dropConstraint("commands_mailbox_position_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_next_mailbox_position_positive")
    .execute();
  await db.schema.alterTable("commands").dropColumn("mailbox_position").execute();
  await db.schema.alterTable("sessions").dropColumn("next_mailbox_position").execute();
}
