import { sql, type Kysely } from "kysely";

const defaultProfileKey = "agent-dock-fullstack";
const defaultProfileVersion = "1";
const defaultSpecSha256 = "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("environment_versions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("version_number", "integer", (column) => column.notNull())
    .addColumn("profile_key", "text", (column) => column.notNull())
    .addColumn("profile_version", "text", (column) => column.notNull())
    .addColumn("image_revision", "text", (column) => column.notNull())
    .addColumn("spec_sha256", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("active", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("validated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("environment_versions_tenant_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("environment_versions_project_id_unique", [
      "tenant_id",
      "project_id",
      "id",
    ])
    .addUniqueConstraint("environment_versions_project_number_unique", [
      "tenant_id",
      "project_id",
      "version_number",
    ])
    .addForeignKeyConstraint(
      "environment_versions_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addCheckConstraint("environment_versions_number_positive", sql`version_number > 0`)
    .addCheckConstraint(
      "environment_versions_profile_key_valid",
      sql`profile_key = 'agent-dock-fullstack'`,
    )
    .addCheckConstraint("environment_versions_profile_version_valid", sql`profile_version = '1'`)
    .addCheckConstraint(
      "environment_versions_image_revision_valid",
      sql`image_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    )
    .addCheckConstraint(
      "environment_versions_spec_sha256_valid",
      sql`spec_sha256 = 'e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630'`,
    )
    .addCheckConstraint(
      "environment_versions_state_valid",
      sql`state in ('pending', 'validated', 'failed')`,
    )
    .addCheckConstraint(
      "environment_versions_validation_shape",
      sql`(state = 'validated' and validated_at is not null)
          or (state <> 'validated' and validated_at is null)`,
    )
    .execute();

  await db.schema
    .createIndex("environment_versions_one_active_per_project")
    .unique()
    .on("environment_versions")
    .columns(["tenant_id", "project_id"])
    .where(sql<boolean>`active = true`)
    .execute();

  await sql`
    insert into environment_versions (
      id, tenant_id, project_id, version_number, profile_key, profile_version,
      image_revision, spec_sha256, state, active, created_at, updated_at
    )
    select
      project.id,
      project.tenant_id,
      project.id,
      1,
      ${defaultProfileKey},
      ${defaultProfileVersion},
      'legacy',
      ${defaultSpecSha256},
      'pending',
      true,
      project.created_at,
      project.updated_at
    from projects as project
  `.execute(db);

  await db.schema.alterTable("runs").addColumn("environment_version_id", "uuid").execute();
  await sql`
    update runs
       set environment_version_id = project_id
  `.execute(db);
  await db.schema
    .alterTable("runs")
    .alterColumn("environment_version_id", (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable("runs")
    .addForeignKeyConstraint(
      "runs_environment_version_fk",
      ["tenant_id", "project_id", "environment_version_id"],
      "environment_versions",
      ["tenant_id", "project_id", "id"],
    )
    .execute();

  await db.schema
    .createTable("environment_validations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("environment_version_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_id", "uuid", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("report", "jsonb")
    .addColumn("failure_code", "text")
    .addColumn("validated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("environment_validations_attempt_unique", [
      "environment_version_id",
      "run_id",
      "attempt_id",
    ])
    .addForeignKeyConstraint(
      "environment_validations_environment_fk",
      ["tenant_id", "project_id", "environment_version_id"],
      "environment_versions",
      ["tenant_id", "project_id", "id"],
    )
    .addForeignKeyConstraint("environment_validations_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "environment_validations_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addCheckConstraint(
      "environment_validations_status_valid",
      sql`status in ('validated', 'failed')`,
    )
    .addCheckConstraint(
      "environment_validations_shape",
      sql`(status = 'validated' and report is not null and failure_code is null)
          or (status = 'failed' and report is null and failure_code is not null)`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("environment_validations").execute();
  await db.schema.alterTable("runs").dropConstraint("runs_environment_version_fk").execute();
  await db.schema.alterTable("runs").dropColumn("environment_version_id").execute();
  await db.schema.dropTable("environment_versions").execute();
}
