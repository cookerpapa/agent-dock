import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("artifacts")
    .addUniqueConstraint("artifacts_tenant_id_unique", ["tenant_id", "id"])
    .execute();

  await db.schema
    .alterTable("runs")
    .addColumn("conversation_base_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("workspace_base_version_id", "uuid")
    .addColumn("pi_session_base_artifact_id", "uuid")
    .execute();

  await sql`
    update runs as run
    set conversation_base_seq = coalesce(
      (
        select greatest(min(event.seq) - 1, 0)
        from session_events as event
        where event.tenant_id = run.tenant_id
          and event.session_id = run.session_id
          and event.turn_id = run.turn_id
      ),
      0
    )
  `.execute(db);

  await sql`
    update runs as run
    set workspace_base_version_id = coalesce(
      (
        select version.parent_version_id
        from workspace_versions as version
        where version.tenant_id = run.tenant_id
          and version.run_id = run.id
        limit 1
      ),
      (
        select version.id
        from workspace_versions as version
        where version.tenant_id = run.tenant_id
          and version.session_id = run.session_id
          and version.state = 'settled'
          and version.created_at <= run.queued_at
        order by version.version_number desc
        limit 1
      )
    )
  `.execute(db);

  await sql`
    update runs as run
    set pi_session_base_artifact_id = coalesce(
      (
        select version.pi_artifact_id
        from workspace_versions as version
        where version.tenant_id = run.tenant_id
          and version.id = run.workspace_base_version_id
      ),
      (
        select artifact.id
        from artifacts as artifact
        where artifact.tenant_id = run.tenant_id
          and artifact.session_id = run.session_id
          and artifact.kind = 'pi_session_snapshot'
          and artifact.created_at <= run.queued_at
        order by artifact.created_at desc, artifact.id desc
        limit 1
      )
    )
  `.execute(db);

  await db.schema
    .alterTable("runs")
    .addForeignKeyConstraint(
      "runs_workspace_base_version_fk",
      ["tenant_id", "workspace_base_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addForeignKeyConstraint(
      "runs_pi_session_base_artifact_fk",
      ["tenant_id", "pi_session_base_artifact_id"],
      "artifacts",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint("runs_conversation_base_seq_nonnegative", sql`conversation_base_seq >= 0`)
    .execute();

  await db.schema
    .createTable("run_rewinds")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("source_run_id", "uuid", (column) => column.notNull())
    .addColumn("source_attempt_id", "uuid", (column) => column.notNull())
    .addColumn("replacement_run_id", "uuid", (column) => column.notNull())
    .addColumn("conversation_boundary_seq", "bigint", (column) => column.notNull())
    .addColumn("workspace_base_version_id", "uuid")
    .addColumn("pi_session_base_artifact_id", "uuid")
    .addColumn("actor_user_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("run_rewinds_source_unique", ["tenant_id", "source_run_id"])
    .addUniqueConstraint("run_rewinds_replacement_unique", ["tenant_id", "replacement_run_id"])
    .addUniqueConstraint("run_rewinds_session_key_unique", ["session_id", "idempotency_key"])
    .addForeignKeyConstraint("run_rewinds_session_fk", ["tenant_id", "session_id"], "sessions", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint("run_rewinds_source_run_fk", ["tenant_id", "source_run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "run_rewinds_source_attempt_fk",
      ["tenant_id", "source_run_id", "source_attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "run_rewinds_replacement_run_fk",
      ["tenant_id", "replacement_run_id"],
      "runs",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "run_rewinds_workspace_version_fk",
      ["tenant_id", "workspace_base_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "run_rewinds_pi_artifact_fk",
      ["tenant_id", "pi_session_base_artifact_id"],
      "artifacts",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint("run_rewinds_actor_fk", ["tenant_id", "actor_user_id"], "users", [
      "tenant_id",
      "id",
    ])
    .addCheckConstraint("run_rewinds_boundary_nonnegative", sql`conversation_boundary_seq >= 0`)
    .addCheckConstraint(
      "run_rewinds_idempotency_bounded",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .execute();

  await db.schema
    .createTable("review_bundles")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_version_id", "uuid")
    .addColumn("manifest", "jsonb", (column) => column.notNull())
    .addColumn("manifest_sha256", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("review_bundles_tenant_run_unique", ["tenant_id", "run_id"])
    .addUniqueConstraint("review_bundles_tenant_id_unique", ["tenant_id", "id"])
    .addForeignKeyConstraint("review_bundles_project_fk", ["tenant_id", "project_id"], "projects", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "review_bundles_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint("review_bundles_session_fk", ["tenant_id", "session_id"], "sessions", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "review_bundles_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "review_bundles_workspace_version_fk",
      ["tenant_id", "workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "review_bundles_manifest_sha256_valid",
      sql`manifest_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute();

  await sql`
    create function agent_dock_reject_review_bundle_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'review bundles are immutable';
    end
    $$
  `.execute(db);
  await sql`
    create trigger review_bundles_immutable
    before update or delete on review_bundles
    for each row execute function agent_dock_reject_review_bundle_mutation()
  `.execute(db);

  await db.schema
    .createIndex("run_rewinds_session_created_idx")
    .on("run_rewinds")
    .columns(["tenant_id", "session_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("review_bundles_session_created_idx")
    .on("review_bundles")
    .columns(["tenant_id", "session_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists review_bundles_immutable on review_bundles`.execute(db);
  await sql`drop function if exists agent_dock_reject_review_bundle_mutation()`.execute(db);
  await db.schema.dropTable("review_bundles").ifExists().execute();
  await db.schema.dropTable("run_rewinds").ifExists().execute();
  await db.schema.alterTable("runs").dropConstraint("runs_pi_session_base_artifact_fk").execute();
  await db.schema.alterTable("runs").dropConstraint("runs_workspace_base_version_fk").execute();
  await db.schema
    .alterTable("runs")
    .dropConstraint("runs_conversation_base_seq_nonnegative")
    .execute();
  await db.schema.alterTable("runs").dropColumn("pi_session_base_artifact_id").execute();
  await db.schema.alterTable("runs").dropColumn("workspace_base_version_id").execute();
  await db.schema.alterTable("runs").dropColumn("conversation_base_seq").execute();
  await db.schema.alterTable("artifacts").dropConstraint("artifacts_tenant_id_unique").execute();
}
