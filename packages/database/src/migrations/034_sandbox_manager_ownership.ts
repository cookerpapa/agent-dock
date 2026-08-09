import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sandbox_manager_instances")
    .addColumn("instance_id", "uuid", (column) => column.primaryKey())
    .addColumn("cell_id", "varchar(64)", (column) =>
      column.notNull().references("execution_cells.id"),
    )
    .addColumn("owner_base_url", "varchar(2048)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("lease_expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("last_heartbeat_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "sandbox_manager_instances_state_valid",
      sql`state in ('ready', 'stopped', 'lost')`,
    )
    .execute();
  await sql`
    create unique index sandbox_manager_ready_owner_url_unique
      on sandbox_manager_instances (owner_base_url)
      where state = 'ready'
  `.execute(db);

  await db.schema
    .createTable("sandbox_manager_activations")
    .addColumn("activation_id", "uuid", (column) => column.primaryKey())
    .addColumn("cell_id", "varchar(64)", (column) =>
      column.notNull().references("execution_cells.id"),
    )
    .addColumn("owner_instance_id", "uuid", (column) =>
      column.notNull().references("sandbox_manager_instances.instance_id"),
    )
    .addColumn("owner_base_url", "varchar(2048)", (column) => column.notNull())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("project_id", "uuid", (column) => column.notNull().references("projects.id"))
    .addColumn("workspace_id", "uuid", (column) => column.notNull().references("workspaces.id"))
    .addColumn("supervisor_id", "text", (column) => column.notNull())
    .addColumn("boot_id", "uuid", (column) => column.notNull())
    .addColumn("sandbox_id", "uuid", (column) => column.notNull())
    .addColumn("command_id", "text", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull().references("sessions.id"))
    .addColumn("turn_id", "uuid", (column) => column.notNull().references("turns.id"))
    .addColumn("attempt_id", "uuid", (column) => column.notNull().references("run_attempts.id"))
    .addColumn("lease_id", "uuid", (column) =>
      column.notNull().references("session_leases.lease_id"),
    )
    .addColumn("fencing_token", "bigint", (column) => column.notNull())
    .addColumn("capability_sha256", "char(64)", (column) => column.notNull())
    .addColumn("turn_context_sha256", "char(64)", (column) => column.notNull())
    .addColumn("attempt_context_sha256", "char(64)", (column) => column.notNull())
    .addColumn("environment_sha256", "char(64)", (column) => column.notNull())
    .addColumn("workspace_revision", "char(64)")
    .addColumn("runtime_id", "varchar(256)")
    .addColumn("runtime_name", "varchar(128)")
    .addColumn("state", "varchar(20)", (column) => column.notNull())
    .addColumn("failure_code", "varchar(128)")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "sandbox_manager_activations_state_valid",
      sql`state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'released', 'unknown')`,
    )
    .addCheckConstraint("sandbox_manager_activations_fence_valid", sql`fencing_token > 0`)
    .execute();
  await sql`
    create unique index sandbox_manager_workspace_live_unique
      on sandbox_manager_activations (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning')
  `.execute(db);
  await db.schema
    .createIndex("sandbox_manager_activation_owner_idx")
    .on("sandbox_manager_activations")
    .columns(["owner_instance_id", "state"])
    .execute();

  await db.schema
    .createTable("sandbox_manager_operations")
    .addColumn("operation_id", "uuid", (column) => column.primaryKey())
    .addColumn("activation_id", "uuid", (column) =>
      column.notNull().references("sandbox_manager_activations.activation_id"),
    )
    .addColumn("owner_instance_id", "uuid", (column) =>
      column.notNull().references("sandbox_manager_instances.instance_id"),
    )
    .addColumn("request_sha256", "char(64)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("failure_code", "varchar(128)")
    .addColumn("started_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addCheckConstraint(
      "sandbox_manager_operations_state_valid",
      sql`state in ('running', 'succeeded', 'failed', 'cancelled', 'unknown')`,
    )
    .execute();
  await db.schema
    .createIndex("sandbox_manager_operation_activation_idx")
    .on("sandbox_manager_operations")
    .columns(["activation_id", "started_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sandbox_manager_operations").execute();
  await db.schema.dropTable("sandbox_manager_activations").execute();
  await db.schema.dropTable("sandbox_manager_instances").execute();
}
