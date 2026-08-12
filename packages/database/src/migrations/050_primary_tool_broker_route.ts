import { sql, type Kysely } from "kysely";

const INITIAL_DOMAIN_ID = "sandbox-domain-0001";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update sandbox_domains
       set tool_broker_base_url = 'http://tool-broker:4300',
           workspace_storage_key = 'workspace-domain-0001',
           updated_at = now()
     where id = ${INITIAL_DOMAIN_ID}
       and tool_broker_base_url = 'http://sandbox-manager:4300'
       and workspace_storage_key = 'workspace-cell-0001'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update sandbox_domains
       set tool_broker_base_url = 'http://sandbox-manager:4300',
           workspace_storage_key = 'workspace-cell-0001',
           updated_at = now()
     where id = ${INITIAL_DOMAIN_ID}
       and tool_broker_base_url = 'http://tool-broker:4300'
       and workspace_storage_key = 'workspace-domain-0001'
  `.execute(db);
}
