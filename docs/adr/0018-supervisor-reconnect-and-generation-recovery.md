# ADR-0018: Worker Control Channel reconnect and generation recovery

- Status: accepted, amended for the Temporal/Pi SDK worker pool
- Date: 2026-07-19

## Context

Each trusted Pi Worker keeps one authenticated outbound WebSocket to the Control
Plane. The channel carries registration, capacity, heartbeats, durable Agent
events, cancellation and steer control messages. Temporal owns Run scheduling;
the WebSocket is not an execution queue.

Network loss and Control Plane restarts are normal. A reconnect must restore
future control traffic without reviving stale RunAttempt authority or replaying
an ambiguous Tool side effect.

## Decision

1. One single-use client represents one connection generation. A reconnecting
   wrapper creates a fresh generation with bounded jittered backoff.
2. Authentication, protocol and superseded-generation failures are terminal;
   transient transport failures may reconnect.
3. Registration carries the Worker's current drain state and `pi.sdk`
   capability. Reconnect never resets operator drain intent.
4. PostgreSQL records the current Worker connection generation. Messages from
   an older generation are fenced and cannot publish canonical state.
5. Durable events already accepted into the Worker WAL are replayed through the
   new generation and de-duplicated by `(run, attempt, sequence)`.
6. Reconnect does not reassign a Run. Temporal determines whether an Activity
   is retried, while RunAttempt lease/fence checks reject stale durable writes.
7. A Tool execution whose outcome is ambiguous is never blindly replayed. It is
   failed or reconciled under the exact-command protocol in ADR-0074.
8. Pending steer/control requests fail on generation loss unless their durable
   protocol explicitly permits retry.

## Consequences

- A short Control Channel outage does not require restarting a healthy Worker.
- No Session owns a permanent WebSocket or Worker process.
- Transport recovery remains separate from execution recovery.
- The system favors a fenced failure over pretending arbitrary shell commands
  execute exactly once.
