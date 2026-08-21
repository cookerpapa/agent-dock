# ADR-0116: Kafka-first Agent event log

## Status

Accepted on 2026-08-22. This decision replaces the PostgreSQL live-event
authority described by ADR-0111. PostgreSQL remains the sole Run/control and
canonical Pi Session authority; Kafka becomes the sole durable hot Agent-event
log.

## Context

Pi Workers produce many short-lived Assistant text fragments while a Run is
active. Writing those fragments to PostgreSQL before every SSE delivery made
PostgreSQL act as both a transactional business database and a streaming
message relay. Application-level coalescing and group commit reduced fsyncs,
but did not remove repeated row inserts, index maintenance, replay reads and
retention deletes.

The required invariant is narrower than "all stream data belongs in the
business database": bytes shown by the browser must already have a durable,
ordered copy, and a later Turn must use the complete Pi messages committed at
semantic boundaries. Kafka's replicated append log fits the first requirement;
Pi SessionStorage in PostgreSQL fits the second.

## Decision

### Authorities and topics

- PostgreSQL remains authoritative for tenants, Sessions, Runs, Attempts,
  leases, fences, Pi SessionStorage and canonical complete messages.
- The persistent Cube Volume remains authoritative for Workspace bytes.
- Kafka is authoritative only for the bounded hot Agent event stream.
- Workers publish to `pi-cloud.agent-events.raw.v1`, keyed by Session ID, with
  `acks=all`, idempotent production and bounded batching.
- An authority projector validates Run, Attempt, lease, fence, command and
  Session identity against PostgreSQL, then republishes valid records to
  `pi-cloud.agent-events.accepted.v1`.
- Browser gateways and cold projectors consume only the accepted topic. A stale
  Worker can therefore put a record in the raw log, but cannot make it visible
  or canonical.

### Browser stream

- Browsers never receive Kafka credentials. The Gateway component in each
  Control Plane replica authenticates the HTTP request and exposes the existing
  resumable SSE contract.
- Each replica rebuilds a bounded local replay projection from the accepted
  topic before becoming ready, then tails it continuously.
- `Last-Event-ID` replays from that retained projection. A cursor older than
  Kafka retention receives an explicit expired-cursor response and reloads the
  canonical conversation from PostgreSQL.
- An event is eligible for SSE only after the accepted-topic broker ACK. This
  preserves "durable before visible" without inserting token fragments into
  PostgreSQL.

### Canonical projection and barriers

- Complete Pi entries, records, compaction boundaries and terminal metadata are
  projected into PostgreSQL at semantic boundaries. Token deltas, thinking
  fragments and partial Tool output never become canonical rows.
- A Worker does not start the next model Step or settle a Run until the relevant
  Session mutation has been acknowledged by the PostgreSQL projector. Kafka is
  therefore asynchronous between components but Pi's Agent Loop still observes
  a read-your-writes projection barrier.
- Projector writes are idempotent. Kafka delivery is at least once; canonical
  effects are one logical effect through stable mutation IDs and PostgreSQL
  uniqueness/CAS checks.
- Arbitrary Tool executions remain non-replayable. An ambiguous Tool effect is
  recorded as `UNKNOWN`, never retried merely because a Kafka record was
  redelivered.

### Terminal events and failure

- Run settlement and its terminal-event outbox row commit in one PostgreSQL
  transaction. A relay publishes the terminal event to the accepted topic and
  marks the outbox row delivered. This avoids an unsafe PostgreSQL/Kafka dual
  write at the Run boundary.
- If Kafka is unavailable, Workers stop receiving durable event ACKs and the Run
  fails closed; unacknowledged bytes are not displayed.
- If the Event Gateway is unavailable, Runs can continue and Kafka retains the
  replay window. A replacement Gateway rebuilds before serving SSE.
- If the PostgreSQL projector lags, new Runs for the same Session wait at the
  projection barrier rather than restoring stale Pi context.

## Rejected alternatives

- Keep PostgreSQL hot rows with larger group commits: fewer transactions but
  still duplicate write/read/delete amplification.
- Publish independently to PostgreSQL and Kafka from the Worker: ambiguous
  partial success creates two competing event authorities.
- Let the browser consume Kafka directly: exposes infrastructure credentials
  and cannot enforce tenant authorization safely.
- Use Valkey as another durable layer: Kafka already supplies retained replay;
  an additional cache is optional only after measured Gateway-memory pressure.
- Trust Worker-side fence checks: a paused or partitioned Worker is precisely
  the actor that fencing must distrust.

## Consequences

- PostgreSQL row growth follows semantic Pi messages and Run state rather than
  provider token cadence.
- Kafka retention, partition count, replication and consumer lag become release
  and operational concerns.
- The hot stream is intentionally bounded and is not a second lifetime
  transcript. PostgreSQL Pi SessionStorage remains the recovery authority.
- One-host deployment gains Kafka and a rebuildable in-process Gateway
  projection, but does not gain Valkey, a second scheduler or another Workspace
  store.
- Acceptance must cover broker ACK visibility, duplicate delivery, projector
  restart, Gateway rebuild, stale fence rejection, projection lag, SSE resume,
  real multi-round coding and component-loss behavior.
