import { sql, type Kysely } from "kysely";

/**
 * Retire product experiments that are no longer reachable from the current API.
 *
 * This is intentionally destructive: candidate races, run rewind, and review
 * bundles never formed part of the supported product path. Keeping their tables
 * would make ordinary conversation queries and generated database types depend
 * on dead features.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists orchestration_acceptance_results_immutable
    on orchestration_acceptance_results
  `.execute(db);
  await sql`drop function if exists agent_dock_reject_orchestration_acceptance_mutation()`.execute(
    db,
  );
  await sql`drop trigger if exists review_bundles_immutable on review_bundles`.execute(db);
  await sql`drop function if exists agent_dock_reject_review_bundle_mutation()`.execute(db);

  await db.schema.dropTable("candidate_promotions").ifExists().execute();
  await db.schema.dropTable("orchestration_decision_gates").ifExists().execute();
  await db.schema.dropTable("orchestration_acceptance_results").ifExists().execute();
  await db.schema.dropTable("orchestration_dispatches").ifExists().execute();
  await db.schema
    .alterTable("orchestration_runs")
    .dropConstraint("orchestration_runs_winner_candidate_fk")
    .execute();
  await db.schema.dropTable("orchestration_candidates").ifExists().execute();
  await db.schema.dropTable("orchestration_runs").ifExists().execute();
  await db.schema.dropTable("review_bundles").ifExists().execute();
  await db.schema.dropTable("run_rewinds").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "061_remove_dormant_advanced_features is an intentional destructive cleanup; restore a pre-migration backup to roll back",
  );
}
