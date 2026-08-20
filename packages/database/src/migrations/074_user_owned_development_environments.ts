import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("development_environments")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("owner_user_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("sandbox_domain_id", "varchar(64)", (column) => column.notNull())
    .addColumn("environment_version_id", "uuid")
    .addColumn("owner_instance_id", "uuid")
    .addColumn("owner_base_url", "varchar(2048)")
    .addColumn("generation", "bigint", (column) => column.notNull().defaultTo(1))
    .addColumn("runtime_id", "varchar(256)")
    .addColumn("runtime_name", "varchar(128)")
    .addColumn("state", "varchar(20)", (column) => column.notNull())
    .addColumn("failure_code", "varchar(128)")
    .addColumn("idempotency_key", "varchar(256)", (column) => column.notNull())
    .addColumn("request_sha256", "char(64)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("released_at", "timestamptz")
    .addUniqueConstraint("development_environments_tenant_id_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("development_environments_owner_idempotency_unique", [
      "tenant_id",
      "owner_user_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "development_environments_user_fk",
      ["tenant_id", "owner_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "development_environments_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "development_environments_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "development_environments_environment_fk",
      ["tenant_id", "project_id", "environment_version_id"],
      "environment_versions",
      ["tenant_id", "project_id", "id"],
    )
    .addForeignKeyConstraint(
      "development_environments_domain_fk",
      ["sandbox_domain_id"],
      "sandbox_domains",
      ["id"],
    )
    .addForeignKeyConstraint(
      "development_environments_owner_instance_fk",
      ["owner_instance_id"],
      "tool_broker_instances",
      ["instance_id"],
    )
    .addCheckConstraint(
      "development_environments_state_valid",
      sql`state in ('requested', 'provisioning', 'running', 'paused', 'releasing', 'released', 'failed', 'unknown')`,
    )
    .addCheckConstraint("development_environments_generation_valid", sql`generation > 0`)
    .addCheckConstraint(
      "development_environments_request_sha_valid",
      sql`request_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "development_environments_owner_shape",
      sql`(state in ('requested', 'released') and owner_instance_id is null and owner_base_url is null)
          or (state not in ('requested', 'released') and owner_instance_id is not null and owner_base_url is not null)`,
    )
    .addCheckConstraint(
      "development_environments_runtime_shape",
      sql`(state in ('running', 'paused') and runtime_id is not null and runtime_name is not null)
          or (state not in ('running', 'paused') and runtime_id is null and runtime_name is null)`,
    )
    .addCheckConstraint(
      "development_environments_release_shape",
      sql`(state = 'released' and released_at is not null)
          or (state <> 'released' and released_at is null)`,
    )
    .execute();

  await sql`
    create unique index development_environments_live_workspace_unique
      on development_environments (tenant_id, workspace_id)
      where state in ('requested', 'provisioning', 'running', 'paused', 'releasing', 'unknown')
  `.execute(db);
  await db.schema
    .createIndex("development_environments_owner_list_idx")
    .on("development_environments")
    .columns(["tenant_id", "owner_user_id", "updated_at"])
    .execute();
  await db.schema
    .createIndex("development_environments_broker_owner_idx")
    .on("development_environments")
    .columns(["owner_instance_id", "state", "updated_at"])
    .execute();

  await db.schema
    .createTable("development_environment_operations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("environment_id", "uuid", (column) => column.notNull())
    .addColumn("actor_user_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "varchar(256)", (column) => column.notNull())
    .addColumn("action", "varchar(16)", (column) => column.notNull())
    .addColumn("request_sha256", "char(64)", (column) => column.notNull())
    .addColumn("result_state", "varchar(20)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("development_environment_operations_idempotency_unique", [
      "tenant_id",
      "environment_id",
      "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "development_environment_operations_environment_fk",
      ["tenant_id", "environment_id"],
      "development_environments",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "development_environment_operations_actor_fk",
      ["tenant_id", "actor_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "development_environment_operations_action_valid",
      sql`action in ('start', 'pause', 'resume', 'release')`,
    )
    .addCheckConstraint(
      "development_environment_operations_result_state_valid",
      sql`result_state in ('requested', 'provisioning', 'running', 'paused', 'releasing', 'released', 'failed', 'unknown')`,
    )
    .addCheckConstraint(
      "development_environment_operations_request_sha_valid",
      sql`request_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("development_environment_operations").execute();
  await db.schema.dropTable("development_environments").execute();
}
