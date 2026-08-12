import { sql, type Kysely } from "kysely";

const INITIAL_DOMAIN_ID = "sandbox-domain-0001";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sandbox_domains")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("display_name", "varchar(128)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("tool_broker_base_url", "varchar(2048)", (column) => column.notNull().unique())
    .addColumn("workspace_storage_key", "varchar(128)", (column) => column.notNull())
    .addColumn("maximum_active_sandboxes", "integer", (column) => column.notNull().defaultTo(1024))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "sandbox_domains_id_valid",
      sql`id ~ '^sandbox-domain-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'`,
    )
    .addCheckConstraint(
      "sandbox_domains_state_valid",
      sql`state in ('active', 'draining', 'disabled')`,
    )
    .addCheckConstraint(
      "sandbox_domains_capacity_valid",
      sql`maximum_active_sandboxes between 1 and 1000000`,
    )
    .execute();

  await sql`
    insert into sandbox_domains (
      id, display_name, state, tool_broker_base_url, workspace_storage_key,
      maximum_active_sandboxes
    )
    select ${INITIAL_DOMAIN_ID}, 'Primary sandbox domain', 'active',
           'http://tool-broker:4300', 'workspace-domain-0001', 1024
      from execution_cells
     order by id
     limit 1
  `.execute(db);

  await db.schema
    .alterTable("execution_cells")
    .addColumn("sandbox_domain_id", "varchar(64)")
    .execute();
  await sql`
    update execution_cells set sandbox_domain_id = ${INITIAL_DOMAIN_ID}
  `.execute(db);
  await db.schema
    .alterTable("execution_cells")
    .alterColumn("sandbox_domain_id", (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable("execution_cells")
    .addForeignKeyConstraint(
      "execution_cells_sandbox_domain_fk",
      ["sandbox_domain_id"],
      "sandbox_domains",
      ["id"],
    )
    .execute();
  await db.schema
    .createIndex("execution_cells_sandbox_domain_idx")
    .on("execution_cells")
    .column("sandbox_domain_id")
    .execute();

  await sql`alter table sandbox_manager_instances drop constraint sandbox_manager_instances_cell_id_fkey`.execute(
    db,
  );
  await sql`alter table sandbox_manager_activations drop constraint sandbox_manager_activations_cell_id_fkey`.execute(
    db,
  );
  await sql`alter table sandbox_manager_instances rename to tool_broker_instances`.execute(db);
  await sql`alter table sandbox_manager_activations rename to tool_broker_activations`.execute(db);
  await sql`alter table sandbox_manager_operations rename to tool_broker_operations`.execute(db);
  await sql`alter table tool_broker_instances rename column cell_id to sandbox_domain_id`.execute(
    db,
  );
  await sql`alter table tool_broker_activations rename column cell_id to sandbox_domain_id`.execute(
    db,
  );
  await sql`update tool_broker_instances set sandbox_domain_id = ${INITIAL_DOMAIN_ID}`.execute(db);
  await sql`update tool_broker_activations set sandbox_domain_id = ${INITIAL_DOMAIN_ID}`.execute(
    db,
  );
  await sql`
    alter table tool_broker_instances
      add constraint tool_broker_instances_sandbox_domain_fk
      foreign key (sandbox_domain_id) references sandbox_domains(id)
  `.execute(db);
  await sql`
    alter table tool_broker_activations
      add constraint tool_broker_activations_sandbox_domain_fk
      foreign key (sandbox_domain_id) references sandbox_domains(id)
  `.execute(db);
  await sql`alter index sandbox_manager_ready_owner_url_unique rename to tool_broker_ready_owner_url_unique`.execute(
    db,
  );
  await sql`alter index sandbox_manager_workspace_live_unique rename to tool_broker_workspace_live_unique`.execute(
    db,
  );
  await sql`alter index sandbox_manager_activation_owner_idx rename to tool_broker_activation_owner_idx`.execute(
    db,
  );
  await sql`alter index sandbox_manager_operation_activation_idx rename to tool_broker_operation_activation_idx`.execute(
    db,
  );

  await db.schema.alterTable("execution_cells").dropColumn("sandbox_manager_base_url").execute();
  await db.schema.alterTable("execution_cells").dropColumn("workspace_storage_key").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("execution_cells")
    .addColumn("sandbox_manager_base_url", "varchar(2048)")
    .execute();
  await db.schema
    .alterTable("execution_cells")
    .addColumn("workspace_storage_key", "varchar(128)")
    .execute();
  await sql`
    update execution_cells as cell
       set sandbox_manager_base_url = domain.tool_broker_base_url,
           workspace_storage_key = domain.workspace_storage_key
      from sandbox_domains as domain
     where domain.id = cell.sandbox_domain_id
  `.execute(db);
  await sql`alter table execution_cells alter column sandbox_manager_base_url set not null`.execute(
    db,
  );
  await sql`alter table execution_cells alter column workspace_storage_key set not null`.execute(
    db,
  );
  await sql`alter table tool_broker_instances drop constraint tool_broker_instances_sandbox_domain_fk`.execute(
    db,
  );
  await sql`alter table tool_broker_activations drop constraint tool_broker_activations_sandbox_domain_fk`.execute(
    db,
  );
  await sql`alter table tool_broker_instances rename column sandbox_domain_id to cell_id`.execute(
    db,
  );
  await sql`alter table tool_broker_activations rename column sandbox_domain_id to cell_id`.execute(
    db,
  );
  await sql`update tool_broker_instances set cell_id = (select id from execution_cells order by id limit 1)`.execute(
    db,
  );
  await sql`update tool_broker_activations set cell_id = (select id from execution_cells order by id limit 1)`.execute(
    db,
  );
  await sql`
    alter table tool_broker_instances add constraint sandbox_manager_instances_cell_id_fkey
      foreign key (cell_id) references execution_cells(id)
  `.execute(db);
  await sql`
    alter table tool_broker_activations add constraint sandbox_manager_activations_cell_id_fkey
      foreign key (cell_id) references execution_cells(id)
  `.execute(db);
  await sql`alter table tool_broker_instances rename to sandbox_manager_instances`.execute(db);
  await sql`alter table tool_broker_activations rename to sandbox_manager_activations`.execute(db);
  await sql`alter table tool_broker_operations rename to sandbox_manager_operations`.execute(db);
  await sql`alter index tool_broker_ready_owner_url_unique rename to sandbox_manager_ready_owner_url_unique`.execute(
    db,
  );
  await sql`alter index tool_broker_workspace_live_unique rename to sandbox_manager_workspace_live_unique`.execute(
    db,
  );
  await sql`alter index tool_broker_activation_owner_idx rename to sandbox_manager_activation_owner_idx`.execute(
    db,
  );
  await sql`alter index tool_broker_operation_activation_idx rename to sandbox_manager_operation_activation_idx`.execute(
    db,
  );
  await db.schema.dropIndex("execution_cells_sandbox_domain_idx").execute();
  await db.schema
    .alterTable("execution_cells")
    .dropConstraint("execution_cells_sandbox_domain_fk")
    .execute();
  await db.schema.alterTable("execution_cells").dropColumn("sandbox_domain_id").execute();
  await db.schema.dropTable("sandbox_domains").execute();
}
