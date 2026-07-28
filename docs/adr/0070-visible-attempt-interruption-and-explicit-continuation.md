# ADR-0070: Visible Attempt interruption and explicit continuation

- Status: accepted
- Date: 2026-07-27
- Extends: ADR-0031, ADR-0056
- Supersedes: ADR-0031's terminal-state list and any interpretation of
  ADR-0056 that permits transparent post-start Agent Activity replay

## Context

One Agent Activity contains non-deterministic model calls, streamed text, Tool
Calls and possible Workspace or external side effects. Temporal Workflow replay
can safely rebuild deterministic orchestration state, but Activity retry can
invoke that Agent Loop again on another Worker.

After output has been persisted for the browser, a second invocation may emit
different text or choose different Tools. After a Tool starts, it may also
repeat an effect whose outcome is unknown. Replacing the first stream with a
second stream is therefore neither a retry nor a continuation from the user's
perspective.

The exact first-token or first-Tool boundary cannot always be recovered after a
process crash. AgentDock already has an earlier durable, auditable boundary:
the execution Start ACK committed under the RunAttempt lease and fence.

## Decision

1. A browser transport disconnect never cancels or restarts a Run. Public
   events remain append-only in PostgreSQL; reconnect uses `Last-Event-ID` and
   replays the missing durable suffix.
2. The durable Start ACK is the conservative non-replay boundary. It may occur
   slightly before the first visible token or Tool, but it never occurs after
   either. This favors avoiding duplicate non-deterministic execution over an
   invisible automatic retry.
3. Temporal invokes `executeRunCommand` with `maximumAttempts: 1`, including
   both common and Worker-affinity Task Queues. Temporal Workflow replay does
   not re-run the Agent Activity.
4. Before Start ACK, assignment/outbox reconciliation may terminate the old
   Attempt, return the Run and Turn to their queued states and start the same
   deterministic Workflow ID again. The next claim creates a new fenced
   Attempt.
5. After Start ACK, Worker loss never re-enters the Agent Loop transparently.
   Reconciliation first confirms termination or absence of the old runtime,
   then settles the Run, current Attempt and Turn as `interrupted`, fails the
   command with `worker_lost_after_start`, and returns the Session to `idle`.
6. All already-durable model and Tool events remain visible. An interrupted
   transcript may have no terminal event and may contain a preparing/running
   Tool item. It is presentation and audit evidence, not a complete Pi message
   or proof that an uncertain Tool succeeded.
7. Continuation is an explicit authenticated operation on the latest
   interrupted Run. It creates a new Turn, Command, Run and Attempt path with a
   durable `continued_from_run_id`; it never mutates or reopens the source Run.
   One source Run can have at most one idempotent continuation.
8. The continuation restores only the last committed Pi checkpoint and
   Workspace head. Its internal prompt includes the original request and
   instructs Pi to inspect current files and test state, not assume an
   incomplete Tool succeeded, and verify uncertain external effects before
   repeating them.
9. A continuation that is itself interrupted can be continued as another
   linked Run, producing a linear, auditable chain.
10. An external side effect that cannot be reconciled remains an explicit
    unknown-state product concern. Continuation does not convert it into
    exactly-once execution.

## Consequences

- Users retain partial output and see an interruption marker plus a deliberate
  continue action instead of a cleared and regenerated response.
- Temporal Worker failure after Start ACK terminates the Workflow as an
  interrupted application result; infrastructure retry remains limited to the
  pre-ACK outbox/assignment path.
- The policy can forgo an automatic retry when a Worker dies after ACK but
  before emitting a token. This is intentional and auditable.
- The committed checkpoint pair remains the recovery authority. Mid-token,
  mid-message and arbitrary mid-Tool instruction-pointer recovery are not
  claimed.
- Run history, continuation ancestry and partial public events provide enough
  evidence for operators and future Tool-unknown reconciliation UX.

## Required evidence

- state-machine and migration constraints for `interrupted`;
- deterministic post-ACK Worker-loss reconciliation that preserves events;
- a pre-ACK reconciliation regression that still requeues safely;
- Temporal retry-policy regression fixed at one Activity attempt;
- idempotent continuation API creating a distinct linked Run;
- browser reducer regression retaining partial text beside the new Run;
- real-model Tool use that modifies and verifies a Workspace through the
  production execution boundary.
