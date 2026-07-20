import { sql, type Kysely } from "kysely";

const runStates = sql`('queued', 'claimed', 'provisioning', 'restoring', 'running',
  'checkpointing', 'cancel_requested', 'completed', 'failed', 'cancelled',
  'timed_out', 'superseded')`;

const attemptStates = sql`('claimed', 'provisioning', 'restoring', 'running',
  'checkpointing', 'cancel_requested', 'completed', 'failed', 'cancelled',
  'timed_out', 'superseded')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("runs")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("turn_id", "uuid", (column) => column.notNull())
    .addColumn("command_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull().defaultTo("queued"))
    .addColumn("current_attempt_id", "uuid")
    .addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("stop_reason", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_message", "text")
    .addColumn("failure_retryable", "boolean")
    .addColumn("row_version", "bigint", (column) => column.notNull().defaultTo(1))
    .addColumn("queued_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("settled_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("runs_tenant_id_id_unique", ["tenant_id", "id"])
    .addUniqueConstraint("runs_tenant_turn_unique", ["tenant_id", "turn_id"])
    .addUniqueConstraint("runs_tenant_command_unique", ["tenant_id", "command_id"])
    .addUniqueConstraint("runs_session_idempotency_unique", ["session_id", "idempotency_key"])
    .addForeignKeyConstraint("runs_tenant_session_fk", ["tenant_id", "session_id"], "sessions", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "runs_tenant_turn_fk",
      ["tenant_id", "session_id", "turn_id"],
      "turns",
      ["tenant_id", "session_id", "id"],
    )
    .addForeignKeyConstraint(
      "runs_tenant_command_fk",
      ["tenant_id", "session_id", "turn_id", "command_id"],
      "commands",
      ["tenant_id", "session_id", "turn_id", "id"],
    )
    .addForeignKeyConstraint("runs_tenant_project_fk", ["tenant_id", "project_id"], "projects", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "runs_tenant_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
    )
    .addCheckConstraint("runs_state_valid", sql`state in ${runStates}`)
    .addCheckConstraint(
      "runs_idempotency_key_nonempty",
      sql`char_length(idempotency_key) between 1 and 256`,
    )
    .addCheckConstraint("runs_attempt_count_nonnegative", sql`attempt_count >= 0`)
    .addCheckConstraint("runs_row_version_positive", sql`row_version > 0`)
    .addCheckConstraint(
      "runs_settlement_shape",
      sql`(state in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
          or (state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)`,
    )
    .addCheckConstraint(
      "runs_failure_shape",
      sql`(state in ('failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
          or (state not in ('failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)`,
    )
    .execute();

  await db.schema
    .createTable("run_attempts")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_number", "integer", (column) => column.notNull())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("claim_owner_id", "text", (column) => column.notNull())
    .addColumn("claim_expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("sandbox_id", "uuid")
    .addColumn("lease_id", "uuid")
    .addColumn("fencing_token", "bigint")
    .addColumn("checkpoint_revision", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_message", "text")
    .addColumn("failure_retryable", "boolean")
    .addColumn("claimed_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("provisioning_at", "timestamptz")
    .addColumn("restoring_at", "timestamptz")
    .addColumn("running_at", "timestamptz")
    .addColumn("checkpointing_at", "timestamptz")
    .addColumn("last_heartbeat_at", "timestamptz")
    .addColumn("settled_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("run_attempts_run_number_unique", ["run_id", "attempt_number"])
    .addUniqueConstraint("run_attempts_run_id_unique", ["run_id", "id"])
    .addUniqueConstraint("run_attempts_tenant_run_id_unique", ["tenant_id", "run_id", "id"])
    .addForeignKeyConstraint("run_attempts_tenant_run_fk", ["tenant_id", "run_id"], "runs", [
      "tenant_id",
      "id",
    ])
    .addForeignKeyConstraint("run_attempts_sandbox_fk", ["sandbox_id"], "sandboxes", ["id"])
    .addCheckConstraint("run_attempts_state_valid", sql`state in ${attemptStates}`)
    .addCheckConstraint("run_attempts_number_positive", sql`attempt_number > 0`)
    .addCheckConstraint(
      "run_attempts_claim_owner_nonempty",
      sql`char_length(claim_owner_id) between 1 and 256`,
    )
    .addCheckConstraint("run_attempts_claim_expiry_valid", sql`claim_expires_at > claimed_at`)
    .addCheckConstraint(
      "run_attempts_assignment_shape",
      sql`(sandbox_id is null and lease_id is null and fencing_token is null)
          or (sandbox_id is not null and lease_id is not null and fencing_token > 0)`,
    )
    .addCheckConstraint(
      "run_attempts_settlement_shape",
      sql`(state in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
          or (state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)`,
    )
    .addCheckConstraint(
      "run_attempts_failure_shape",
      sql`(state in ('failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
          or (state not in ('failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)`,
    )
    .execute();

  await db.schema
    .createIndex("run_attempts_one_lease")
    .unique()
    .on("run_attempts")
    .column("lease_id")
    .where(sql<boolean>`lease_id is not null`)
    .execute();

  await db.schema
    .createTable("run_attempt_transitions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull())
    .addColumn("attempt_id", "uuid", (column) => column.notNull())
    .addColumn("from_state", "text")
    .addColumn("to_state", "text", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "run_attempt_transitions_attempt_fk",
      ["tenant_id", "run_id", "attempt_id"],
      "run_attempts",
      ["tenant_id", "run_id", "id"],
    )
    .addCheckConstraint(
      "run_attempt_transitions_from_state_valid",
      sql`from_state is null or from_state in ${attemptStates}`,
    )
    .addCheckConstraint("run_attempt_transitions_to_state_valid", sql`to_state in ${attemptStates}`)
    .addCheckConstraint(
      "run_attempt_transitions_reason_nonempty",
      sql`char_length(reason) between 1 and 256`,
    )
    .execute();

  await sql`
    insert into runs (
      id, tenant_id, project_id, workspace_id, session_id, turn_id, command_id,
      idempotency_key, state, attempt_count, stop_reason, failure_code,
      failure_message, failure_retryable, queued_at, started_at, settled_at,
      created_at, updated_at
    )
    select
      turn.id,
      turn.tenant_id,
      session_row.project_id,
      session_row.workspace_id,
      turn.session_id,
      turn.id,
      command.id,
      command.idempotency_key,
      case turn.state
        when 'queued' then 'queued'
        when 'dispatching' then 'claimed'
        when 'running' then 'running'
        when 'waiting_approval' then 'running'
        when 'cancelling' then 'cancel_requested'
        else turn.state
      end,
      coalesce(outbox_row.attempts, 0),
      turn.stop_reason,
      turn.failure_code,
      turn.failure_message,
      turn.failure_retryable,
      turn.created_at,
      turn.started_at,
      turn.settled_at,
      turn.created_at,
      coalesce(turn.settled_at, turn.started_at, turn.created_at)
    from turns as turn
    inner join sessions as session_row on session_row.id = turn.session_id
    inner join commands as command
      on command.tenant_id = turn.tenant_id
      and command.session_id = turn.session_id
      and command.turn_id = turn.id
      and command.kind = 'turn.execute'
    left join lateral (
      select delivery.attempts
      from outbox as delivery
      where delivery.tenant_id = command.tenant_id
        and delivery.payload ->> 'commandId' = command.id::text
      order by delivery.created_at asc
      limit 1
    ) as outbox_row on true
  `.execute(db);

  await sql`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_number, state, claim_owner_id,
      claim_expires_at, sandbox_id, lease_id, fencing_token, failure_code,
      failure_message, failure_retryable, claimed_at, provisioning_at,
      running_at, settled_at, created_at, updated_at
    )
    select
      run.id,
      run.tenant_id,
      run.id,
      run.attempt_count,
      case
        when run.state = 'queued' then 'failed'
        else run.state
      end,
      'migration',
      greatest(run.updated_at + interval '1 second', run.queued_at + interval '1 second'),
      lease.sandbox_id,
      lease.lease_id,
      lease.fencing_token,
      case when run.state = 'queued' then 'legacy_retry' else run.failure_code end,
      case when run.state = 'queued' then 'Pre-migration attempt returned to the queue' else run.failure_message end,
      case when run.state = 'queued' then true else run.failure_retryable end,
      run.queued_at,
      case when run.state in ('provisioning', 'restoring', 'running', 'checkpointing', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded') then coalesce(run.started_at, run.updated_at) end,
      case when run.state in ('running', 'checkpointing', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded') then coalesce(run.started_at, run.updated_at) end,
      case when run.state = 'queued' then run.updated_at else run.settled_at end,
      run.queued_at,
      run.updated_at
    from runs as run
    left join session_leases as lease on lease.session_id = run.session_id
    where run.attempt_count > 0
  `.execute(db);

  await sql`
    update runs
    set current_attempt_id = id
    where attempt_count > 0
  `.execute(db);

  await db.schema
    .alterTable("runs")
    .addForeignKeyConstraint(
      "runs_current_attempt_fk",
      ["id", "current_attempt_id"],
      "run_attempts",
      ["run_id", "id"],
    )
    .execute();

  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_current_attempt_shape",
      sql`(attempt_count = 0 and current_attempt_id is null)
          or (attempt_count > 0 and current_attempt_id is not null)`,
    )
    .execute();

  await sql`
    insert into run_attempt_transitions (
      id, tenant_id, run_id, attempt_id, from_state, to_state, reason, occurred_at
    )
    select id, tenant_id, run_id, id, null, state, 'migration_backfill', created_at
    from run_attempts
  `.execute(db);

  await db.schema
    .createIndex("runs_tenant_session_created_idx")
    .on("runs")
    .columns(["tenant_id", "session_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("runs_active_idx")
    .on("runs")
    .columns(["state", "updated_at"])
    .where(
      sql<boolean>`state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded')`,
    )
    .execute();
  await db.schema
    .createIndex("run_attempt_transitions_attempt_time_idx")
    .on("run_attempt_transitions")
    .columns(["attempt_id", "occurred_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("run_attempt_transitions").ifExists().execute();
  await db.schema.alterTable("runs").dropConstraint("runs_current_attempt_fk").execute();
  await db.schema.dropTable("run_attempts").ifExists().execute();
  await db.schema.dropTable("runs").ifExists().execute();
}
