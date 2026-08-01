# ADR-0008: Durable event ACK and resumable SSE replay

- Status: Accepted
- Date: 2026-07-18
- Extended by: [ADR-0020](0020-cross-replica-session-event-notification.md), which replaces the
  original event-body queue and single-replica live-notification limitation with
  coalesced durable high-water hints plus PostgreSQL `LISTEN/NOTIFY`.

## Context

The pinned Pi integration already converts runtime output into ordered
`event.publish` messages carrying command, session, turn, lease, fence, and
event identities. The control plane currently validates those messages only in
memory. A process restart or browser reconnect therefore loses output, and the
supervisor has no durable fact on which to delete its delivery copy.

The existing event table also has two representation gaps. Public `agentId`
values are opaque stable strings such as `root`, while `agent_node_id` is an
optional internal UUID foreign key. The table also does not retain the optional
wire `commandId`, which is needed to audit and fully compare a redelivery.

Finally, replay and live delivery must meet without a race. Querying history and
only then subscribing can miss a commit between those operations; subscribing
and then replaying can deliver the same commit twice.

## Decision

1. A new forward database migration adds a non-empty public `agent_id` and an
   optional `command_id` foreign key to `session_events`. `agent_node_id`
   remains a separate optional internal relation; the control plane does not
   coerce `root` into a UUID. Legacy rows receive a visible `legacy`/node-ID
   backfill rather than an invented current identity.
2. Event ingestion parses the closed supervisor wire schema, then locks the
   owning session and cursor in a PostgreSQL transaction. A new event is
   accepted only when tenant/session/turn/command ownership is consistent, the
   current unexpired lease and fencing token match, and its sequence is exactly
   `last_persisted_seq + 1` and `sessions.next_event_seq`.
3. The transaction inserts the complete public event and delivery identity,
   advances `last_persisted_seq`, `acknowledged_through_seq`, and
   `sessions.next_event_seq`, and commits atomically. Only after commit may the
   control plane construct and return the cumulative `event.ack` or publish the
   event to live browser subscribers. In this table, `acknowledged_through_seq`
   means the durable contiguous prefix eligible to be ACKed; it does not claim
   that a transport packet reached the supervisor.
4. Delivery is at least once. A redelivery at an already persisted sequence is
   ACKed only when event ID, event body, occurrence time, command, lease, and
   fence exactly match the stored row. A conflicting duplicate or sequence gap
   is rejected without mutation. An exact durable duplicate may be re-ACKed
   after lease release, because the previous ACK packet may have been lost; its
   ACK stops at that event sequence and cannot authorize a new write. A new
   event always requires the current unexpired lease.
5. The local supervisor puts each publication in its bounded event spool before
   delivery and removes the durable prefix only after validating the returned
   cumulative ACK. This is the in-process realization of the same transport
   contract; durable supervisor-side spool storage remains a later slice.
6. The browser API is `GET /v1/sessions/:sessionId/events`. The SSE `id` is the
   decimal session sequence, `event` is the AgentDock event type, and `data` is
   the complete versioned AgentDock event JSON. `Last-Event-ID` is absent or a
   canonical non-negative safe integer; a cursor beyond the durable high-water
   mark is rejected.
7. The stream subscribes to an in-process session event hub before reading the
   durable suffix, emits database rows in sequence, then consumes the live
   queue. It drops any queued event whose sequence was already replayed, which
   closes both the missed-commit and duplicate-delivery races. Slow live
   subscribers have a bounded queue and are disconnected instead of consuming
   unbounded control-plane memory. SSE heartbeats keep an otherwise idle
   connection alive and do not advance the cursor.
8. PostgreSQL remains authoritative. The live event hub is only a single
   control-plane-process notification optimization. `Last-Event-ID` replay is
   restart-safe, but seamless live fan-out across multiple control-plane
   replicas requires PostgreSQL `LISTEN/NOTIFY` or another broker in a later
   deployment slice.
9. The v0 endpoint uses the control plane's configured single tenant, like the
   existing REST endpoints. Multi-user authentication and authorization must
   be added before exposing it as a shared service.

## Consequences

- A supervisor never deletes its event copy based on an in-memory callback;
  PostgreSQL commit is the ACK boundary.
- Session sequence allocation survives turns, Pi processes, browser reconnects,
  and control-plane restarts.
- Exact duplicates are safe, while a stale runner cannot add or alter history.
- A browser can resume a precise suffix without consuming raw Pi SDK objects.
- `agent_id` and `agent_node_id` preserve distinct public and internal concepts.
- The first implementation is restart-safe but not yet multi-replica-live,
  durable on the supervisor side, or authenticated for multiple users.

## Rejected alternatives

### ACK before the database commit

The supervisor could discard the only delivery copy while the transaction later
rolls back or the control-plane process crashes.

### Store `root` in `agent_node_id`

That column is an internal UUID foreign key. Changing public agent identity to
fit it would corrupt the protocol boundary and make subagent identity brittle.

### Query history and then subscribe

An event committed between the query and subscription would be absent from both
sources until a later reconnect.

### Treat every duplicate as stale after lease release

If the durable commit succeeds and its ACK packet is lost immediately before
settlement releases the lease, the supervisor can never drain its retained
copy. Exact persisted redelivery is a read-only proof and is safe to re-ACK.

### Stream raw Pi SDK output

It would couple the browser and durable schema to Pi internals, bypass redaction,
and make Pi upgrades a public API migration.
