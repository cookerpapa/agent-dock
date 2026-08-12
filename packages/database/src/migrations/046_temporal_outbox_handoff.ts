import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable("outbox").addColumn("temporal_handed_off_at", "timestamptz").execute();

  // A previously execution-published row was necessarily handed to the
  // scheduler. Rows still unpublished are deliberately replayed through the
  // deterministic Workflow ID so an interrupted migration cannot lose work.
  await sql`
    update outbox
       set temporal_handed_off_at = published_at
     where published_at is not null
  `.execute(db);

  await db.schema
    .createIndex("outbox_pending_temporal_handoff")
    .on("outbox")
    .columns(["created_at", "id"])
    .where(sql<boolean>`temporal_handed_off_at is null`)
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex("outbox_pending_temporal_handoff").execute();
  await db.schema.alterTable("outbox").dropColumn("temporal_handed_off_at").execute();
}
