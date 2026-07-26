import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("worker_affinity_sandbox_id", "uuid")
    .addColumn("worker_affinity_expires_at", "timestamptz")
    .execute();

  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_worker_affinity_sandbox_fk",
      ["worker_affinity_sandbox_id"],
      "sandboxes",
      ["id"],
    )
    .execute();

  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_worker_affinity_complete",
      sql`(worker_affinity_sandbox_id is null) = (worker_affinity_expires_at is null)`,
    )
    .execute();

  await db.schema
    .createTable("temporal_worker_affinity_reservations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("command_id", "uuid", (column) => column.notNull().unique())
    .addColumn("sandbox_id", "uuid", (column) => column.notNull())
    .addColumn("task_queue", "text", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "temporal_affinity_reservations_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "temporal_affinity_reservations_command_fk",
      ["command_id"],
      "commands",
      ["id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "temporal_affinity_reservations_sandbox_fk",
      ["sandbox_id"],
      "sandboxes",
      ["id"],
    )
    .addCheckConstraint(
      "temporal_affinity_reservations_queue_valid",
      sql`char_length(task_queue) between 1 and 255`,
    )
    .addCheckConstraint("temporal_affinity_reservations_expiry_valid", sql`expires_at > created_at`)
    .execute();

  await db.schema
    .createIndex("temporal_affinity_reservations_capacity")
    .on("temporal_worker_affinity_reservations")
    .columns(["sandbox_id", "expires_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
