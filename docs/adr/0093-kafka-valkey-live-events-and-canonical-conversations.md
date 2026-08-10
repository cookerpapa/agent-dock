# ADR-0093: Kafka/Valkey live events and canonical conversations

## Status

Accepted on 2026-08-10. It supersedes the raw-event storage part of the former
ADR-0092. ADR-0092 was removed because this repository does not maintain the
object-archive implementation as an alternate production path.

## Context

Streaming model and Tool output consists of many small deltas. Writing each
delta into PostgreSQL multiplies WAL, index, vacuum and backup traffic even
though normal conversation reads need only the completed semantic Turn. Sending
uncommitted deltas directly to the browser would reduce writes but violate the
product invariant that anything visible after reconnect was first accepted by
a durable shared component.

Pi's native Session JSONL is a separate concern. It remains the only authority
for reconstructing Pi model context and compaction state and continues to use
content-addressed S3 segments.

## Decision

The distributed and self-hosted production profiles use one event path:

```text
Pi Worker local WAL
  -> authenticated Event Gateway
  -> Kafka (acks=all, idempotent producer, Session key)
  -> projector consumer group
  -> Valkey Stream live read model
  -> PostgreSQL projected cursor + Kafka offset + NOTIFY
  -> resumable SSE
```

Kafka acknowledgement is the first shared durability boundary. Pi Workers do
not receive Kafka or Valkey credentials. The projector writes a contiguous
Session range into Valkey before advancing PostgreSQL's projected high-water
mark, and browser SSE never reads beyond that mark. Valkey writes use explicit
sequence IDs and reject gaps or conflicting redelivery. PostgreSQL NOTIFY is a
wake-up hint only; Event Gateway replicas read the acknowledged suffix from
Valkey and merge its one terminal event per Turn from PostgreSQL.

Before terminal settlement, the Control Plane asks the trusted Event Gateway to
reduce the fully projected current-Turn stream into one bounded canonical
transcript. The Run transaction revalidates the event cursor and atomically
commits:

- the terminal event;
- the complete conversation Turn projection;
- Pi and Workspace checkpoint pointers;
- Run/Attempt terminal state and sequence cursors.

PostgreSQL therefore stores business state and complete terminal projections,
not text/tool deltas. It may store bounded semantic metadata such as test and
compaction records, but not a second raw stream.

After a terminal projection has remained available for the configured live
window, a reconcilable compactor trims Valkey through that terminal sequence
and advances PostgreSQL's replay floor. An older `Last-Event-ID` receives HTTP
410 and reloads canonical conversation Turns. Kafka retention exceeds the live
window and remains the source for rebuilding a lost Valkey read model. Missing
live sequences fail SSE and terminal projection explicitly; they are never
silently skipped.

The deterministic local test adapter may retain PostgreSQL-only raw events. It
is not used by either production deployment profile.

## Failure semantics

- Kafka unavailable: no cumulative Worker ACK; the Worker retains its WAL.
- Projector or Valkey unavailable: Kafka continues to retain accepted batches,
  but projected high-water and SSE visibility stop.
- Projector crashes after Valkey append: exact replay is deduplicated, then the
  PostgreSQL cursor/offset transaction advances.
- PostgreSQL commit fails after Valkey append: the same Kafka record is
  redelivered and validated before retrying the cursor transaction.
- Terminal projection observes lag or a gap: settlement waits/fails closed and
  cannot publish a partial canonical Turn.
- Valkey data is lost: SSE returns unavailable until the read model is rebuilt
  from retained Kafka records; canonical completed conversations remain in
  PostgreSQL.

## Consequences

- PostgreSQL payload growth follows completed Turns rather than token count.
- Stream batching reduces Kafka, Valkey and Worker WAL operations without
  exposing uncommitted bytes; the first delta is still flushed eagerly and
  subsequent deltas use a short bounded coalescing interval.
- Live replay now depends on Kafka and Valkey availability, while completed
  conversation reads remain available from PostgreSQL.
- Kafka/Valkey require explicit retention, persistence, capacity and recovery
  operations. Enterprise Kafka remains replicated; the single-host Compose
  profile is functional, not an HA claim.
