import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspace_sources")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("repository", "text")
    .addColumn("commit_sha", "text")
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("object_key", "text")
    .addColumn("sha256", "text")
    .addColumn("size_bytes", "bigint")
    .addColumn("import_lease_id", "uuid")
    .addColumn("lease_expires_at", "timestamptz")
    .addColumn("failure_code", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("workspace_sources_pk", ["tenant_id", "workspace_id"])
    .addForeignKeyConstraint(
      "workspace_sources_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      sql`kind in ('sample_java', 'github_public')`,
    )
    .addCheckConstraint(
      "workspace_sources_status_valid",
      sql`status in ('pending', 'importing', 'ready', 'failed')`,
    )
    .addCheckConstraint(
      "workspace_sources_repository_valid",
      sql`repository is null or (
            char_length(repository) between 3 and 140
            and repository ~ '^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9._-]*$'
            and position('..' in repository) = 0
            and right(repository, 4) <> '.git'
          )`,
    )
    .addCheckConstraint(
      "workspace_sources_commit_valid",
      sql`commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "workspace_sources_object_valid",
      sql`(
            object_key is null and sha256 is null and size_bytes is null
          ) or (
            char_length(object_key) between 1 and 2048
            and sha256 ~ '^[0-9a-f]{64}$'
            and size_bytes between 1 and 2097152
          )`,
    )
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
    .addCheckConstraint(
      "workspace_sources_import_state_valid",
      sql`kind = 'sample_java' or (
            (status = 'pending'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'importing'
              and object_key is null
              and import_lease_id is not null
              and lease_expires_at is not null
              and failure_code is null)
            or (status = 'ready'
              and object_key is not null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'failed'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code ~ '^[a-z][a-z0-9_]{0,127}$')
          )`,
    )
    .execute();

  await sql`
    insert into workspace_sources (tenant_id, workspace_id, kind, status)
    select tenant_id, id, 'sample_java', 'ready'
    from workspaces
  `.execute(db);

  await db.schema
    .createIndex("workspace_sources_import_status_idx")
    .on("workspace_sources")
    .columns(["status", "lease_expires_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("workspace_sources").ifExists().execute();
}
