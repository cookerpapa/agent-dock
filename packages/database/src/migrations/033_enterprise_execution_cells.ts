import { sql, type Kysely } from "kysely";

const INITIAL_CELL_ID = "cell-0001";
const INITIAL_TASK_QUEUE = "pi-cloud-pi-runs-cell-0001-v1";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("execution_cells")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("display_name", "varchar(128)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("temporal_task_queue", "varchar(255)", (column) => column.notNull().unique())
    .addColumn("sandbox_manager_base_url", "varchar(2048)", (column) => column.notNull().unique())
    .addColumn("workspace_storage_key", "varchar(128)", (column) => column.notNull())
    .addColumn("capacity_weight", "integer", (column) => column.notNull().defaultTo(100))
    .addColumn("assigned_workspaces", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "execution_cells_id_valid",
      sql`id ~ '^cell-[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$'`,
    )
    .addCheckConstraint(
      "execution_cells_state_valid",
      sql`state in ('active', 'draining', 'disabled')`,
    )
    .addCheckConstraint(
      "execution_cells_capacity_weight_valid",
      sql`capacity_weight between 1 and 1000000`,
    )
    .addCheckConstraint("execution_cells_assigned_workspaces_valid", sql`assigned_workspaces >= 0`)
    .execute();

  await sql`
    insert into execution_cells (
      id,
      display_name,
      state,
      temporal_task_queue,
      sandbox_manager_base_url,
      workspace_storage_key,
      capacity_weight,
      assigned_workspaces
    ) values (
      ${INITIAL_CELL_ID},
      'Initial execution cell',
      'active',
      ${INITIAL_TASK_QUEUE},
      'http://sandbox-manager:4300',
      'workspace-cell-0001',
      100,
      0
    )
  `.execute(db);

  await db.schema.alterTable("workspaces").addColumn("cell_id", "varchar(64)").execute();
  await sql`update workspaces set cell_id = ${INITIAL_CELL_ID}`.execute(db);
  await db.schema
    .alterTable("workspaces")
    .alterColumn("cell_id", (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable("workspaces")
    .addForeignKeyConstraint("workspaces_execution_cell_fk", ["cell_id"], "execution_cells", ["id"])
    .execute();
  await db.schema
    .createIndex("workspaces_cell_id_idx")
    .on("workspaces")
    .column("cell_id")
    .execute();
  await sql`
    update execution_cells
    set assigned_workspaces = (
      select count(*) from workspaces where workspaces.cell_id = execution_cells.id
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("workspaces_cell_id_idx").execute();
  await db.schema.alterTable("workspaces").dropConstraint("workspaces_execution_cell_fk").execute();
  await db.schema.alterTable("workspaces").dropColumn("cell_id").execute();
  await db.schema.dropTable("execution_cells").execute();
}
