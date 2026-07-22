import { sql, type Kysely } from "kysely";

const sampleSourceSet = {
  schemaVersion: 1,
  entries: [{ root: ".", kind: "sample_java" }],
};

async function dropWorkspaceSourceConstraints(db: Kysely<unknown>): Promise<void> {
  for (const constraint of [
    "workspace_sources_import_state_valid",
    "workspace_sources_shape_valid",
    "workspace_sources_kind_valid",
  ]) {
    await db.schema.alterTable("workspace_sources").dropConstraint(constraint).execute();
  }
}

async function addWorkspaceSourceConstraints(
  db: Kysely<unknown>,
  includeRepositorySet: boolean,
): Promise<void> {
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      includeRepositorySet
        ? sql`kind in ('empty', 'sample_java', 'github_public', 'github_app', 'repository_set')`
        : sql`kind in ('empty', 'sample_java', 'github_public', 'github_app')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_shape_valid",
      includeRepositorySet
        ? sql`(
              kind in ('empty', 'sample_java')
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
            ) or (
              kind = 'repository_set'
              and repository is null
              and commit_sha is null
              and github_installation_id is null
              and github_repository_id is null
            )`
        : sql`(
              kind in ('empty', 'sample_java')
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
    .addCheckConstraint(
      "workspace_sources_import_state_valid",
      sql`kind in ('empty', 'sample_java') or (
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
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await dropWorkspaceSourceConstraints(db);
  await addWorkspaceSourceConstraints(db, true);

  await db.schema
    .createTable("workspace_repository_sources")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("ordinal", "integer", (column) => column.notNull())
    .addColumn("root_path", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("repository", "text", (column) => column.notNull())
    .addColumn("commit_sha", "text", (column) => column.notNull())
    .addColumn("github_installation_id", "bigint")
    .addColumn("github_repository_id", "bigint")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("workspace_repository_sources_pk", [
      "tenant_id",
      "workspace_id",
      "ordinal",
    ])
    .addUniqueConstraint("workspace_repository_sources_root_unique", [
      "tenant_id",
      "workspace_id",
      "root_path",
    ])
    .addUniqueConstraint("workspace_repository_sources_identity_unique", [
      "tenant_id",
      "workspace_id",
      "kind",
      "repository",
    ])
    .addForeignKeyConstraint(
      "workspace_repository_sources_parent_fk",
      ["tenant_id", "workspace_id"],
      "workspace_sources",
      ["tenant_id", "workspace_id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "workspace_repository_sources_installation_fk",
      ["tenant_id", "github_installation_id"],
      "github_app_installations",
      ["tenant_id", "installation_id"],
    )
    .addForeignKeyConstraint(
      "workspace_repository_sources_repository_fk",
      ["tenant_id", "github_repository_id"],
      "github_repositories",
      ["tenant_id", "repository_id"],
    )
    .addCheckConstraint("workspace_repository_sources_ordinal_valid", sql`ordinal between 1 and 8`)
    .addCheckConstraint(
      "workspace_repository_sources_root_valid",
      sql`char_length(root_path) between 1 and 64
          and root_path ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'`,
    )
    .addCheckConstraint(
      "workspace_repository_sources_kind_valid",
      sql`kind in ('github_public', 'github_app')`,
    )
    .addCheckConstraint(
      "workspace_repository_sources_repository_valid",
      sql`char_length(repository) between 3 and 140
          and repository ~ '^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9._-]*$'
          and position('..' in repository) = 0
          and right(repository, 4) <> '.git'`,
    )
    .addCheckConstraint(
      "workspace_repository_sources_commit_valid",
      sql`commit_sha ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "workspace_repository_sources_shape_valid",
      sql`(kind = 'github_public'
            and github_installation_id is null
            and github_repository_id is null)
          or (kind = 'github_app'
            and github_installation_id is not null
            and github_repository_id is not null)`,
    )
    .execute();

  await db.schema
    .alterTable("runs")
    .addColumn("source_set_snapshot", "jsonb", (column) =>
      column.notNull().defaultTo(sql`${sql.lit(JSON.stringify(sampleSourceSet))}::jsonb`),
    )
    .execute();
  await sql`
    update runs as run
       set source_set_snapshot = case source.kind
         when 'empty' then jsonb_build_object(
           'schemaVersion', 1,
           'entries', jsonb_build_array(jsonb_build_object('root', '.', 'kind', 'empty'))
         )
         when 'sample_java' then jsonb_build_object(
           'schemaVersion', 1,
           'entries', jsonb_build_array(jsonb_build_object('root', '.', 'kind', 'sample_java'))
         )
         when 'github_public' then jsonb_build_object(
           'schemaVersion', 1,
           'entries', jsonb_build_array(jsonb_build_object(
             'root', '.', 'kind', 'github_public',
             'repository', source.repository, 'commitSha', source.commit_sha
           ))
         )
         when 'github_app' then jsonb_build_object(
           'schemaVersion', 1,
           'entries', jsonb_build_array(jsonb_build_object(
             'root', '.', 'kind', 'github_app',
             'installationId', source.github_installation_id,
             'repositoryId', source.github_repository_id,
             'repository', source.repository,
             'commitSha', source.commit_sha,
             'private', repository.private
           ))
         )
         else source_set_snapshot
       end
      from workspace_sources as source
      left join github_repositories as repository
        on repository.tenant_id = source.tenant_id
       and repository.repository_id = source.github_repository_id
     where run.tenant_id = source.tenant_id
       and run.workspace_id = source.workspace_id
  `.execute(db);
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_source_set_snapshot_valid",
      sql`jsonb_typeof(source_set_snapshot) = 'object'
          and source_set_snapshot ->> 'schemaVersion' = '1'
          and jsonb_typeof(source_set_snapshot -> 'entries') = 'array'
          and jsonb_array_length(source_set_snapshot -> 'entries') between 1 and 8`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from workspace_sources where kind = 'repository_set') then
        raise exception 'cannot roll back multi-repository source sets while repository_set rows exist';
      end if;
    end
    $$
  `.execute(db);
  await db.schema.alterTable("runs").dropConstraint("runs_source_set_snapshot_valid").execute();
  await db.schema.alterTable("runs").dropColumn("source_set_snapshot").execute();
  await db.schema.dropTable("workspace_repository_sources").execute();
  await dropWorkspaceSourceConstraints(db);
  await addWorkspaceSourceConstraints(db, false);
}
