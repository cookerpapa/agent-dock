import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("model_requests")
    .addColumn("step_context_sequence", "integer")
    .addColumn("step_context_sha256", "text")
    .addColumn("sampling_attempt", "integer")
    .execute();

  await db.schema
    .alterTable("model_requests")
    .addCheckConstraint(
      "model_requests_sampling_identity_shape",
      sql`(step_context_sequence is null and step_context_sha256 is null and sampling_attempt is null)
          or (step_context_sequence > 0
              and step_context_sha256 ~ '^[0-9a-f]{64}$'
              and sampling_attempt > 0)`,
    )
    .execute();

  await db.schema
    .createIndex("model_requests_step_attempt_unique")
    .unique()
    .on("model_requests")
    .columns(["run_id", "attempt_id", "step_context_sequence", "sampling_attempt"])
    .where(sql<boolean>`step_context_sequence is not null`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("model_requests_step_attempt_unique").ifExists().execute();
  await db.schema
    .alterTable("model_requests")
    .dropConstraint("model_requests_sampling_identity_shape")
    .execute();
  await db.schema
    .alterTable("model_requests")
    .dropColumn("sampling_attempt")
    .dropColumn("step_context_sha256")
    .dropColumn("step_context_sequence")
    .execute();
}
