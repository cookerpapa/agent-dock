# ADR-0003: State ownership and acknowledgement boundary

- Status: Accepted
- Date: 2026-07-18

## Context

AgentDock spans a trusted control plane, a trusted Pi Worker, an isolated Cube
Tool environment, a live Workspace, and cold object storage. Several of these
components temporarily hold related data, but treating more than one copy as
authoritative would make reconnect and crash recovery ambiguous.

The event protocol also needs a precise definition of acknowledgement. A
network read or an in-memory queue insertion is not sufficient: after such an
ACK, a control-plane crash could lose an event that the supervisor has already
discarded.

## Decision

1. PostgreSQL is authoritative for tenant/project ownership, sessions, turns,
   commands, idempotency records, leases, fencing tokens, approvals, durable
   event rows, event ACK cursors, usage, and the transactional outbox.
2. Pi session JSONL is authoritative for Pi's conversation history and session
   tree. Exactly one currently fenced supervisor may write a live session.
3. Object storage is authoritative for settled Pi session snapshots, workspace
   snapshots, large tool output, patches, reports, and crash bundles.
4. The live sandbox filesystem is a replaceable execution copy. It is not
   authoritative for control state, authentication, ownership, or leases.
5. The supervisor event spool owns only unacknowledged delivery copies. It must
   retain an event until the control plane returns a cumulative ACK after the
   event and its new cursor are durably committed.
6. An event ACK means that every sequence up to and including
   `acknowledgedThroughSeq` is durably recoverable by the control plane. It does
   not mean merely received, parsed, or buffered.
7. If the ACK is lost, the supervisor resends events. PostgreSQL uniqueness on
   `(session_id, seq)` and `event_id` makes this at-least-once delivery safe.
8. Raw Pi SDK events are ephemeral adapter input. They are neither stored as
   domain events nor exposed as an alternative source of truth.
9. Initial crash recovery returns to the last settled turn snapshot. Arbitrary
   mid-tool-call recovery is not claimed.

## Consequences

Positive:

- every datum has one recovery authority;
- an ACK is strong enough for the supervisor to delete its delivery copy;
- duplicate delivery is expected and testable rather than exceptional;
- cold sandboxes can be discarded without losing control state.

Negative:

- event persistence is on the critical path before ACK;
- the supervisor needs a bounded local spool and backpressure policy;
- stable snapshot boundaries must be coordinated with turn completion.

## Revisit criteria

Revisit when mid-turn checkpointing is implemented or when measured event-write
latency justifies a different durable log. Any replacement must preserve the
same externally visible ACK guarantee.
