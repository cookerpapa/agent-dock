import type { Kysely } from "kysely";
import { up as restoreTemporalWorkerAffinity } from "./023_temporal_worker_affinity.ts";

/**
 * Worker-private Temporal queues were a cache-locality optimization. The
 * shared Cell queue now owns capacity backpressure, so no affinity state is
 * authoritative or retained.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("temporal_worker_affinity_reservations").execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_worker_affinity_complete")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_worker_affinity_sandbox_fk")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropColumn("worker_affinity_expires_at")
    .dropColumn("worker_affinity_sandbox_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await restoreTemporalWorkerAffinity(db);
}
