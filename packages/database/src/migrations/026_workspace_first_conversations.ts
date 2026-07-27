import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("title", "text", (column) => column.defaultTo("新对话"))
    .execute();
  await sql`
    update sessions
    set title = projects.name
    from projects
    where projects.tenant_id = sessions.tenant_id
      and projects.id = sessions.project_id
  `.execute(db);
  await db.schema
    .alterTable("sessions")
    .alterColumn("title", (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_title_valid",
      sql`char_length(title) between 1 and 256 and title !~ '[[:cntrl:]]'`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sessions").dropConstraint("sessions_title_valid").execute();
  await db.schema.alterTable("sessions").dropColumn("title").execute();
}
