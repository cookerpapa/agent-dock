import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspace_cell_migrations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("source_cell_id", "varchar(64)", (column) => column.notNull())
    .addColumn("target_cell_id", "varchar(64)", (column) => column.notNull())
    .addColumn("requested_by_user_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "varchar(255)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("workspace_version_id", "uuid")
    .addColumn("base_row_version", "bigint", (column) => column.notNull())
    .addColumn("result_row_version", "bigint")
    .addColumn("failure_code", "varchar(128)")
    .addColumn("requested_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("settled_at", "timestamptz")
    .addForeignKeyConstraint(
      "workspace_cell_migrations_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "workspace_cell_migrations_source_cell_fk",
      ["source_cell_id"],
      "execution_cells",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_cell_migrations_target_cell_fk",
      ["target_cell_id"],
      "execution_cells",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_cell_migrations_actor_fk",
      ["requested_by_user_id"],
      "users",
      ["id"],
    )
    .addForeignKeyConstraint(
      "workspace_cell_migrations_version_fk",
      ["workspace_version_id"],
      "workspace_versions",
      ["id"],
    )
    .addUniqueConstraint("workspace_cell_migrations_idempotency_unique", [
      "tenant_id",
      "idempotency_key",
    ])
    .addCheckConstraint(
      "workspace_cell_migrations_cells_distinct",
      sql`source_cell_id <> target_cell_id`,
    )
    .addCheckConstraint(
      "workspace_cell_migrations_state_valid",
      sql`state in ('requested', 'completed', 'failed')`,
    )
    .addCheckConstraint(
      "workspace_cell_migrations_versions_valid",
      sql`base_row_version >= 0 and (result_row_version is null or result_row_version > base_row_version)`,
    )
    .addCheckConstraint(
      "workspace_cell_migrations_settlement_valid",
      sql`(state = 'requested' and settled_at is null and result_row_version is null and failure_code is null)
          or (state = 'completed' and settled_at is not null and result_row_version is not null and failure_code is null)
          or (state = 'failed' and settled_at is not null and result_row_version is null and failure_code is not null)`,
    )
    .execute();
  await db.schema
    .createIndex("workspace_cell_migrations_workspace_idx")
    .on("workspace_cell_migrations")
    .columns(["tenant_id", "workspace_id", "requested_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("workspace_cell_migrations_workspace_idx").execute();
  await db.schema.dropTable("workspace_cell_migrations").execute();
}
