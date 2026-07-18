import { sql, type Kysely } from "kysely";

const thinkingLevels = sql`array['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']::text[]`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tenants")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("slug", "text", (column) => column.notNull().unique())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("tenants_slug_nonempty", sql`char_length(slug) between 1 and 256`)
    .execute();

  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("display_name", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("users_tenant_id_id_unique", ["tenant_id", "id"])
    .addCheckConstraint(
      "users_display_name_nonempty",
      sql`char_length(display_name) between 1 and 256`,
    )
    .execute();

  await db.schema
    .createTable("projects")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("projects_tenant_id_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("projects_tenant_name_unique", ["tenant_id", "name"])
    .addCheckConstraint("projects_name_nonempty", sql`char_length(name) between 1 and 256`)
    .execute();

  await db.schema
    .createTable("workspaces")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("object_snapshot_key", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("workspaces_tenant_id_id_unique", ["tenant_id", "id"])
    .addForeignKeyConstraint(
      "workspaces_tenant_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .execute();

  await db.schema
    .createTable("credential_bindings")
    .addColumn("id", "uuid", (column) => column.notNull())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("secret_ref", "text", (column) => column.notNull())
    .addColumn("version", "bigint", (column) => column.notNull().defaultTo(1))
    .addColumn("status", "text", (column) => column.notNull().defaultTo("active"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("credential_bindings_tenant_id_id_version_pk", [
      "tenant_id",
      "id",
      "version",
    ])
    .addCheckConstraint(
      "credential_bindings_provider_nonempty",
      sql`char_length(provider) between 1 and 256`,
    )
    .addCheckConstraint(
      "credential_bindings_secret_ref_nonempty",
      sql`char_length(secret_ref) between 1 and 1024`,
    )
    .addCheckConstraint("credential_bindings_version_positive", sql`version > 0`)
    .addCheckConstraint(
      "credential_bindings_kind_valid",
      sql`kind in ('oauth', 'api_key', 'brokered')`,
    )
    .addCheckConstraint(
      "credential_bindings_status_valid",
      sql`status in ('active', 'disabled', 'revoked')`,
    )
    .execute();

  await db.schema
    .createTable("model_profiles")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("default_thinking_level", "text", (column) => column.notNull())
    .addColumn("allowed_thinking_levels", sql`text[]`, (column) => column.notNull())
    .addColumn("credential_binding_id", "uuid", (column) => column.notNull())
    .addColumn("credential_binding_version", "bigint", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("model_profiles_tenant_id_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("model_profiles_tenant_name_unique", ["tenant_id", "name"])
    .addForeignKeyConstraint(
      "model_profiles_credential_binding_fk",
      ["tenant_id", "credential_binding_id", "credential_binding_version"],
      "credential_bindings",
      ["tenant_id", "id", "version"],
    )
    .addCheckConstraint("model_profiles_name_nonempty", sql`char_length(name) between 1 and 256`)
    .addCheckConstraint(
      "model_profiles_provider_nonempty",
      sql`char_length(provider) between 1 and 256`,
    )
    .addCheckConstraint(
      "model_profiles_model_id_nonempty",
      sql`char_length(model_id) between 1 and 256`,
    )
    .addCheckConstraint(
      "model_profiles_thinking_levels_valid",
      sql`cardinality(allowed_thinking_levels) > 0
          and allowed_thinking_levels <@ ${thinkingLevels}
          and default_thinking_level = any(allowed_thinking_levels)`,
    )
    .execute();

  await db.schema
    .createTable("sessions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("desired_model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("cold"))
    .addColumn("pi_session_snapshot_key", "text")
    .addColumn("workspace_snapshot_key", "text")
    .addColumn("next_event_seq", "bigint", (column) => column.notNull().defaultTo(1))
    .addColumn("last_fencing_token", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("row_version", "bigint", (column) => column.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("last_active_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("sessions_tenant_id_id_unique", ["tenant_id", "id"])
    .addForeignKeyConstraint(
      "sessions_tenant_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "sessions_tenant_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "sessions_tenant_model_profile_fk",
      ["tenant_id", "desired_model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "sessions_state_valid",
      sql`state in ('cold', 'starting', 'idle', 'running', 'waiting_approval', 'cancelling', 'failed', 'recovering', 'evicting')`,
    )
    .addCheckConstraint("sessions_next_event_seq_positive", sql`next_event_seq > 0`)
    .addCheckConstraint("sessions_fencing_token_nonnegative", sql`last_fencing_token >= 0`)
    .addCheckConstraint("sessions_row_version_positive", sql`row_version > 0`)
    .execute();

  await db.schema
    .createTable("turns")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("queued"))
    .addColumn("input_kind", "text", (column) => column.notNull())
    .addColumn("input_text", "text")
    .addColumn("model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("thinking_level", "text", (column) => column.notNull())
    .addColumn("credential_binding_id", "uuid", (column) => column.notNull())
    .addColumn("credential_binding_version", "bigint", (column) => column.notNull())
    .addColumn("stop_reason", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_message", "text")
    .addColumn("failure_retryable", "boolean")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("turns_tenant_session_id_unique", ["tenant_id", "session_id", "id"])
    .addUniqueConstraint("turns_session_id_id_unique", ["session_id", "id"])
    .addForeignKeyConstraint("turns_tenant_session_fk", ["tenant_id", "session_id"], "sessions", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "turns_tenant_model_profile_fk",
      ["tenant_id", "model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "turns_credential_binding_snapshot_fk",
      ["tenant_id", "credential_binding_id", "credential_binding_version"],
      "credential_bindings",
      ["tenant_id", "id", "version"],
    )
    .addCheckConstraint(
      "turns_state_valid",
      sql`state in ('queued', 'dispatching', 'running', 'waiting_approval', 'cancelling', 'completed', 'failed', 'cancelled')`,
    )
    .addCheckConstraint(
      "turns_input_valid",
      sql`(input_kind = 'prompt' and input_text is not null and char_length(input_text) > 0)
          or (input_kind = 'continue' and input_text is null)`,
    )
    .addCheckConstraint("turns_thinking_level_valid", sql`thinking_level = any(${thinkingLevels})`)
    .addCheckConstraint(
      "turns_credential_binding_version_positive",
      sql`credential_binding_version > 0`,
    )
    .addCheckConstraint(
      "turns_settled_at_matches_state",
      sql`(state in ('completed', 'failed', 'cancelled') and settled_at is not null)
          or (state not in ('completed', 'failed', 'cancelled') and settled_at is null)`,
    )
    .addCheckConstraint(
      "turns_failure_fields_match_state",
      sql`(state = 'failed' and failure_code is not null and failure_retryable is not null)
          or (state <> 'failed' and failure_code is null and failure_message is null and failure_retryable is null)`,
    )
    .execute();

  await db.schema
    .createIndex("turns_one_active_per_session")
    .unique()
    .on("turns")
    .column("session_id")
    .where(sql<boolean>`state in ('dispatching', 'running', 'waiting_approval', 'cancelling')`)
    .execute();

  await db.schema
    .createIndex("turns_queued_mailbox_order")
    .on("turns")
    .columns(["session_id", "created_at", "id"])
    .where(sql<boolean>`state = 'queued'`)
    .execute();

  await db.schema
    .createTable("agent_nodes")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("parent_agent_node_id", "uuid")
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("depth", "integer", (column) => column.notNull())
    .addColumn("model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("thinking_level", "text", (column) => column.notNull())
    .addColumn("credential_binding_id", "uuid", (column) => column.notNull())
    .addColumn("credential_binding_version", "bigint", (column) => column.notNull())
    .addColumn("token_budget", "bigint")
    .addColumn("wall_time_budget_ms", "bigint")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("settled_at", "timestamptz")
    .addUniqueConstraint("agent_nodes_tenant_session_id_unique", ["tenant_id", "session_id", "id"])
    .addUniqueConstraint("agent_nodes_session_id_id_unique", ["session_id", "id"])
    .addForeignKeyConstraint(
      "agent_nodes_tenant_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "agent_nodes_parent_in_session_fk",
      ["session_id", "parent_agent_node_id"],
      "agent_nodes",
      ["session_id", "id"],
    )
    .addForeignKeyConstraint(
      "agent_nodes_tenant_model_profile_fk",
      ["tenant_id", "model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "agent_nodes_credential_binding_snapshot_fk",
      ["tenant_id", "credential_binding_id", "credential_binding_version"],
      "credential_bindings",
      ["tenant_id", "id", "version"],
    )
    .addCheckConstraint(
      "agent_nodes_state_valid",
      sql`state in ('pending', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')`,
    )
    .addCheckConstraint("agent_nodes_depth_nonnegative", sql`depth >= 0`)
    .addCheckConstraint(
      "agent_nodes_thinking_level_valid",
      sql`thinking_level = any(${thinkingLevels})`,
    )
    .addCheckConstraint(
      "agent_nodes_credential_binding_version_positive",
      sql`credential_binding_version > 0`,
    )
    .addCheckConstraint(
      "agent_nodes_token_budget_positive",
      sql`token_budget is null or token_budget > 0`,
    )
    .addCheckConstraint(
      "agent_nodes_wall_time_budget_positive",
      sql`wall_time_budget_ms is null or wall_time_budget_ms > 0`,
    )
    .execute();

  await db.schema
    .createIndex("agent_nodes_one_root_per_session")
    .unique()
    .on("agent_nodes")
    .column("session_id")
    .where(sql<boolean>`parent_agent_node_id is null`)
    .execute();

  await db.schema
    .createTable("sandboxes")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("supervisor_id", "text", (column) => column.notNull())
    .addColumn("boot_id", "uuid", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("provisioning"))
    .addColumn("max_concurrent_sessions", "integer", (column) => column.notNull())
    .addColumn("active_sessions", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("terminated_at", "timestamptz")
    .addCheckConstraint(
      "sandboxes_state_valid",
      sql`state in ('provisioning', 'ready', 'leased', 'draining', 'failed', 'terminated')`,
    )
    .addCheckConstraint(
      "sandboxes_capacity_valid",
      sql`max_concurrent_sessions > 0 and active_sessions between 0 and max_concurrent_sessions`,
    )
    .addCheckConstraint(
      "sandboxes_terminated_at_matches_state",
      sql`(state = 'terminated' and terminated_at is not null)
          or (state <> 'terminated' and terminated_at is null)`,
    )
    .execute();

  await db.schema
    .createIndex("sandboxes_schedulable")
    .on("sandboxes")
    .columns(["state", "active_sessions", "created_at"])
    .where(sql<boolean>`state in ('ready', 'leased') and active_sessions < max_concurrent_sessions`)
    .execute();

  await db.schema
    .createTable("session_leases")
    .addColumn("session_id", "uuid", (column) => column.primaryKey().references("sessions.id"))
    .addColumn("lease_id", "uuid", (column) => column.notNull().unique())
    .addColumn("sandbox_id", "uuid", (column) => column.notNull().references("sandboxes.id"))
    .addColumn("fencing_token", "bigint", (column) => column.notNull())
    .addColumn("valid_until", "timestamptz", (column) => column.notNull())
    .addColumn("acquired_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("renewed_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("session_leases_fencing_token_positive", sql`fencing_token > 0`)
    .addCheckConstraint("session_leases_expiry_valid", sql`valid_until > acquired_at`)
    .execute();

  await db.schema
    .createIndex("session_leases_expiry")
    .on("session_leases")
    .column("valid_until")
    .execute();

  await db.schema
    .createTable("commands")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("dispatched_at", "timestamptz")
    .addColumn("acknowledged_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("failure_code", "text")
    .addUniqueConstraint("commands_session_idempotency_unique", ["session_id", "idempotency_key"])
    .addForeignKeyConstraint(
      "commands_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "commands_idempotency_key_nonempty",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .addCheckConstraint(
      "commands_kind_valid",
      sql`kind in ('turn.execute', 'turn.cancel', 'approval.resolve')`,
    )
    .addCheckConstraint(
      "commands_state_valid",
      sql`state in ('pending', 'dispatched', 'acknowledged', 'completed', 'failed')`,
    )
    .execute();

  await db.schema
    .createIndex("commands_pending_mailbox")
    .on("commands")
    .columns(["session_id", "created_at", "id"])
    .where(sql<boolean>`state = 'pending'`)
    .execute();

  await db.schema
    .createTable("approvals")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
    .addColumn("request_payload", "jsonb", (column) => column.notNull())
    .addColumn("outcome", "text")
    .addColumn("resolved_value", "text")
    .addColumn("requested_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("resolved_at", "timestamptz")
    .addForeignKeyConstraint(
      "approvals_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "approvals_kind_valid",
      sql`kind in ('confirm', 'select', 'input', 'editor')`,
    )
    .addCheckConstraint(
      "approvals_resolution_matches_state",
      sql`(state = 'pending' and outcome is null and resolved_at is null)
          or (state = 'resolved' and outcome in ('approved', 'rejected') and resolved_at is not null)
          or (state = 'expired' and outcome is null and resolved_at is not null)
          or (state = 'cancelled' and outcome = 'cancelled' and resolved_at is not null)`,
    )
    .addCheckConstraint(
      "approvals_expiry_valid",
      sql`expires_at is null or expires_at > requested_at`,
    )
    .execute();

  await db.schema
    .createIndex("approvals_pending_by_turn")
    .on("approvals")
    .columns(["turn_id", "requested_at"])
    .where(sql<boolean>`state = 'pending'`)
    .execute();

  await db.schema
    .createTable("session_events")
    .addColumn("event_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid")
    .addColumn("agent_node_id", "uuid")
    .addColumn("seq", "bigint", (column) => column.notNull())
    .addColumn("schema_version", "integer", (column) => column.notNull())
    .addColumn("type", "text", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("lease_id", "uuid", (column) => column.notNull())
    .addColumn("fencing_token", "bigint", (column) => column.notNull())
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull())
    .addColumn("persisted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("session_events_session_seq_unique", ["session_id", "seq"])
    .addForeignKeyConstraint(
      "session_events_tenant_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "session_events_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addForeignKeyConstraint(
      "session_events_tenant_agent_node_fk",
      ["tenant_id", "session_id", "agent_node_id"],
      "agent_nodes",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint("session_events_seq_positive", sql`seq > 0`)
    .addCheckConstraint("session_events_schema_version_positive", sql`schema_version > 0`)
    .addCheckConstraint("session_events_type_nonempty", sql`char_length(type) between 1 and 256`)
    .addCheckConstraint("session_events_fencing_token_positive", sql`fencing_token > 0`)
    .execute();

  await db.schema
    .createTable("session_event_cursors")
    .addColumn("session_id", "uuid", (column) => column.primaryKey().references("sessions.id"))
    .addColumn("last_persisted_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("acknowledged_through_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "session_event_cursors_bounds_valid",
      sql`last_persisted_seq >= 0
          and acknowledged_through_seq >= 0
          and acknowledged_through_seq <= last_persisted_seq`,
    )
    .execute();

  await db.schema
    .createTable("outbox")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("aggregate_type", "text", (column) => column.notNull())
    .addColumn("aggregate_id", "uuid", (column) => column.notNull())
    .addColumn("topic", "text", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("available_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("published_at", "timestamptz")
    .addColumn("last_error", "text")
    .addCheckConstraint("outbox_attempts_nonnegative", sql`attempts >= 0`)
    .addCheckConstraint("outbox_topic_nonempty", sql`char_length(topic) between 1 and 256`)
    .execute();

  await db.schema
    .createIndex("outbox_pending_delivery")
    .on("outbox")
    .columns(["available_at", "created_at", "id"])
    .where(sql<boolean>`published_at is null`)
    .execute();

  await db.schema
    .createTable("artifacts")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid")
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("object_key", "text", (column) => column.notNull().unique())
    .addColumn("sha256", "text", (column) => column.notNull())
    .addColumn("size_bytes", "bigint", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "artifacts_tenant_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "artifacts_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "artifacts_kind_valid",
      sql`kind in ('pi_session_snapshot', 'workspace_snapshot', 'tool_output', 'patch', 'report', 'crash_bundle')`,
    )
    .addCheckConstraint(
      "artifacts_object_key_nonempty",
      sql`char_length(object_key) between 1 and 2048`,
    )
    .addCheckConstraint("artifacts_sha256_valid", sql`sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("artifacts_size_nonnegative", sql`size_bytes >= 0`)
    .execute();

  await db.schema
    .createIndex("artifacts_by_session")
    .on("artifacts")
    .columns(["session_id", "created_at"])
    .execute();

  await db.schema
    .createTable("usage_ledger")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("provider", "text", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("input_tokens", "bigint", (column) => column.notNull())
    .addColumn("output_tokens", "bigint", (column) => column.notNull())
    .addColumn("cache_read_tokens", "bigint", (column) => column.notNull())
    .addColumn("cache_write_tokens", "bigint", (column) => column.notNull())
    .addColumn("cost_amount", "numeric(20, 8)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "usage_ledger_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addCheckConstraint(
      "usage_ledger_values_nonnegative",
      sql`input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
          and cache_write_tokens >= 0 and cost_amount >= 0`,
    )
    .execute();

  await db.schema
    .createIndex("usage_ledger_by_turn")
    .on("usage_ledger")
    .columns(["turn_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "usage_ledger",
    "artifacts",
    "outbox",
    "session_event_cursors",
    "session_events",
    "approvals",
    "commands",
    "session_leases",
    "sandboxes",
    "agent_nodes",
    "turns",
    "sessions",
    "model_profiles",
    "credential_bindings",
    "workspaces",
    "projects",
    "users",
    "tenants",
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
