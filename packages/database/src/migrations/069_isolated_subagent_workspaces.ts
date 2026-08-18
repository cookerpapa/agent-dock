import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspaces")
    .addColumn("workspace_kind", "text", (column) => column.notNull().defaultTo("user"))
    .addColumn("parent_workspace_id", "uuid")
    .execute();
  await sql`
    alter table workspaces
      add constraint workspaces_kind_valid
        check (workspace_kind in ('user', 'subagent_isolated')),
      add constraint workspaces_parent_shape
        check ((workspace_kind = 'user' and parent_workspace_id is null)
          or (workspace_kind = 'subagent_isolated' and parent_workspace_id is not null and parent_workspace_id <> id)),
      add constraint workspaces_parent_fk
        foreign key (tenant_id, parent_workspace_id) references workspaces (tenant_id, id)
  `.execute(db);
  await db.schema
    .createIndex("workspaces_internal_parent_idx")
    .on("workspaces")
    .columns(["tenant_id", "parent_workspace_id", "created_at"])
    .where(sql<boolean>`workspace_kind = 'subagent_isolated'`)
    .execute();

  await sql`
    alter table subagent_executions
      drop constraint subagent_executions_state_valid,
      drop constraint subagent_executions_settlement_shape,
      add column child_workspace_id uuid,
      add constraint subagent_executions_state_valid
        check (state in ('preparing', 'queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
      add constraint subagent_executions_settlement_shape
        check ((state in ('completed', 'failed', 'cancelled', 'unknown') and settled_at is not null)
          or (state in ('preparing', 'queued', 'running') and settled_at is null)),
      add constraint subagent_executions_workspace_shape
        check ((workspace_mode = 'isolated' and child_workspace_id is not null)
          or (workspace_mode <> 'isolated' and child_workspace_id is null)),
      add constraint subagent_executions_child_workspace_fk
        foreign key (tenant_id, child_workspace_id) references workspaces (tenant_id, id)
  `.execute(db);
  await db.schema
    .createIndex("subagent_executions_preparing_idx")
    .on("subagent_executions")
    .columns(["tenant_id", "state", "created_at"])
    .where(sql<boolean>`state = 'preparing'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("subagent_executions_preparing_idx").execute();
  await sql`
    alter table subagent_executions
      drop constraint subagent_executions_child_workspace_fk,
      drop constraint subagent_executions_workspace_shape,
      drop constraint subagent_executions_state_valid,
      drop constraint subagent_executions_settlement_shape,
      drop column child_workspace_id,
      add constraint subagent_executions_state_valid
        check (state in ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
      add constraint subagent_executions_settlement_shape
        check ((state in ('completed', 'failed', 'cancelled', 'unknown') and settled_at is not null)
          or (state in ('queued', 'running') and settled_at is null))
  `.execute(db);
  await db.schema.dropIndex("workspaces_internal_parent_idx").execute();
  await sql`
    alter table workspaces
      drop constraint workspaces_parent_fk,
      drop constraint workspaces_parent_shape,
      drop constraint workspaces_kind_valid,
      drop column parent_workspace_id,
      drop column workspace_kind
  `.execute(db);
}
