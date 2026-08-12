# ADR-0098: Self-healing live-event read model

## Status

Accepted on 2026-08-12.

## Context

Kafka is the durable payload boundary for non-terminal Worker events, while
Valkey is a bounded SSE read model. The previous operator-only rebuild command
could restore an empty Valkey deployment, but normal Event Gateway startup did
not verify that PostgreSQL's projected cursor was actually materialized in
Valkey. A lost Valkey volume could therefore leave the Gateway running with a
durable cursor that referred to an absent stream, and recovery depended on a
manual stop/rebuild/restart procedure.

## Decision

1. Event Gateway startup compares every still-retained PostgreSQL live range
   with the first expected Valkey Stream sequence before starting the normal
   Kafka projector or accepting traffic.
2. Missing streams are reset through a tenant-checked operation and rebuilt
   from retained Session-keyed Kafka records. A second scan must find no
   missing stream before startup may continue.
3. Multiple Gateway replicas serialize this repair with a PostgreSQL session
   advisory lock through the direct database endpoint. Transaction-pooling
   PgBouncer is not a valid endpoint for this lock. Normal projection
   transactions take the matching shared advisory lock, so repair also cannot
   race with an already-running replica during a rolling replacement.
4. PostgreSQL remains the authority for replay floors and accepted/projected
   cursors. Kafka remains the replay source; Valkey remains disposable.
5. Automatic repair is enabled by default and may be disabled explicitly for
   controlled maintenance. The standalone rebuild command remains an operator
   fallback and shares the same implementation.
6. Valkey uses an explicit data-memory ceiling below its container memory
   limit and `noeviction`. Saturation must apply backpressure rather than
   silently deleting user-visible events.

## Consequences

- Total Valkey loss becomes a fail-closed, automatically recoverable startup
  condition while Kafka still contains the live retention window.
- A Gateway restart scans Session cursor metadata, so startup cost grows with
  Sessions that still have a live suffix. This is bounded by paging and
  concurrent Valkey reads and is observable separately from steady-state
  projection.
- Recovery cannot manufacture events after Kafka retention has expired; the
  Gateway refuses readiness and reports the unresolved streams.
- The direct PostgreSQL endpoint is now part of Event Gateway's recovery
  contract as well as its notification contract.
