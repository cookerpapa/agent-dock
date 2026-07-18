import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("commands")
    .addUniqueConstraint("commands_tenant_session_turn_id_unique", [
      "tenant_id",
      "session_id",
      "turn_id",
      "id",
    ])
    .execute();

  await db.schema
    .alterTable("session_events")
    .addColumn("agent_id", "text")
    .addColumn("command_id", "uuid")
    .execute();

  await sql`
    update session_events
       set agent_id = coalesce(agent_node_id::text, 'legacy')
     where agent_id is null
  `.execute(db);

  await sql`
    alter table session_events
      alter column agent_id set not null
  `.execute(db);

  await db.schema
    .alterTable("session_events")
    .addForeignKeyConstraint(
      "session_events_tenant_command_fk",
      ["tenant_id", "session_id", "turn_id", "command_id"],
      "commands",
      ["tenant_id", "session_id", "turn_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("session_events")
    .addCheckConstraint(
      "session_events_agent_id_nonempty",
      sql`char_length(agent_id) between 1 and 256`,
    )
    .execute();
  await db.schema
    .alterTable("session_events")
    .addCheckConstraint(
      "session_events_command_turn_valid",
      sql`command_id is null or turn_id is not null`,
    )
    .execute();

  await db.schema
    .createIndex("session_events_command_id_idx")
    .on("session_events")
    .column("command_id")
    .where(sql<boolean>`command_id is not null`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("session_events_command_id_idx").execute();
  await db.schema
    .alterTable("session_events")
    .dropConstraint("session_events_tenant_command_fk")
    .execute();
  await db.schema
    .alterTable("session_events")
    .dropConstraint("session_events_agent_id_nonempty")
    .execute();
  await db.schema
    .alterTable("session_events")
    .dropConstraint("session_events_command_turn_valid")
    .execute();
  await db.schema.alterTable("session_events").dropColumn("command_id").execute();
  await db.schema.alterTable("session_events").dropColumn("agent_id").execute();
  await db.schema
    .alterTable("commands")
    .dropConstraint("commands_tenant_session_turn_id_unique")
    .execute();
}
