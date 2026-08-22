import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Development environments are disposable compute allocations. The project
  // is still pre-production, so remove old untyped allocations instead of
  // retaining a misleading compatibility profile.
  await sql`delete from development_environment_operations`.execute(db);
  await sql`delete from development_environments`.execute(db);
  await db.schema
    .alterTable("development_environments")
    .addColumn("profile_key", "text", (column) => column.notNull())
    .addColumn("cpu_count", "integer", (column) => column.notNull())
    .addColumn("memory_mib", "integer", (column) => column.notNull())
    .addColumn("system_disk_gib", "integer", (column) => column.notNull())
    .execute();
  await sql`
    alter table development_environments
      add constraint development_environments_profile_valid
      check (profile_key in ('starter', 'standard', 'performance')
        and cpu_count between 1 and 64
        and memory_mib between 512 and 262144
        and system_disk_gib between 1 and 2048)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table development_environments
      drop constraint development_environments_profile_valid,
      drop column system_disk_gib,
      drop column memory_mib,
      drop column cpu_count,
      drop column profile_key
  `.execute(db);
}
