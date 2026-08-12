# ADR-0074: Exact-command Temporal Activity boundary

- Status: accepted
- Date: 2026-07-30
- Refines: ADR-0056

## Context

ADR-0056 selected Temporal as the sole post-admission scheduler, but the first
production cutover still invoked `OutboxDispatcher.dispatchCommand()` from a
Temporal Activity. That class also retained `dispatchNext()`, tenant ordering,
Supervisor-affinity filtering, PostgreSQL retry timing and
`last_scheduled_at` updates from the superseded polling scheduler.

Production called only the exact-command method, so retaining the general
polling API created misleading ownership and left two scheduling
implementations in one class.

## Decision

1. A Temporal Workflow identifies one exact accepted `commandId`.
2. A Pi Worker Activity calls `RunCommandExecutor.dispatchCommand(commandId)`.
3. `RunCommandExecutor` never scans for another tenant, Session or Run. It
   performs only transactional eligibility checks, creates/supersedes the
   `RunAttempt`, invokes the trusted backend and commits lifecycle state.
4. Activity cancellation calls
   `RunCancellationExecutor.dispatchTargetCommand(commandId)`. It may claim
   only a cancellation that targets that exact running command; it cannot scan
   for another tenant or Run.
5. Temporal priority metadata uses `tenantId` as `fairnessKey`; PostgreSQL no
   longer advances `tenant_runtime_policies.last_scheduled_at` during Run
   execution.
6. Temporal owns the retry timer for retryable pre-start failures. PostgreSQL
   records the failed Attempt and immediately makes the same exact command
   eligible; the Workflow decides when to schedule its next Activity.
7. PostgreSQL continues to reject an exact command when an earlier Session
   message, an active Workspace writer, a tenant concurrency limit or a
   Candidate Race concurrency limit blocks it. The Workflow receives
   `deferred` and waits durably.
8. Every Worker polls only its Cell queue. Temporal Activity slots are the
   process-capacity boundary; Worker-specific queues and reservations are not
   part of the current runtime.
9. Claim expiry, RunAttempt supersession, Session lease, fencing token and CAS
   remain mandatory because Temporal Activity delivery is not proof that an old
   Worker stopped producing side effects.

## Consequences

- There is no production API that allows a Pi Worker to select arbitrary
  pending work from PostgreSQL.
- There is no production API that allows a Pi Worker to select an unrelated
  cancellation command.
- Temporal owns cross-tenant ordering, Task matching and retry timers.
- PostgreSQL remains the business-state and correctness authority without
  acting as a second Worker scheduler.
- Existing state-machine, cancellation, Candidate Race and Workspace
  serialization behavior remains unchanged.
- Historical tests that need to exercise several accepted commands use a
  test-only lookup helper; production code cannot import it.
