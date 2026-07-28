import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table runs add column continued_from_run_id uuid`.execute(db);
  await sql`
    alter table runs
    add constraint runs_continued_from_run_fk
      foreign key (tenant_id, continued_from_run_id)
      references runs (tenant_id, id)
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_one_continuation_per_source_unique
      unique (tenant_id, continued_from_run_id)
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_continuation_not_self
      check (continued_from_run_id is null or continued_from_run_id <> id)
  `.execute(db);

  await sql`alter table turns drop constraint turns_state_valid`.execute(db);
  await sql`alter table turns drop constraint turns_input_valid`.execute(db);
  await sql`alter table turns drop constraint turns_settled_at_matches_state`.execute(db);
  await sql`alter table turns drop constraint turns_failure_fields_match_state`.execute(db);
  await sql`
    alter table turns
    add constraint turns_state_valid
      check (state in (
        'queued', 'dispatching', 'running', 'waiting_approval', 'cancelling',
        'completed', 'interrupted', 'failed', 'cancelled'
      ))
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_input_valid
      check (
        input_kind in ('prompt', 'continue')
        and input_text is not null
        and char_length(input_text) > 0
      )
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_settled_at_matches_state
      check (
        (state in ('completed', 'interrupted', 'failed', 'cancelled') and settled_at is not null)
        or
        (state not in ('completed', 'interrupted', 'failed', 'cancelled') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_failure_fields_match_state
      check (
        (state in ('interrupted', 'failed') and failure_code is not null and failure_retryable is not null)
        or
        (state not in ('interrupted', 'failed') and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`alter table runs drop constraint runs_state_valid`.execute(db);
  await sql`alter table runs drop constraint runs_settlement_shape`.execute(db);
  await sql`alter table runs drop constraint runs_failure_shape`.execute(db);
  await sql`
    alter table runs
    add constraint runs_state_valid
      check (state in (
        'queued', 'claimed', 'provisioning', 'restoring', 'running',
        'checkpointing', 'cancel_requested', 'completed', 'interrupted',
        'failed', 'cancelled', 'timed_out', 'superseded'
      ))
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_settlement_shape
      check (
        (state in ('completed', 'interrupted', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
        or
        (state not in ('completed', 'interrupted', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_failure_shape
      check (
        (state in ('interrupted', 'failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
        or
        (state not in ('interrupted', 'failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`alter table run_attempts drop constraint run_attempts_state_valid`.execute(db);
  await sql`alter table run_attempts drop constraint run_attempts_settlement_shape`.execute(db);
  await sql`alter table run_attempts drop constraint run_attempts_failure_shape`.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_state_valid
      check (state in (
        'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
        'cancel_requested', 'completed', 'interrupted', 'failed', 'cancelled',
        'timed_out', 'superseded'
      ))
  `.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_settlement_shape
      check (
        (state in ('completed', 'interrupted', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
        or
        (state not in ('completed', 'interrupted', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_failure_shape
      check (
        (state in ('interrupted', 'failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
        or
        (state not in ('interrupted', 'failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`
    alter table run_attempt_transitions
    drop constraint run_attempt_transitions_from_state_valid
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    drop constraint run_attempt_transitions_to_state_valid
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    add constraint run_attempt_transitions_from_state_valid
      check (
        from_state is null or from_state in (
          'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
          'cancel_requested', 'completed', 'interrupted', 'failed', 'cancelled',
          'timed_out', 'superseded'
        )
      )
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    add constraint run_attempt_transitions_to_state_valid
      check (
        to_state in (
          'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
          'cancel_requested', 'completed', 'interrupted', 'failed', 'cancelled',
          'timed_out', 'superseded'
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from turns where state = 'interrupted')
        or exists (select 1 from runs where state = 'interrupted')
        or exists (select 1 from run_attempts where state = 'interrupted')
        or exists (select 1 from runs where continued_from_run_id is not null) then
        raise exception 'cannot remove interrupted Run support while interruption or continuation rows exist';
      end if;
    end
    $$;
  `.execute(db);

  await sql`
    alter table run_attempt_transitions
    drop constraint run_attempt_transitions_from_state_valid
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    drop constraint run_attempt_transitions_to_state_valid
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    add constraint run_attempt_transitions_from_state_valid
      check (
        from_state is null or from_state in (
          'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
          'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out',
          'superseded'
        )
      )
  `.execute(db);
  await sql`
    alter table run_attempt_transitions
    add constraint run_attempt_transitions_to_state_valid
      check (
        to_state in (
          'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
          'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out',
          'superseded'
        )
      )
  `.execute(db);

  await sql`alter table run_attempts drop constraint run_attempts_state_valid`.execute(db);
  await sql`alter table run_attempts drop constraint run_attempts_settlement_shape`.execute(db);
  await sql`alter table run_attempts drop constraint run_attempts_failure_shape`.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_state_valid
      check (state in (
        'claimed', 'provisioning', 'restoring', 'running', 'checkpointing',
        'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out',
        'superseded'
      ))
  `.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_settlement_shape
      check (
        (state in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
        or
        (state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table run_attempts
    add constraint run_attempts_failure_shape
      check (
        (state in ('failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
        or
        (state not in ('failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`alter table runs drop constraint runs_state_valid`.execute(db);
  await sql`alter table runs drop constraint runs_settlement_shape`.execute(db);
  await sql`alter table runs drop constraint runs_failure_shape`.execute(db);
  await sql`
    alter table runs
    add constraint runs_state_valid
      check (state in (
        'queued', 'claimed', 'provisioning', 'restoring', 'running',
        'checkpointing', 'cancel_requested', 'completed', 'failed', 'cancelled',
        'timed_out', 'superseded'
      ))
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_settlement_shape
      check (
        (state in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is not null)
        or
        (state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table runs
    add constraint runs_failure_shape
      check (
        (state in ('failed', 'timed_out') and failure_code is not null and failure_retryable is not null)
        or
        (state not in ('failed', 'timed_out') and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`alter table turns drop constraint turns_state_valid`.execute(db);
  await sql`alter table turns drop constraint turns_input_valid`.execute(db);
  await sql`alter table turns drop constraint turns_settled_at_matches_state`.execute(db);
  await sql`alter table turns drop constraint turns_failure_fields_match_state`.execute(db);
  await sql`
    alter table turns
    add constraint turns_state_valid
      check (state in (
        'queued', 'dispatching', 'running', 'waiting_approval', 'cancelling',
        'completed', 'failed', 'cancelled'
      ))
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_input_valid
      check (
        (input_kind = 'prompt' and input_text is not null and char_length(input_text) > 0)
        or
        (input_kind = 'continue' and input_text is null)
      )
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_settled_at_matches_state
      check (
        (state in ('completed', 'failed', 'cancelled') and settled_at is not null)
        or
        (state not in ('completed', 'failed', 'cancelled') and settled_at is null)
      )
  `.execute(db);
  await sql`
    alter table turns
    add constraint turns_failure_fields_match_state
      check (
        (state = 'failed' and failure_code is not null and failure_retryable is not null)
        or
        (state <> 'failed' and failure_code is null and failure_message is null and failure_retryable is null)
      )
  `.execute(db);

  await sql`alter table runs drop constraint runs_continuation_not_self`.execute(db);
  await sql`
    alter table runs drop constraint runs_one_continuation_per_source_unique
  `.execute(db);
  await sql`alter table runs drop constraint runs_continued_from_run_fk`.execute(db);
  await sql`alter table runs drop column continued_from_run_id`.execute(db);
}
