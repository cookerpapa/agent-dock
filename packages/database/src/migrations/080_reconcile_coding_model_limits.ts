import { sql, type Kysely } from "kysely";

const LEGACY_DAILY_TOKEN_LIMIT = 2_000_000;
const EFFECTIVELY_UNLIMITED_DAILY_TOKENS = 1_000_000_000_000;
const LEGACY_MODEL_REQUEST_LIMIT = 32;
const CODING_MODEL_REQUEST_LIMIT = 128;

/**
 * Earlier default-lifting migrations treated any edited policy row as fully
 * administrator-managed. In practice, changing an unrelated concurrency
 * field left the legacy model limits behind. Reconcile only the two exact old
 * defaults; deliberately configured values remain untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update tenant_runtime_policies
       set daily_token_budget = case
             when daily_token_budget = ${LEGACY_DAILY_TOKEN_LIMIT}
               then ${EFFECTIVELY_UNLIMITED_DAILY_TOKENS}
             else daily_token_budget
           end,
           maximum_model_requests_per_run = case
             when maximum_model_requests_per_run = ${LEGACY_MODEL_REQUEST_LIMIT}
               then ${CODING_MODEL_REQUEST_LIMIT}
             else maximum_model_requests_per_run
           end
     where daily_token_budget = ${LEGACY_DAILY_TOKEN_LIMIT}
        or maximum_model_requests_per_run = ${LEGACY_MODEL_REQUEST_LIMIT}
  `.execute(db);
}

// This is a one-way data repair. Rolling back application code must not put
// already-reconciled tenants back behind the obsolete limits.
export async function down(_db: Kysely<unknown>): Promise<void> {}
