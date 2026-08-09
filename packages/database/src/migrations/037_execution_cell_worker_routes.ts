import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("execution_cells")
    .addColumn("supervisor_management_url_template", "varchar(2048)")
    .execute();
  await sql`
    update execution_cells
       set supervisor_management_url_template =
         'http://{supervisorId}.agent-dock-pi-worker-primary-v1.agent-dock-system.svc.cluster.local:4100'
     where supervisor_management_url_template is null
  `.execute(db);
  await db.schema
    .alterTable("execution_cells")
    .alterColumn("supervisor_management_url_template", (column) => column.setNotNull())
    .execute();
  await db.schema
    .createIndex("execution_cells_supervisor_management_url_template_unique")
    .unique()
    .on("execution_cells")
    .column("supervisor_management_url_template")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("execution_cells_supervisor_management_url_template_unique").execute();
  await db.schema
    .alterTable("execution_cells")
    .dropColumn("supervisor_management_url_template")
    .execute();
}
