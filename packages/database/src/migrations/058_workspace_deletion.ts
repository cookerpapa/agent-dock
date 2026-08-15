import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").addColumn("deleted_at", "timestamptz").execute();
  await db.schema.alterTable("projects").dropConstraint("projects_tenant_name_unique").execute();
  await sql`
    create unique index projects_tenant_live_name_unique
      on projects(tenant_id, name)
      where deleted_at is null
  `.execute(db);
  await db.schema
    .alterTable("workspaces")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("storage_purged_at", "timestamptz")
    .execute();
  await sql`
    alter table workspaces
      add constraint workspaces_storage_purge_shape
      check (storage_purged_at is null or deleted_at is not null)
  `.execute(db);
  await sql`
    create index workspaces_pending_storage_purge_idx
      on workspaces(deleted_at, id)
      where deleted_at is not null and storage_purged_at is null
  `.execute(db);
  await sql`
    create table workspace_delete_operations (
      operation_id uuid primary key,
      tenant_id uuid not null,
      workspace_id uuid not null,
      idempotency_key text not null,
      deleted_at timestamptz not null,
      created_at timestamptz not null default now(),
      foreign key (tenant_id, workspace_id)
        references workspaces(tenant_id, id),
      constraint workspace_delete_operations_key_valid
        check (char_length(idempotency_key) between 1 and 256),
      constraint workspace_delete_operations_scope_key_unique
        unique (tenant_id, workspace_id, idempotency_key)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table workspace_delete_operations`.execute(db);
  await sql`drop index workspaces_pending_storage_purge_idx`.execute(db);
  await db.schema
    .alterTable("workspaces")
    .dropConstraint("workspaces_storage_purge_shape")
    .execute();
  await db.schema
    .alterTable("workspaces")
    .dropColumn("storage_purged_at")
    .dropColumn("deleted_at")
    .execute();
  await sql`drop index projects_tenant_live_name_unique`.execute(db);
  await db.schema
    .alterTable("projects")
    .addUniqueConstraint("projects_tenant_name_unique", ["tenant_id", "name"])
    .execute();
  await db.schema.alterTable("projects").dropColumn("deleted_at").execute();
}
