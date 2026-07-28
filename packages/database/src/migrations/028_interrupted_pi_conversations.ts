import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("artifacts").dropConstraint("artifacts_kind_valid").execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_kind_valid",
      sql`kind in (
        'pi_session_snapshot',
        'pi_interrupted_session_snapshot',
        'workspace_snapshot',
        'tool_output',
        'patch',
        'report',
        'crash_bundle'
      )`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("artifacts").dropConstraint("artifacts_kind_valid").execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_kind_valid",
      sql`kind in (
        'pi_session_snapshot',
        'workspace_snapshot',
        'tool_output',
        'patch',
        'report',
        'crash_bundle'
      )`,
    )
    .execute();
}
