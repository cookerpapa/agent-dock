# ADR-0096: Temporal handoff and capacity backpressure

## Status

Accepted on 2026-08-12.

## Context

Run admission commits a transactional Outbox row before acknowledging the
browser. The first Temporal integration kept that row pending until a Pi Worker
acknowledged execution. A bounded relay query could therefore repeatedly see
already-started Workflows at the front of the Outbox while later Runs never
reached Temporal. This made PostgreSQL retain part of the execution backlog
even though Temporal is the selected post-admission scheduler.

Pi Worker replicas also poll a shared Cell queue and a private affinity queue.
Both pollers advertised the complete process capacity while sharing one local
slot counter. When either poller received more Activities than the process
could execute, the Activity returned `deferred` and the Workflow retried after
250 milliseconds. The result was avoidable Activity/history churn rather than
ordinary Task Queue backpressure.

## Decision

1. An Outbox row records a separate `temporal_handed_off_at` milestone. A
   deterministic Workflow start, including idempotent adoption of an existing
   Workflow ID, is followed by a compare-and-set of that timestamp.
2. The Temporal relay scans only rows whose handoff timestamp is null. Worker
   acknowledgement remains represented by Command/Turn/Run state; the existing
   `published_at` column is retained temporarily for the current exact-command
   execution protocol and is not used to decide whether a Workflow was handed
   to Temporal.
3. Workflow starts are performed with bounded concurrency. A failure before the
   handoff CAS leaves the row eligible; the next relay pass adopts the same
   deterministic Workflow and completes the handoff.
4. Pi Workers use one Cell poller and one process-wide Temporal Activity
   capacity limit. A busy process leaves work in Temporal matching. A
   PostgreSQL-authority deferral uses bounded exponential delay rather than a
   fixed 250-millisecond loop.
5. Temporal remains the sole post-admission backlog owner. PostgreSQL remains
   the business-state, lease and fencing authority.

## Consequences

- A full Worker pool no longer prevents later admitted Runs from reaching
  Temporal merely because earlier Workflows have not started executing.
- Relay restart after `workflow.start` is safe because Workflow IDs are
  deterministic and the handoff timestamp is a CAS.
- Temporal cannot jointly oversubscribe the Pi process through multiple
  independent pollers.
- Activity retries may still observe legitimate business-state deferral, but
  their cadence is bounded and observable instead of becoming a tight loop.
- Removing the legacy execution use of `outbox.published_at` is a separate
  cleanup after the exact-command lifecycle is migrated entirely to
  Command/Run state.
