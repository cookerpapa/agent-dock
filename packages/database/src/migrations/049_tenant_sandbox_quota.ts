import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addColumn("maximum_active_sandboxes", "integer", (column) => column.notNull().defaultTo(16))
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .addCheckConstraint(
      "tenant_runtime_policies_sandbox_limit_valid",
      sql`maximum_active_sandboxes between 1 and 1000000`,
    )
    .execute();
  await sql`
    create index tool_broker_activations_tenant_live_idx
      on tool_broker_activations (tenant_id, sandbox_domain_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown')
  `.execute(db);
  await db.schema.dropIndex("tool_broker_workspace_live_unique").execute();
  await sql`
    create unique index tool_broker_workspace_live_unique
      on tool_broker_activations (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("tool_broker_workspace_live_unique").execute();
  await sql`
    create unique index tool_broker_workspace_live_unique
      on tool_broker_activations (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning')
  `.execute(db);
  await db.schema.dropIndex("tool_broker_activations_tenant_live_idx").execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropConstraint("tenant_runtime_policies_sandbox_limit_valid")
    .execute();
  await db.schema
    .alterTable("tenant_runtime_policies")
    .dropColumn("maximum_active_sandboxes")
    .execute();
}
