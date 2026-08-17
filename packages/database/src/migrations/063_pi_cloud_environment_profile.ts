import { sql, type Kysely } from "kysely";

const previousProfileKey = "agent-dock-fullstack";
const currentProfileKey = "pi-cloud-fullstack";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("environment_versions")
    .dropConstraint("environment_versions_profile_key_valid")
    .execute();

  await sql`
    update environment_versions
       set profile_key = ${currentProfileKey},
           updated_at = now()
     where profile_key = ${previousProfileKey}
  `.execute(db);

  await sql`
    update environment_validations
       set report = jsonb_set(report, '{profileKey}', to_jsonb(${currentProfileKey}::text), false)
     where report ->> 'profileKey' = ${previousProfileKey}
  `.execute(db);

  await db.schema
    .alterTable("environment_versions")
    .addCheckConstraint(
      "environment_versions_profile_key_valid",
      sql`profile_key = 'pi-cloud-fullstack'`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("environment_versions")
    .dropConstraint("environment_versions_profile_key_valid")
    .execute();

  await sql`
    update environment_versions
       set profile_key = ${previousProfileKey},
           updated_at = now()
     where profile_key = ${currentProfileKey}
  `.execute(db);

  await sql`
    update environment_validations
       set report = jsonb_set(report, '{profileKey}', to_jsonb(${previousProfileKey}::text), false)
     where report ->> 'profileKey' = ${currentProfileKey}
  `.execute(db);

  await db.schema
    .alterTable("environment_versions")
    .addCheckConstraint(
      "environment_versions_profile_key_valid",
      sql`profile_key = 'agent-dock-fullstack'`,
    )
    .execute();
}
