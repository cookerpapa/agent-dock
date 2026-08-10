# ADR-0091: Kafka-first Worker Event Ingest

## Status

Implemented on 2026-08-10. This ADR supersedes only the PostgreSQL transfer
Outbox portion of ADR-0089; its Cell, ordering, projection and terminal-barrier
decisions remain in force.
ADR-0093 supersedes this ADR's PostgreSQL replay-sink and self-hosted-mode
details; the Kafka-first acceptance boundary remains current.

## Context

The first enterprise event path accepted a Worker batch into a PostgreSQL
payload Outbox, acknowledged the Worker, copied the same payload into Kafka,
then projected it into PostgreSQL `session_events`. That was a conventional
transactional-Outbox design, but there was no business-state mutation that had
to be atomically coupled to the high-frequency payload. It therefore stored
the payload in PostgreSQL twice and made Event Gateway replicas poll and claim
transfer rows before Kafka could provide partitioning and backpressure.

The Worker already has a private append-only WAL and removes an event suffix
only after a cumulative durable acknowledgement. Kafka can therefore be the
first shared durability boundary without giving Kafka credentials to the Pi
Worker or Cube guest.

## Decision

The enterprise path is:

```text
Worker local WAL
  -> authenticated internal Event Gateway ingest
  -> idempotent Kafka producer (`acks=all`, Session ID key)
  -> cumulative Worker ACK
  -> Kafka projector consumer group
  -> Valkey live replay append
  -> one PostgreSQL transaction: projected cursor + Kafka offset
  -> resumable SSE
```

1. Pi Workers call an AgentDock-owned HTTPS ingest contract. Only Event Gateway
   receives the topic-scoped Kafka producer/consumer credential.
2. The ingest transaction retains only bounded Session sequence/fence cursors.
   It holds the relevant cursor lock until Kafka acknowledges the append, then
   advances the lightweight cursor and returns a cumulative ACK. It does not
   store an event payload transfer row.
3. The Kafka projector writes the contiguous live range to Valkey, then stores
   its consumed partition offset with `last_projected_seq` in PostgreSQL. It
   commits Kafka's group offset only after that transaction succeeds.
4. A lost HTTP response can append the same suffix again. Projection is
   idempotent by Session sequence and exact event content; a conflicting
   redelivery fails closed.
5. Terminal settlement continues to wait until `last_projected_seq` equals the
   acknowledged durable cursor. Kafka-only records never reach SSE.
6. Both production profiles use this path. Only deterministic tests retain the
   direct PostgreSQL adapter.

## Failure semantics

- Kafka unavailable: ingest returns retryable failure and the Worker retains
  its WAL suffix. Producer request and delivery timeouts bound the held lock.
- ACK lost after Kafka append: the Worker retries; duplicate Kafka records are
  harmless at projection.
- Projector unavailable: Kafka retains the record, the persisted/projected
  cursor gap is observable, and terminal settlement waits.
- Projector crashes after Valkey or PostgreSQL commit but before Kafka offset
  commit: the record is redelivered and exact sequence/content checks make the
  replay idempotent.
- PostgreSQL unavailable during projection: the Kafka group offset is not
  committed, so a replacement projector retries the record.

This is at-least-once transport with idempotent effects. It does not claim
exactly-once execution for arbitrary Tools.

## Consequences

- `worker_event_outbox` and its raw payload copy are removed from the current
  schema.
- PostgreSQL remains the authority for product state, terminal Turns and replay
  cursors, but not a raw Worker-event transport or replay-payload store.
- Event Gateway is now both the authenticated write gateway and the resumable
  read gateway for the enterprise event plane; it scales from Kafka consumer
  lag and CPU.
- Holding a Session cursor lock across the bounded Kafka append trades a short
  critical section for a much smaller implementation and prevents a projector
  from overtaking the cursor commit. The Kafka client timeouts bound this cost.

## Evidence

- [Enterprise event-pipeline acceptance](../reports/enterprise-event-pipeline-acceptance-latest.json)
- [Kafka transport acceptance](../reports/kafka-worker-event-acceptance-latest.md)

The first report uses real PostgreSQL and a real Kafka broker and exercises
authenticated ingest, projector downtime/restart, duplicate projection,
terminal ordering and schema removal. It is a single-node functional
acceptance, not multi-broker HA evidence.

## References

- <https://kafka.apache.org/40/configuration/producer-configs/>
- <https://kafka.apache.org/40/configuration/consumer-configs/>
- <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>
