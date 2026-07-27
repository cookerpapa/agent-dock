import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_current_workspace_version_fk")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_current_workspace_version_fk",
      ["current_workspace_version_id"],
      "workspace_versions",
      ["id"],
    )
    .execute();
  await db.schema
    .alterTable("workspaces")
    .addColumn("current_workspace_version_id", "uuid")
    .addColumn("row_version", "bigint", (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("workspaces")
    .addForeignKeyConstraint(
      "workspaces_current_workspace_version_fk",
      ["current_workspace_version_id"],
      "workspace_versions",
      ["id"],
    )
    .execute();

  await sql`
    update workspaces
    set current_workspace_version_id = (
      select version.id
      from workspace_versions as version
      inner join sessions as origin_session
        on origin_session.tenant_id = version.tenant_id
        and origin_session.id = version.session_id
      where version.tenant_id = workspaces.tenant_id
        and version.workspace_id = workspaces.id
        and version.state = 'settled'
        and origin_session.forked_from_session_id is null
      order by version.settled_at desc, version.version_number desc, version.id desc
      limit 1
    )
  `.execute(db);

  await sql`
    update sessions
    set
      current_workspace_version_id = workspace.current_workspace_version_id,
      workspace_snapshot_key = artifact.object_key
    from workspaces as workspace
    left join workspace_versions as version
      on version.id = workspace.current_workspace_version_id
    left join artifacts as artifact
      on artifact.id = version.workspace_artifact_id
    where workspace.tenant_id = sessions.tenant_id
      and workspace.id = sessions.workspace_id
      and sessions.forked_from_session_id is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspaces")
    .dropConstraint("workspaces_current_workspace_version_fk")
    .execute();
  await db.schema
    .alterTable("workspaces")
    .dropColumn("current_workspace_version_id")
    .dropColumn("row_version")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_current_workspace_version_fk")
    .execute();
  await sql`
    update sessions
    set current_workspace_version_id = (
      select version.id
      from workspace_versions as version
      where version.session_id = sessions.id
        and version.state = 'settled'
      order by version.settled_at desc, version.version_number desc, version.id desc
      limit 1
    )
  `.execute(db);
  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_current_workspace_version_fk",
      ["id", "current_workspace_version_id"],
      "workspace_versions",
      ["session_id", "id"],
    )
    .execute();
}
