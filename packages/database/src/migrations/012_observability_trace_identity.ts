import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("runs")
    .addColumn("trace_id", "text", (column) =>
      column.notNull().defaultTo(sql`md5(random()::text || clock_timestamp()::text)`),
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_trace_id_valid",
      sql`trace_id ~ '^[0-9a-f]{32}$' and trace_id !~ '^0+$'`,
    )
    .execute();
  await db.schema
    .createIndex("runs_tenant_trace_unique")
    .unique()
    .on("runs")
    .columns(["tenant_id", "trace_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("runs_tenant_trace_unique").ifExists().execute();
  await db.schema.alterTable("runs").dropConstraint("runs_trace_id_valid").execute();
  await db.schema.alterTable("runs").dropColumn("trace_id").execute();
}
