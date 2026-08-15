import { sql, type Kysely } from "kysely";

/**
 * Remove the JSONL-era conversation checkpoint bridge.
 *
 * Pi conversation state is authoritative in PostgreSQL SessionStorage. A
 * Workspace version therefore references only filesystem artifacts; it no
 * longer needs a synthetic Pi artifact or an object-store pointer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_pi_artifact_fk")
    .execute();
  await db.schema.alterTable("runs").dropConstraint("runs_pi_session_base_artifact_fk").execute();

  await db.schema.alterTable("workspace_versions").dropColumn("pi_artifact_id").execute();
  await db.schema.alterTable("runs").dropColumn("pi_session_base_artifact_id").execute();
  await db.schema.alterTable("sessions").dropColumn("pi_session_snapshot_key").execute();

  await sql`
    delete from artifacts
    where kind in ('pi_session_snapshot', 'pi_interrupted_session_snapshot')
  `.execute(db);
  await db.schema.alterTable("artifacts").dropConstraint("artifacts_kind_valid").execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_kind_valid",
      sql`kind in ('workspace_snapshot', 'tool_output', 'patch', 'report', 'crash_bundle')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "062_postgres_session_storage_only is an intentional destructive cleanup; restore a pre-migration backup to roll back",
  );
}
