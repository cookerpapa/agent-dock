import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("github_app_installations")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("installation_id", "bigint", (column) => column.notNull())
    .addColumn("account_id", "bigint", (column) => column.notNull())
    .addColumn("account_login", "text", (column) => column.notNull())
    .addColumn("target_type", "text", (column) => column.notNull())
    .addColumn("repository_selection", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull().defaultTo("active"))
    .addColumn("permissions", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("suspended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("github_app_installations_pk", ["tenant_id", "installation_id"])
    .addForeignKeyConstraint("github_app_installations_tenant_fk", ["tenant_id"], "tenants", ["id"])
    .addCheckConstraint("github_installation_id_positive", sql`installation_id > 0`)
    .addCheckConstraint("github_installation_account_id_positive", sql`account_id > 0`)
    .addCheckConstraint(
      "github_installation_login_bounded",
      sql`char_length(account_login) between 1 and 128`,
    )
    .addCheckConstraint(
      "github_installation_target_valid",
      sql`target_type in ('User', 'Organization')`,
    )
    .addCheckConstraint(
      "github_installation_selection_valid",
      sql`repository_selection in ('all', 'selected')`,
    )
    .addCheckConstraint(
      "github_installation_status_valid",
      sql`status in ('active', 'suspended', 'removed')`,
    )
    .execute();

  await db.schema
    .createTable("github_repositories")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("repository_id", "bigint", (column) => column.notNull())
    .addColumn("installation_id", "bigint", (column) => column.notNull())
    .addColumn("full_name", "text", (column) => column.notNull())
    .addColumn("owner_login", "text", (column) => column.notNull())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("private", "boolean", (column) => column.notNull())
    .addColumn("default_branch", "text", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("github_repositories_pk", ["tenant_id", "repository_id"])
    .addUniqueConstraint("github_repositories_tenant_name_unique", ["tenant_id", "full_name"])
    .addForeignKeyConstraint(
      "github_repositories_installation_fk",
      ["tenant_id", "installation_id"],
      "github_app_installations",
      ["tenant_id", "installation_id"],
    )
    .addCheckConstraint("github_repository_id_positive", sql`repository_id > 0`)
    .addCheckConstraint(
      "github_repository_full_name_valid",
      sql`char_length(full_name) between 3 and 140
          and full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*$'`,
    )
    .addCheckConstraint(
      "github_repository_branch_bounded",
      sql`char_length(default_branch) between 1 and 255`,
    )
    .execute();

  await db.schema
    .createIndex("github_installations_global_id_unique")
    .unique()
    .on("github_app_installations")
    .column("installation_id")
    .execute();

  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_shape_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addColumn("github_installation_id", "bigint")
    .addColumn("github_repository_id", "bigint")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      sql`kind in ('sample_java', 'github_public', 'github_app')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_shape_valid",
      sql`(
            kind = 'sample_java'
            and repository is null
            and commit_sha is null
            and github_installation_id is null
            and github_repository_id is null
            and status = 'ready'
            and object_key is null
            and import_lease_id is null
            and lease_expires_at is null
            and failure_code is null
          ) or (
            kind = 'github_public'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is null
            and github_repository_id is null
          ) or (
            kind = 'github_app'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is not null
            and github_repository_id is not null
          )`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addForeignKeyConstraint(
      "workspace_sources_github_installation_fk",
      ["tenant_id", "github_installation_id"],
      "github_app_installations",
      ["tenant_id", "installation_id"],
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addForeignKeyConstraint(
      "workspace_sources_github_repository_fk",
      ["tenant_id", "github_repository_id"],
      "github_repositories",
      ["tenant_id", "repository_id"],
    )
    .execute();

  await db.schema
    .alterTable("artifacts")
    .addColumn("run_id", "uuid")
    .addColumn("file_name", "text")
    .addColumn("media_type", "text")
    .execute();
  await db.schema
    .alterTable("artifacts")
    .addForeignKeyConstraint("artifacts_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_file_name_bounded",
      sql`file_name is null or char_length(file_name) between 1 and 512`,
    )
    .execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_media_type_bounded",
      sql`media_type is null or char_length(media_type) between 1 and 256`,
    )
    .execute();

  await db.schema
    .createTable("workspace_versions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("version_number", "integer", (column) => column.notNull())
    .addColumn("parent_version_id", "uuid")
    .addColumn("source_version_id", "uuid")
    .addColumn("origin_kind", "text", (column) => column.notNull())
    .addColumn("run_id", "uuid")
    .addColumn("attempt_id", "uuid")
    .addColumn("turn_id", "uuid")
    .addColumn("pi_artifact_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_artifact_id", "uuid", (column) => column.notNull())
    .addColumn("patch_artifact_id", "uuid")
    .addColumn("revision", "text", (column) => column.notNull())
    .addColumn("file_count", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("state", "text", (column) => column.notNull().defaultTo("staged"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("workspace_versions_tenant_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("workspace_versions_session_id_unique", ["session_id", "id"])
    .addUniqueConstraint("workspace_versions_session_number_unique", [
      "session_id",
      "version_number",
    ])
    .addForeignKeyConstraint(
      "workspace_versions_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_versions_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_versions_parent_fk",
      ["parent_version_id"],
      "workspace_versions",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_versions_source_fk",
      ["source_version_id"],
      "workspace_versions",
      ["id"],
    )
    .addForeignKeyConstraint("workspace_versions_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "workspace_versions_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_versions_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addForeignKeyConstraint("workspace_versions_pi_artifact_fk", ["pi_artifact_id"], "artifacts", [
      "id",
    ])
    .addForeignKeyConstraint(
      "workspace_versions_workspace_artifact_fk",
      ["workspace_artifact_id"],
      "artifacts",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_versions_patch_artifact_fk",
      ["patch_artifact_id"],
      "artifacts",
      ["id"],
    )
    .addCheckConstraint("workspace_versions_number_positive", sql`version_number > 0`)
    .addCheckConstraint(
      "workspace_versions_origin_valid",
      sql`origin_kind in ('checkpoint', 'fork', 'migration')`,
    )
    .addCheckConstraint("workspace_versions_revision_valid", sql`revision ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("workspace_versions_file_count_valid", sql`file_count between 0 and 512`)
    .addCheckConstraint(
      "workspace_versions_state_valid",
      sql`state in ('staged', 'settled', 'abandoned')`,
    )
    .addCheckConstraint(
      "workspace_versions_settlement_shape",
      sql`(state = 'settled' and settled_at is not null)
          or (state in ('staged', 'abandoned') and settled_at is null)`,
    )
    .addCheckConstraint(
      "workspace_versions_execution_shape",
      sql`(origin_kind = 'checkpoint' and run_id is not null and attempt_id is not null and turn_id is not null)
          or (origin_kind in ('fork', 'migration') and run_id is null and attempt_id is null and turn_id is null)`,
    )
    .execute();

  await db.schema
    .alterTable("sessions")
    .addColumn("current_workspace_version_id", "uuid")
    .addColumn("forked_from_session_id", "uuid")
    .addColumn("archived_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_current_workspace_version_fk",
      ["id", "current_workspace_version_id"],
      "workspace_versions",
      ["session_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_forked_from_fk",
      ["tenant_id", "forked_from_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .execute();

  await sql`
    insert into workspace_versions (
      id, tenant_id, workspace_id, session_id, version_number, origin_kind,
      pi_artifact_id, workspace_artifact_id, revision, state, created_at, settled_at
    )
    select
      session_row.id,
      session_row.tenant_id,
      session_row.workspace_id,
      session_row.id,
      1,
      'migration',
      pi.id,
      workspace.id,
      workspace.sha256,
      'settled',
      greatest(pi.created_at, workspace.created_at),
      greatest(pi.created_at, workspace.created_at)
    from sessions as session_row
    inner join artifacts as pi
      on pi.tenant_id = session_row.tenant_id
      and pi.session_id = session_row.id
      and pi.object_key = session_row.pi_session_snapshot_key
      and pi.kind = 'pi_session_snapshot'
    inner join artifacts as workspace
      on workspace.tenant_id = session_row.tenant_id
      and workspace.session_id = session_row.id
      and workspace.object_key = session_row.workspace_snapshot_key
      and workspace.kind = 'workspace_snapshot'
    where session_row.pi_session_snapshot_key is not null
      and session_row.workspace_snapshot_key is not null
  `.execute(db);

  await sql`
    update sessions
    set current_workspace_version_id = id
    where exists (
      select 1 from workspace_versions where workspace_versions.id = sessions.id
    )
  `.execute(db);

  await db.schema
    .createTable("workspace_operations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("from_version_id", "uuid")
    .addColumn("to_version_id", "uuid")
    .addColumn("source_session_id", "uuid")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("workspace_operations_session_key_unique", [
      "session_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "workspace_operations_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_operations_from_version_fk",
      ["from_version_id"],
      "workspace_versions",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_operations_to_version_fk",
      ["to_version_id"],
      "workspace_versions",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_operations_source_session_fk",
      ["tenant_id", "source_session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "workspace_operations_kind_valid",
      sql`kind in ('fork', 'rollback', 'archive', 'unarchive')`,
    )
    .addCheckConstraint(
      "workspace_operations_idempotency_bounded",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .execute();

  await db.schema
    .createTable("test_results")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_version_id", "uuid")
    .addColumn("tool_call_id", "text", (column) => column.notNull())
    .addColumn("command", "text", (column) => column.notNull())
    .addColumn("suite", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("exit_code", "integer")
    .addColumn("duration_ms", "integer")
    .addColumn("summary", "text")
    .addColumn("artifact_id", "uuid")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("test_results_run_tool_unique", ["run_id", "tool_call_id"])
    .addForeignKeyConstraint("test_results_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "test_results_version_fk",
      ["tenant_id", "workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint("test_results_artifact_fk", ["artifact_id"], "artifacts", ["id"])
    .addCheckConstraint("test_results_status_valid", sql`status in ('passed', 'failed', 'errored')`)
    .addCheckConstraint(
      "test_results_command_bounded",
      sql`char_length(command) between 1 and 4096`,
    )
    .addCheckConstraint("test_results_suite_bounded", sql`char_length(suite) between 1 and 256`)
    .addCheckConstraint(
      "test_results_duration_valid",
      sql`duration_ms is null or duration_ms between 0 and 86400000`,
    )
    .execute();

  await db.schema
    .createTable("github_pull_request_deliveries")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_version_id", "uuid", (column) => column.notNull())
    .addColumn("repository_id", "bigint", (column) => column.notNull())
    .addColumn("installation_id", "bigint", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("base_branch", "text", (column) => column.notNull())
    .addColumn("base_commit_sha", "text", (column) => column.notNull())
    .addColumn("head_branch", "text", (column) => column.notNull())
    .addColumn("title", "text", (column) => column.notNull())
    .addColumn("body", "text", (column) => column.notNull())
    .addColumn("commit_sha", "text")
    .addColumn("pull_request_number", "integer")
    .addColumn("pull_request_url", "text")
    .addColumn("check_run_id", "bigint")
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("failure_code", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .addUniqueConstraint("github_pr_delivery_tenant_key_unique", ["tenant_id", "idempotency_key"])
    .addUniqueConstraint("github_pr_delivery_branch_unique", ["repository_id", "head_branch"])
    .addForeignKeyConstraint(
      "github_pr_delivery_version_fk",
      ["tenant_id", "workspace_version_id"],
      "workspace_versions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "github_pr_delivery_repository_fk",
      ["tenant_id", "repository_id"],
      "github_repositories",
      ["tenant_id", "repository_id"],
    )
    .addCheckConstraint(
      "github_pr_delivery_state_valid",
      sql`state in ('pending', 'delivering', 'completed', 'failed')`,
    )
    .addCheckConstraint("github_pr_delivery_attempts_nonnegative", sql`attempts >= 0`)
    .addCheckConstraint(
      "github_pr_delivery_commit_valid",
      sql`commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint("github_pr_delivery_base_valid", sql`base_commit_sha ~ '^[0-9a-f]{40}$'`)
    .addCheckConstraint(
      "github_pr_delivery_settlement_shape",
      sql`(state = 'completed' and commit_sha is not null and pull_request_number > 0
            and pull_request_url is not null and completed_at is not null and failure_code is null)
          or (state = 'failed' and failure_code is not null and completed_at is null)
          or (state in ('pending', 'delivering') and completed_at is null)`,
    )
    .execute();

  await db.schema
    .createTable("github_webhook_deliveries")
    .addColumn("delivery_id", "text", (column) => column.primaryKey())
    .addColumn("event_name", "text", (column) => column.notNull())
    .addColumn("payload_sha256", "text", (column) => column.notNull())
    .addColumn("tenant_id", "uuid")
    .addColumn("installation_id", "bigint")
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("failure_code", "text")
    .addColumn("received_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("processed_at", "timestamptz")
    .addCheckConstraint(
      "github_webhook_delivery_id_bounded",
      sql`char_length(delivery_id) between 1 and 128`,
    )
    .addCheckConstraint(
      "github_webhook_event_bounded",
      sql`char_length(event_name) between 1 and 128`,
    )
    .addCheckConstraint("github_webhook_hash_valid", sql`payload_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint(
      "github_webhook_status_valid",
      sql`status in ('processed', 'ignored', 'failed')`,
    )
    .execute();

  await db.schema
    .createIndex("workspace_versions_session_created_idx")
    .on("workspace_versions")
    .columns(["tenant_id", "session_id", "version_number"])
    .execute();
  await db.schema
    .createIndex("workspace_versions_one_run")
    .unique()
    .on("workspace_versions")
    .column("run_id")
    .where(sql<boolean>`run_id is not null`)
    .execute();
  await db.schema
    .createIndex("artifacts_run_kind_idx")
    .on("artifacts")
    .columns(["tenant_id", "run_id", "kind"])
    .execute();
  await db.schema
    .createIndex("github_pr_delivery_state_idx")
    .on("github_pull_request_deliveries")
    .columns(["state", "updated_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("github_webhook_deliveries").ifExists().execute();
  await db.schema.dropTable("github_pull_request_deliveries").ifExists().execute();
  await db.schema.dropTable("test_results").ifExists().execute();
  await db.schema.dropTable("workspace_operations").ifExists().execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_current_workspace_version_fk")
    .execute();
  await db.schema.alterTable("sessions").dropConstraint("sessions_forked_from_fk").execute();
  await db.schema
    .alterTable("sessions")
    .dropColumn("archived_at")
    .dropColumn("forked_from_session_id")
    .dropColumn("current_workspace_version_id")
    .execute();
  await db.schema.dropTable("workspace_versions").ifExists().execute();
  await db.schema.alterTable("artifacts").dropConstraint("artifacts_run_fk").execute();
  await db.schema
    .alterTable("artifacts")
    .dropColumn("media_type")
    .dropColumn("file_name")
    .dropColumn("run_id")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_github_repository_fk")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_github_installation_fk")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_shape_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropColumn("github_repository_id")
    .dropColumn("github_installation_id")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      sql`kind in ('sample_java', 'github_public')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_shape_valid",
      sql`(
            kind = 'sample_java'
            and repository is null
            and commit_sha is null
            and status = 'ready'
            and object_key is null
            and import_lease_id is null
            and lease_expires_at is null
            and failure_code is null
          ) or (
            kind = 'github_public'
            and repository is not null
            and commit_sha is not null
          )`,
    )
    .execute();
  await db.schema.dropTable("github_repositories").ifExists().execute();
  await db.schema.dropTable("github_app_installations").ifExists().execute();
}
