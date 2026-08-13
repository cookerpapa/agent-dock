import { sql, type Kysely } from "kysely";

const LEGACY_DEFAULT_MODEL_REQUESTS = 32;
const CODING_RUN_DEFAULT_MODEL_REQUESTS = 128;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      alter column maximum_model_requests_per_run
      set default ${sql.lit(CODING_RUN_DEFAULT_MODEL_REQUESTS)}
  `.execute(db);
  await sql`
    update tenant_runtime_policies
       set maximum_model_requests_per_run = ${CODING_RUN_DEFAULT_MODEL_REQUESTS}
     where maximum_model_requests_per_run = ${LEGACY_DEFAULT_MODEL_REQUESTS}
       and updated_at = created_at
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      alter column maximum_model_requests_per_run
      set default ${sql.lit(LEGACY_DEFAULT_MODEL_REQUESTS)}
  `.execute(db);
  await sql`
    update tenant_runtime_policies
       set maximum_model_requests_per_run = ${LEGACY_DEFAULT_MODEL_REQUESTS}
     where maximum_model_requests_per_run = ${CODING_RUN_DEFAULT_MODEL_REQUESTS}
       and updated_at = created_at
  `.execute(db);
}
