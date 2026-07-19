import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sandboxes")
    .addUniqueConstraint("sandboxes_identity_unique", ["id", "supervisor_id", "boot_id"])
    .execute();

  await db.schema
    .createTable("supervisor_connections")
    .addColumn("connection_id", "uuid", (column) => column.primaryKey())
    .addColumn("transport_id", "uuid", (column) => column.notNull().unique())
    .addColumn("registration_message_id", "uuid", (column) => column.notNull().unique())
    .addColumn("registered_message_id", "uuid", (column) => column.notNull().unique())
    .addColumn("sandbox_id", "uuid", (column) => column.notNull())
    .addColumn("supervisor_id", "text", (column) => column.notNull())
    .addColumn("boot_id", "uuid", (column) => column.notNull())
    .addColumn("control_plane_instance_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("active"))
    .addColumn("close_reason", "text")
    .addColumn("registration_fingerprint", "char(64)", (column) => column.notNull())
    .addColumn("supervisor_version", "text", (column) => column.notNull())
    .addColumn("pi_package_name", "text", (column) => column.notNull())
    .addColumn("pi_version", "text", (column) => column.notNull())
    .addColumn("supported_protocol_versions", sql`integer[]`, (column) => column.notNull())
    .addColumn("capabilities", sql`text[]`, (column) => column.notNull())
    .addColumn("selected_protocol_version", "integer", (column) => column.notNull())
    .addColumn("heartbeat_interval_ms", "integer", (column) => column.notNull())
    .addColumn("heartbeat_timeout_ms", "integer", (column) => column.notNull())
    .addColumn("accepting_assignments", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("registered_at", "timestamptz", (column) => column.notNull())
    .addColumn("last_heartbeat_at", "timestamptz", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("closed_at", "timestamptz")
    .addForeignKeyConstraint(
      "supervisor_connections_sandbox_identity_fk",
      ["sandbox_id", "supervisor_id", "boot_id"],
      "sandboxes",
      ["id", "supervisor_id", "boot_id"],
    )
    .addCheckConstraint(
      "supervisor_connections_state_valid",
      sql`state in ('active', 'superseded', 'fenced')`,
    )
    .addCheckConstraint(
      "supervisor_connections_close_valid",
      sql`(
        state = 'active'
        and close_reason is null
        and closed_at is null
      ) or (
        state = 'superseded'
        and close_reason = 'reconnected'
        and closed_at is not null
      ) or (
        state = 'fenced'
        and close_reason in ('heartbeat_timeout', 'new_boot')
        and closed_at is not null
      )`,
    )
    .addCheckConstraint(
      "supervisor_connections_registration_fingerprint_valid",
      sql`registration_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "supervisor_connections_runtime_identity_nonempty",
      sql`char_length(supervisor_id) between 1 and 256
          and char_length(supervisor_version) between 1 and 128
          and char_length(pi_package_name) between 1 and 256
          and char_length(pi_version) between 1 and 128`,
    )
    .addCheckConstraint(
      "supervisor_connections_protocol_valid",
      sql`selected_protocol_version = 1
          and selected_protocol_version = any(supported_protocol_versions)
          and cardinality(supported_protocol_versions) between 1 and 16
          and cardinality(capabilities) between 0 and 256`,
    )
    .addCheckConstraint(
      "supervisor_connections_heartbeat_policy_valid",
      sql`heartbeat_interval_ms > 0
          and heartbeat_timeout_ms > heartbeat_interval_ms
          and expires_at > last_heartbeat_at`,
    )
    .execute();

  await db.schema
    .createIndex("supervisor_connections_one_active_per_sandbox")
    .unique()
    .on("supervisor_connections")
    .column("sandbox_id")
    .where(sql<boolean>`state = 'active'`)
    .execute();
  await db.schema
    .createIndex("supervisor_connections_expiry")
    .on("supervisor_connections")
    .columns(["expires_at", "connection_id"])
    .where(sql<boolean>`state = 'active'`)
    .execute();

  await db.schema
    .createTable("sandbox_retirements")
    .addColumn("sandbox_id", "uuid", (column) => column.primaryKey())
    .addColumn("supervisor_id", "text", (column) => column.notNull())
    .addColumn("boot_id", "uuid", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("available_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("claim_id", "uuid")
    .addColumn("claim_owner_id", "uuid")
    .addColumn("claim_until", "timestamptz")
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .addForeignKeyConstraint(
      "sandbox_retirements_sandbox_identity_fk",
      ["sandbox_id", "supervisor_id", "boot_id"],
      "sandboxes",
      ["id", "supervisor_id", "boot_id"],
    )
    .addCheckConstraint(
      "sandbox_retirements_reason_valid",
      sql`reason in ('heartbeat_timeout', 'new_boot')`,
    )
    .addCheckConstraint("sandbox_retirements_attempts_valid", sql`attempts >= 0`)
    .addCheckConstraint(
      "sandbox_retirements_state_valid",
      sql`(
        state = 'pending'
        and claim_id is null
        and claim_owner_id is null
        and claim_until is null
        and completed_at is null
      ) or (
        state = 'claimed'
        and claim_id is not null
        and claim_owner_id is not null
        and claim_until is not null
        and completed_at is null
      ) or (
        state = 'blocked'
        and claim_id is null
        and claim_owner_id is null
        and claim_until is null
        and last_error is not null
        and completed_at is null
      ) or (
        state = 'completed'
        and claim_id is null
        and claim_owner_id is null
        and claim_until is null
        and completed_at is not null
      )`,
    )
    .execute();

  await db.schema
    .createIndex("sandbox_retirements_available")
    .on("sandbox_retirements")
    .columns(["state", "available_at", "claim_until", "created_at"])
    .where(sql<boolean>`state in ('pending', 'claimed')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sandbox_retirements").execute();
  await db.schema.dropTable("supervisor_connections").execute();
  await db.schema.alterTable("sandboxes").dropConstraint("sandboxes_identity_unique").execute();
}
