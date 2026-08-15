import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspace_terminal_sessions")
    .addColumn("terminal_id", "uuid", (column) => column.primaryKey())
    .addColumn("sandbox_domain_id", "varchar(64)", (column) => column.notNull())
    .addColumn("owner_instance_id", "uuid", (column) => column.notNull())
    .addColumn("owner_base_url", "varchar(2048)", (column) => column.notNull())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("runtime_id", "varchar(256)")
    .addColumn("runtime_name", "varchar(128)")
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("lease_expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("last_heartbeat_at", "timestamptz", (column) => column.notNull())
    .addColumn("failure_code", "varchar(128)")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "workspace_terminal_domain_fk",
      ["sandbox_domain_id"],
      "sandbox_domains",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_terminal_owner_fk",
      ["owner_instance_id"],
      "tool_broker_instances",
      ["instance_id"],
    )
    .addForeignKeyConstraint("workspace_terminal_user_fk", ["tenant_id", "user_id"], "users", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "workspace_terminal_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_terminal_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_terminal_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "workspace_terminal_state_valid",
      sql`state in ('reserved', 'materializing', 'active', 'cleaning', 'released', 'unknown')`,
    )
    .execute();

  await sql`
    create unique index workspace_terminal_live_workspace_unique
      on workspace_terminal_sessions (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'cleaning', 'unknown')
  `.execute(db);
  await sql`
    create index workspace_terminal_owner_live_idx
      on workspace_terminal_sessions (owner_instance_id, lease_expires_at)
      where state in ('reserved', 'materializing', 'active', 'cleaning')
  `.execute(db);
  await sql`
    create index workspace_terminal_tenant_live_idx
      on workspace_terminal_sessions (tenant_id, sandbox_domain_id)
      where state in ('reserved', 'materializing', 'active', 'cleaning', 'unknown')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("workspace_terminal_sessions").execute();
}
