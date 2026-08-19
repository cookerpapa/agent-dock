import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("subagent_executions")
    .addColumn("root_session_id", "uuid")
    .addColumn("root_run_id", "uuid")
    .addColumn("parent_execution_id", "uuid")
    .addColumn("depth", "integer")
    .execute();
  await sql`
    update subagent_executions
       set root_session_id = parent_session_id,
           root_run_id = parent_run_id,
           parent_execution_id = null,
           depth = 1
  `.execute(db);
  await sql`
    alter table subagent_executions
      alter column root_session_id set not null,
      alter column root_run_id set not null,
      alter column depth set not null,
      add constraint subagent_executions_root_session_fk
        foreign key (tenant_id, root_session_id)
        references sessions(tenant_id, id),
      add constraint subagent_executions_root_run_fk
        foreign key (tenant_id, root_run_id)
        references runs(tenant_id, id),
      add constraint subagent_executions_parent_execution_fk
        foreign key (tenant_id, parent_execution_id)
        references subagent_executions(tenant_id, id),
      add constraint subagent_executions_depth_valid
        check (depth between 1 and 64),
      add constraint subagent_executions_parent_depth_shape
        check ((depth = 1 and parent_execution_id is null)
            or (depth > 1 and parent_execution_id is not null))
  `.execute(db);
  await db.schema
    .createIndex("subagent_executions_root_tree_idx")
    .on("subagent_executions")
    .columns(["tenant_id", "root_run_id", "state", "depth", "created_at"])
    .execute();
  await db.schema
    .createIndex("subagent_executions_parent_execution_idx")
    .on("subagent_executions")
    .columns(["tenant_id", "parent_execution_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("subagent_executions_parent_execution_idx").execute();
  await db.schema.dropIndex("subagent_executions_root_tree_idx").execute();
  await sql`
    alter table subagent_executions
      drop constraint subagent_executions_parent_depth_shape,
      drop constraint subagent_executions_depth_valid,
      drop constraint subagent_executions_parent_execution_fk,
      drop constraint subagent_executions_root_run_fk,
      drop constraint subagent_executions_root_session_fk,
      drop column depth,
      drop column parent_execution_id,
      drop column root_run_id,
      drop column root_session_id
  `.execute(db);
}
