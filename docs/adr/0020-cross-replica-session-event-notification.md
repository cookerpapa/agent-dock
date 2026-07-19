# ADR-0020: Cross-replica session event notification by durable high-water hints

- Status: accepted
- Date: 2026-07-19
- Amended by: ADR-0025 makes the listener deployment-wide and keys the local
  hub/subscriber by `(tenantId, sessionId)` instead of filtering one configured
  tenant.

## Context

ADR-0008 made PostgreSQL the authority for session events and joined durable
`Last-Event-ID` replay with a process-local live hub. The subscribe-before-read
ordering prevents a gap when the event writer and SSE connection share one
control-plane process. It does not wake an SSE connection on replica B when
replica A commits the event.

The durable event row already contains the complete, fenced, ordered payload.
Copying that payload into Redis, Kafka, or PostgreSQL notifications would create
a second event log and another payload-size, retention, authorization, and
redelivery boundary. PostgreSQL `LISTEN/NOTIFY` is already available beside the
transaction that commits the authoritative event, but notifications are
ephemeral and can be duplicated or missed while a listener reconnects.

## Decision

1. The event-ingest transaction publishes a PostgreSQL notification after it
   advances the durable session cursor. `pg_notify` executes inside that same
   transaction, so PostgreSQL exposes the notification only after a successful
   commit and emits nothing after rollback.
2. The notification is a versioned high-water hint containing only
   `tenantId`, `sessionId`, and `throughSequence`. It never contains prompts,
   model output, credentials, tool arguments, checkpoint bytes, or other event
   payload. Its size is bounded well below PostgreSQL's notification limit.
3. Every control-plane replica owns one dedicated PostgreSQL listener
   connection, independent of the normal Kysely pool. A bounded equal-jitter
   reconnect loop restores `LISTEN` after a post-start connection failure.
   Failure to establish the initial listener fails application startup; a
   replica must not silently advertise real-time fan-out it did not establish.
4. The listener validates the complete notification envelope and filters it by
   the replica's configured tenant before touching the local event hub.
   Malformed or foreign-tenant notifications are ignored.
5. The process-local hub carries only a coalesced durable high-water signal per
   subscriber. It does not queue event bodies. On a signal, the SSE stream reads
   the missing contiguous suffix from `session_events` and sends that durable
   data. Multiple or out-of-order hints collapse to their greatest sequence.
6. The writer also signals its local hub immediately after commit. Receiving
   the same hint later through PostgreSQL is expected and harmless.
7. A reconnect wakes every current local subscription to force a durable
   rescan. In addition, an idle SSE heartbeat checks the durable cursor before
   writing its keepalive. Therefore a notification is only a latency
   optimization: listener downtime, duplicate delivery, or a lost hint cannot
   create an event gap. The bounded fallback delay defaults to the existing SSE
   heartbeat interval.
8. The existing subscribe-before-replay order remains. A subscriber is visible
   to the local hub before its initial durable high-water read, so a concurrent
   commit is represented by either that read or a queued hint, often both.
9. PostgreSQL remains the sole event authority. No notification is ACKed, no
   notification offset is stored, and the system makes no exactly-once claim.
   Browser reconnect still resumes strictly from its last successfully
   received SSE sequence.
10. The notification transport is injectable. Production constructs the
    PostgreSQL transport from `DATABASE_URL`; deterministic tests may use an
    in-memory transport. The PGlite socket adapter currently accepts
    `LISTEN/NOTIFY` SQL but does not forward notification frames, so the real
    transport contract is additionally exercised against localhost PostgreSQL.

## Failure boundaries

| Failure | Required outcome |
| --- | --- |
| event transaction rolls back | no durable row and no notification become visible |
| writer crashes after commit | row and transactional notification are committed together |
| listener receives a duplicate or older hint | local high-water coalescing and SSE sequence checks suppress it |
| listener disconnects during commits | reconnect wake or heartbeat poll reads the missing durable suffix |
| browser is slower than event production | one coalesced high-water hint remains in memory; events stay in PostgreSQL |
| malformed or cross-tenant payload arrives | listener ignores it and never reads or publishes event data |
| replica shuts down | listener backoff is interrupted, the dedicated client closes, and local subscribers close |

## Consequences

- An SSE connection can remain on any control-plane replica while the current
  Supervisor socket owner commits events elsewhere.
- Live notification memory is constant per subscriber rather than proportional
  to the number or size of queued model/tool events.
- A signal causes a database read, and every idle SSE heartbeat performs a
  bounded recovery check. This is intentionally simple for the current
  single-tenant phase; a future measured scale problem may batch cursor reads
  per process or move notifications to a broker without changing SSE replay.
- Production consumes one additional PostgreSQL connection per control-plane
  replica. Pool and deployment budgets must account for it.

## Rejected alternatives

### Put complete events in `NOTIFY`

PostgreSQL notifications have a small payload limit and no durable replay. It
would duplicate sensitive content and turn an optimization into a second event
transport contract.

### Publish after the database transaction

A crash between commit and publish would create an avoidable lost-wakeup
window. Transactional `pg_notify` gives commit-aligned visibility while durable
polling still covers listener loss.

### Add Redis Streams or Kafka immediately

The durable event log and replay cursor already live in PostgreSQL. A second
broker adds operations and offset semantics without a measured throughput or
cross-region requirement.

### Trust notification delivery as the event source

`LISTEN/NOTIFY` is ephemeral. Treating it as authoritative would make listener
reconnects capable of losing browser-visible events and would contradict
ADR-0008.
