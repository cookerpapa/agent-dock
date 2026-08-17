import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

/**
 * Completes the AgentDock to Pi Cloud queue cutover for databases that had
 * already applied migration 052 before the source tree was renamed.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`drop trigger if exists outbox_notify_run_queue on outbox`.execute(db);
  await sql`drop function if exists agent_dock_notify_run_queue()`.execute(db);

  await sql`
    create or replace function pi_cloud_notify_run_queue()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_notify('pi_cloud_run_queue', new.id::text);
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    create trigger outbox_notify_run_queue
    after insert on outbox
    for each row
    when (new.topic in ('control.command.pending.v1', 'control.command.cancel.pending.v1'))
    execute function pi_cloud_notify_run_queue()
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  void db;
  throw new Error(
    "064_pi_cloud_run_queue_notification is an intentional identity cutover; restore a pre-migration backup to roll back",
  );
}
