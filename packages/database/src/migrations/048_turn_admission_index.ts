import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("turns_tenant_unsettled")
    .on("turns")
    .column("tenant_id")
    .where(
      sql<boolean>`state in ('queued', 'dispatching', 'running', 'waiting_approval', 'cancelling')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("turns_tenant_unsettled").execute();
}
