import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("supervisor_hosts").addColumn("management_base_url", "text").execute();

  await sql`
    update supervisor_hosts
    set management_base_url = 'http://' || supervisor_id || ':4100/'
    where management_base_url is null
  `.execute(db);

  await db.schema
    .alterTable("supervisor_hosts")
    .alterColumn("management_base_url", (column) => column.setNotNull())
    .execute();

  await db.schema
    .alterTable("supervisor_hosts")
    .addCheckConstraint(
      "supervisor_hosts_management_url_valid",
      sql`char_length(management_base_url) between 8 and 2048
          and management_base_url ~ '^https?://[^/?#]+/$'`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("supervisor_hosts")
    .dropConstraint("supervisor_hosts_management_url_valid")
    .execute();

  await db.schema.alterTable("supervisor_hosts").dropColumn("management_base_url").execute();
}
