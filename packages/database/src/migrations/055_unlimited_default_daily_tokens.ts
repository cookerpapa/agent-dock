import { sql, type Kysely } from "kysely";

const LEGACY_DEFAULT_DAILY_TOKENS = 2_000_000;
const EFFECTIVELY_UNLIMITED_DAILY_TOKENS = 1_000_000_000_000;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      alter column daily_token_budget
      set default ${sql.lit(EFFECTIVELY_UNLIMITED_DAILY_TOKENS)}
  `.execute(db);
  await sql`
    update tenant_runtime_policies
       set daily_token_budget = ${EFFECTIVELY_UNLIMITED_DAILY_TOKENS}
     where daily_token_budget = ${LEGACY_DEFAULT_DAILY_TOKENS}
       and updated_at = created_at
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      alter column daily_token_budget
      set default ${sql.lit(LEGACY_DEFAULT_DAILY_TOKENS)}
  `.execute(db);
  await sql`
    update tenant_runtime_policies
       set daily_token_budget = ${LEGACY_DEFAULT_DAILY_TOKENS}
     where daily_token_budget = ${EFFECTIVELY_UNLIMITED_DAILY_TOKENS}
       and updated_at = created_at
  `.execute(db);
}
