# ADR-0031: Durable Run and RunAttempt protocol

- Status: accepted
- Date: 2026-07-20
- Extends: ADR-0013, ADR-0014, ADR-0017, ADR-0030

## Context

The command, outbox, Turn, session lease, and fencing-token machinery already
prevented concurrent same-session mutation, but an operator could not inspect a
logical execution independently from its delivery records. A pre-ACK retry also
reused the same public Turn vocabulary even though a different worker claim was
performing the work. That made crash diagnosis and stale-worker reasoning harder
than necessary.

## Decision

1. Every accepted execute command creates exactly one tenant-owned `Run` in the
   same transaction as its Turn, Command, and outbox record. The accepted HTTP
   resource exposes `runId`.
2. Every outbox claim creates a new immutable-numbered `RunAttempt`. The Run is
   the logical user request; an Attempt is one at-least-once delivery and runtime
   authority. `runId` and `attemptId` travel on the trusted supervisor wire and
   the Tool Sandbox assignment.
3. The lifecycle is explicit:

   ```text
   Run: queued -> claimed -> provisioning -> restoring? -> running
        -> checkpointing -> completed

   terminal alternatives: failed | cancelled | timed_out | superseded
   ```

   Attempt transition history, phase timestamps, claim owner/expiry, heartbeat,
   sandbox/lease/fence assignment, checkpoint revision, and safe failure metadata
   are durable.
4. A retryable failure before durable ACK terminates that Attempt as `failed`,
   returns the Run to `queued`, and leaves the Command/Turn eligible for another
   claim. A retry creates a new Attempt; it never rewrites the old Attempt.
5. The trusted Runner records restore, run, checkpoint, and committed revision
   through a fail-closed persistence observer. The Tool Sandbox receives neither
   this database capability nor platform credentials.
6. Session lease acquisition binds the exact current Attempt to sandbox,
   lease UUID, and fencing token. Shared heartbeat renewal advances the session
   lease and Attempt heartbeat/claim expiry in one transaction.
7. Terminal Run/Attempt state, Command, Turn, Session, outbox publication, and
   lease release are committed under locked current identities. Checkpoint CAS
   separately validates the exact current Run/Attempt plus session lease/fence;
   object uploads that fail CAS are deleted and do not become current.
8. Assignment reconciliation terminates or fails the old Attempt before either
   requeueing the Run or failing it. A stale worker cannot commit through a
   superseded `current_attempt_id`.
9. Public tenant-scoped APIs expose Run lists and individual Run/Attempt history.
   Foreign Run UUIDs remain indistinguishable from missing resources.

## Delivery claim

AgentDock claims:

```text
at-least-once scheduling
+ durable attempt history
+ idempotent intake
+ lease/fencing/current-attempt guarded commits
```

It does not claim exactly-once LLM calls, shell commands, GitHub operations, or
other arbitrary external side effects.

## Consequences

- A Run can explain retry, crash, cancellation, timeout, and checkpoint history
  without reconstructing it from unrelated tables.
- Provider `attemptId` is now a real durable Attempt UUID rather than an alias of
  `leaseId`; Provider and wire contracts remain otherwise stable.
- Old workers and old checkpoint writers fail closed once another Attempt is
  current.
- Run records add writes to claim, phase, heartbeat, and terminal transactions;
  bounded list/history APIs and indexes keep the operator surface predictable.

## Rejected alternatives

### Treat every retry as a new Run

That loses the stable identity of one user request and complicates idempotency,
cost aggregation, and UI history.

### Call delivery exactly once

PostgreSQL claim expiry cannot prove whether arbitrary code or a provider call
ran before a worker disappeared. Fenced commits are supportable; exactly-once
external execution is not.

### Store phases only in logs

Logs cannot enforce current-attempt CAS and are not a durable product API.
