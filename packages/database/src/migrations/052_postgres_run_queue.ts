import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`alter table sandbox_domains add column assigned_workspaces bigint not null default 0`.execute(
    db,
  );
  await sql`alter table sandbox_domains add constraint sandbox_domains_assigned_workspaces_valid check (assigned_workspaces >= 0)`.execute(
    db,
  );
  await sql`alter table workspaces add column sandbox_domain_id varchar(64)`.execute(db);
  await sql`
    update workspaces as workspace
       set sandbox_domain_id = cell.sandbox_domain_id
      from execution_cells as cell
     where cell.id = workspace.cell_id
  `.execute(db);
  await sql`alter table workspaces alter column sandbox_domain_id set not null`.execute(db);
  await sql`
    alter table workspaces
      add constraint workspaces_sandbox_domain_fk
      foreign key (sandbox_domain_id) references sandbox_domains(id)
  `.execute(db);
  await sql`create index workspaces_sandbox_domain_idx on workspaces(sandbox_domain_id)`.execute(
    db,
  );
  await sql`
    update sandbox_domains as domain
       set assigned_workspaces = (
         select count(*) from workspaces where sandbox_domain_id = domain.id
       )
  `.execute(db);

  await sql`drop table workspace_cell_migrations`.execute(db);
  await sql`drop index workspaces_cell_id_idx`.execute(db);
  await sql`alter table workspaces drop constraint workspaces_execution_cell_fk`.execute(db);
  await sql`alter table workspaces drop column cell_id`.execute(db);
  await sql`drop index execution_cells_sandbox_domain_idx`.execute(db);
  await sql`drop table execution_cells`.execute(db);
  await sql`alter table outbox drop column temporal_handed_off_at`.execute(db);
  // Kafka offsets are coordinates inside one physical log epoch. The runtime
  // simplification is a destructive event-plane cutover, so old projector
  // coordinates must never be compared with a rebuilt or truncated topic.
  await sql`delete from worker_event_projection_offsets`.execute(db);

  await db.schema
    .createIndex("outbox_run_queue_ready")
    .on("outbox")
    .columns(["topic", "available_at", "created_at"])
    .where(sql<boolean>`published_at is null`)
    .execute();

  await sql`
    create or replace function agent_dock_notify_run_queue()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_notify('agent_dock_run_queue', new.id::text);
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    create trigger outbox_notify_run_queue
    after insert on outbox
    for each row
    when (new.topic in ('agent-dock.turn.command.v1', 'agent-dock.turn.cancellation.v1'))
    execute function agent_dock_notify_run_queue()
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  void db;
  throw new Error(
    "052_postgres_run_queue is an intentional destructive cutover; restore a pre-migration backup to roll back",
  );
}
