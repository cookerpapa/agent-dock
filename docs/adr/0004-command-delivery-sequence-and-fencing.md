# ADR-0004: Command delivery, event sequence, leases, and fencing

- Status: Accepted
- Date: 2026-07-18

## Context

WebSocket reconnects, retries, process crashes, and lease expiry make duplicate
command and event delivery normal. A stale supervisor can also remain alive
after the control plane has assigned the same session elsewhere. Process
liveness alone therefore cannot protect session state.

## Decision

1. The control plane durably stores a client command before returning acceptance.
   `(session_id, idempotency_key)` is unique, and a duplicate client request
   returns the original `commandId` and `turnId`.
2. Internal command delivery is at least once. Redelivery reuses the same
   `commandId`; a supervisor responds `accepted`, `duplicate`, or `rejected`.
   Command ACK is transport responsibility, not proof that the turn completed.
3. A session has at most one normal active turn. Prompt, cancellation, and
   approval commands are serialized through its mailbox/state machine.
4. Each execution assignment has an opaque `leaseId` and a positive,
   monotonically increasing `fencingToken`. A new assignment receives a larger
   token than every previous assignment for that session.
5. Commands, published events, event ACKs, and heartbeat lease observations
   carry the lease ID and fencing token. Both sides reject a message that does
   not match their current assignment.
6. Event sequence numbers are contiguous and monotonic per session, not per
   WebSocket or turn. A newly fenced supervisor starts at the control plane's
   last durably persisted sequence plus one.
7. Event delivery is at least once. The control plane deduplicates by
   `(session_id, seq)` and verifies that a duplicate has the same `eventId`.
8. Event ACKs are cumulative. Repeating the current ACK is idempotent; an ACK
   that regresses or exceeds the highest published sequence is a protocol error.
9. Heartbeats report liveness and lease observations, but never override
   fencing. Lease renewal is valid only when the control plane returns the same
   current lease ID/token with a new expiry.
10. Recovery never claims exactly-once execution for shell commands, tools, or
    external side effects. Ambiguous mutations require reconciliation or human
    confirmation.

## Consequences

Positive:

- request retry does not create a second turn;
- stale runners cannot mutate a reassigned session;
- reconnect can replay a precise contiguous suffix;
- command completion and network delivery acknowledgements are not conflated.

Negative:

- every mutation must carry and validate fencing metadata;
- sequence gaps stop ACK advancement and create backpressure;
- ambiguous tool side effects remain a domain problem, not a messaging trick.

## Revisit criteria

Revisit the transport implementation after measuring PostgreSQL queue and event
throughput. Kafka, a workflow engine, or a different log may replace delivery
mechanics, but must preserve these idempotency, ordering, and fencing semantics.
