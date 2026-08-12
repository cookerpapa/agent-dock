import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update tenant_runtime_policies as policy
       set maximum_active_sandboxes = 64,
           updated_at = now()
     where policy.maximum_active_sandboxes = 16
       and exists (
         select 1
           from tenant_api_credentials as credential
          where credential.tenant_id = policy.tenant_id
            and credential.label = 'production bootstrap owner'
            and credential.role = 'owner'
            and credential.revoked_at is null
       )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update tenant_runtime_policies as policy
       set maximum_active_sandboxes = 16,
           updated_at = now()
     where policy.maximum_active_sandboxes = 64
       and exists (
         select 1
           from tenant_api_credentials as credential
          where credential.tenant_id = policy.tenant_id
            and credential.label = 'production bootstrap owner'
            and credential.role = 'owner'
            and credential.revoked_at is null
       )
  `.execute(db);
}
