# ADR-0077: Explicit active Pi steer

## Status

Accepted. Completes the operation reserved by ADR-0013.

## Context

Submitting another ordinary prompt while a Session is running creates a durable
follow-up Turn. That is intentionally different from Pi's native `steer`
operation, which injects guidance into the active Agent Loop after the current
Tool batch and before the next model request.

Silently treating every active-session prompt as steer would make delivery
timing-dependent and would lose the mailbox, retry and cold-restore semantics
of an ordinary follow-up.

## Decision

1. The public API exposes
   `POST /v1/sessions/{sessionId}/turns/{turnId}/steers` with a mandatory
   `Idempotency-Key`. It never creates another Turn.
2. A `turn.steer` command is persisted before delivery. Its immutable payload
   records the exact target execute command, RunAttempt, Worker/Sandbox
   identity and text. A completed idempotent replay returns the original
   result.
3. Delivery uses `command.turn.steer` over the existing two-phase Supervisor
   channel. The target Lease and Fencing Token must still identify the current
   RunAttempt.
4. Supervisors advertise `pi.steer.v1`. The Control Plane refuses steer when
   the connected Worker lacks that capability.
5. Preparation has no side effect. Only `command.commit` calls the public Pi
   SDK method `session.steer(text)`. Duplicate command IDs reuse the same
   in-process result.
6. A steer is accepted only while the target Turn, Run, Attempt and Session are
   running. If the Run settles first, the request fails with conflict; it is
   never converted into a queued follow-up.
7. The normal prompt composer retains queued-follow-up semantics. The Web UI
   exposes a separate **引导** action while a Run is active.
8. Steer text is stored by Pi as native Session state. The next settled or
   interrupted Pi checkpoint therefore preserves it without reconstructing a
   synthetic `messages[]`.

## Consequences

- Users can redirect a long-running Agent without cancelling it or waiting for
  a second Turn.
- The API, UI and wire protocol make the semantic choice explicit.
- A Control Plane crash after committed delivery can produce an ambiguous HTTP
  outcome. Retrying the same idempotency key reuses the same command identity;
  no arbitrary new steer is invented.
- Steer is meaningful only for a live Runtime. It is not placed in the
  PostgreSQL ready-Run queue and cannot be replayed against a later Attempt.

## Rejected alternatives

### Make Enter steer whenever a Run is active

This destroys the already-documented queued follow-up behavior and makes user
intent depend on timing.

### Queue steer as an ordinary Run

A delayed steer aimed at a later Runtime is no longer a steer. The correct
durable operation for that behavior is an ordinary follow-up Turn.

### Let the browser identify a Worker or Sandbox

Worker, Sandbox, Lease and Fence identities are trusted routing data and are
resolved server-side from the active Run.
