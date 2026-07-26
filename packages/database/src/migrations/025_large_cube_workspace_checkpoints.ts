import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_file_count_valid")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint("workspace_versions_file_count_valid", sql`file_count between 0 and 100000`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_file_count_valid")
    .execute();
  await db.schema
    .alterTable("workspace_versions")
    .addCheckConstraint("workspace_versions_file_count_valid", sql`file_count between 0 and 512`)
    .execute();
}
