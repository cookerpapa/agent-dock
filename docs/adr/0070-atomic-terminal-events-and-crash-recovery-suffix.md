# ADR-0070: Atomic terminal events and hard-crash recovery suffix

- Status: accepted
- Date: 2026-07-29

## Context

The trusted Pi Worker currently publishes `turn.completed`, `turn.failed` or
`turn.cancelled` through the ordinary durable event channel. The Control Plane
then settles the Run, RunAttempt, command, turn, Pi checkpoint and Workspace
head in a later PostgreSQL transaction.

This creates a failure window in which the public transcript is terminal while
the business state and checkpoint heads are not committed. A Control Plane
crash in that window can later converge the Run to `assignment_lost` after the
browser has already observed completion.

Catchable failure and cancellation already preserve a Pi-native interrupted
checkpoint. A process `SIGKILL`, OOM kill, Pod loss or node loss cannot run the
Worker's `finally` block. Durable `session_events` can therefore contain
assistant text and Tool results that are newer than the latest Pi checkpoint.

## Decision

### Terminal commit boundary

Worker-produced `command.result` is the private prepared-result boundary. A
Worker may publish only non-terminal streaming and Tool events.

The Control Plane writes the public `turn.completed`, `turn.failed` or
`turn.cancelled` event in the same PostgreSQL transaction that:

- settles the Run and current RunAttempt;
- settles or abandons the staged checkpoint;
- advances Pi and Workspace heads under fencing/CAS;
- settles command, turn and session state; and
- materializes the semantic conversation projection.

The transaction also advances the durable event cursor and emits the
PostgreSQL wake notification. Supervisor event ingestion rejects public
terminal events.

The private completed command result carries the bounded Workspace patch so
the Control Plane can construct the canonical completion event.

### Hard-crash recovery

Pi JSONL remains the conversation authority. AgentDock does not introduce a
second mutable `messages[]` representation.

Each loaded Pi checkpoint is associated with the sequence of its canonical
terminal event. When later terminal conversation projections exist beyond that
sequence without a newer Pi checkpoint, the checkpoint loader returns a
bounded AgentDock-owned semantic recovery suffix containing:

- the accepted user prompt;
- publicly visible assistant text;
- completed/failed/unknown Tool boundaries and bounded results; and
- the canonical failure/cancellation status.

The trusted Pi adapter appends this suffix as one hidden, model-visible custom
message before the next prompt. Raw thinking is not recovered into model
context. The next successful or interrupted Pi checkpoint absorbs the recovery
entry, so ordinary restore continues to use only native Pi JSONL.

This suffix is a recovery bridge, not a competing transcript authority.

### Timeouts

The Temporal Activity start-to-close timeout must exceed the maximum configured
Pi Turn timeout plus bounded restore, Sandbox settlement, checkpoint and
cleanup allowance. Configuration validation rejects an unsafe relationship.

## Consequences

- A browser terminal state is proof of the same canonical commit used by
  scheduling and checkpoint restore.
- A stale or compromised Worker cannot publish a terminal state directly.
- Hard process loss retains already-durable semantic output in the next model
  context without replaying arbitrary Tool side effects.
- Tool execution with an unknown result remains non-retryable and is described
  as ambiguous in the recovery suffix.
- The terminal event writer becomes shared transactional infrastructure used by
  execution and cancellation dispatchers.

## Rejected alternatives

- A public `turn.output_settled` event was rejected because the existing
  private `command.result` already represents the prepared result and does not
  require another public lifecycle state.
- Reconstructing a full Pi Session from browser text was rejected because it
  would break Pi branch and compaction semantics.
- A second full Agent Journal was rejected because Pi JSONL and PostgreSQL
  events would become competing conversation authorities.
