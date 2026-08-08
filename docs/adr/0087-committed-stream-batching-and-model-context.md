# ADR-0087: Committed stream batching and model context

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0002, ADR-0070, ADR-0076 and ADR-0079

## Context

AgentDock has two non-negotiable streaming invariants:

1. the browser may display an Agent event only after PostgreSQL has committed
   it; and
2. public text and Tool facts that survived a crash must affect the next Pi
   model context.

Persisting every provider token as a separate synchronous transaction would
multiply rows, SQL round trips, indexes, WAL records and notifications. With
many concurrent Sessions this creates transaction overhead and lock/connection
pressure even before storage throughput is exhausted. Weakening PostgreSQL
durability or streaming from Worker memory would violate the first invariant.

The implementation survey found three useful mature patterns:

- PostgreSQL recommends multi-row writes in one transaction and natively lets
  concurrent commits share WAL flush work (group commit). Asynchronous commit
  may lose recently acknowledged transactions and is therefore unsuitable for
  browser-visible events:
  <https://www.postgresql.org/docs/16/wal-configuration.html> and
  <https://www.postgresql.org/docs/15/wal-async-commit.html>.
- Kafka and NATS JetStream provide producer batching, acknowledgement and
  deduplication, but adopting either would create a second offset, retention and
  replay authority beside the existing PostgreSQL Session event log:
  <https://kafka.apache.org/documentation/#producerconfigs> and
  <https://docs.nats.io/nats-concepts/jetstream>.
- Pi's native Session JSONL and `buildSessionContext()` own conversation-tree,
  custom-message and Compaction semantics. Rebuilding an independent
  application `messages[]` would fork that authority:
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md>
  and
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md>.

## Decision

### Produce fewer logical events

1. The first assistant text delta is flushed immediately for first-token
   latency. Consecutive deltas for the same Pi content block are then coalesced
   for at most 50 ms or 2 KiB.
2. Tool boundaries, message completion, Turn settlement, errors and cancellation
   flush pending text immediately. Text, thinking and Tool blocks are never
   merged across semantic boundaries.
3. Raw thinking is not part of the public durable conversation.

### Decouple production from remote commit

4. Every coalesced logical event is first fsynced to the private Worker
   append-only WAL. Pi event production then enters a bounded asynchronous
   publisher rather than waiting for one remote transaction per event.
5. The publisher sends a contiguous batch after at most 20 ms, 64 events or
   512 KiB and receives one cumulative ACK. Bounded event/byte limits apply
   backpressure if PostgreSQL cannot keep up.
6. PostgreSQL ingests the new contiguous suffix using one multi-row insert,
   one cursor update and one Session update inside one synchronous transaction.
   An exact redelivery prefix is checked in bulk and does not create duplicates.
7. Batching remains per Run assignment so one tenant cannot reorder another
   Session's causal stream. PostgreSQL's native group commit shares WAL flushes
   among concurrent Session transactions; AgentDock does not add a process-local
   cross-tenant durability coordinator.
8. `synchronous_commit` stays enabled for this path. `NOTIFY` carries only a
   high-water hint after commit; the event table is the source of truth.

### Make committed visibility recoverable and model-visible

9. SSE reads only committed PostgreSQL rows. `Last-Event-ID` resumes from the
   durable sequence, so a browser cannot observe Worker-WAL-only data.
10. The semantic Turn projection merges coalesced text and Tool events for
    conversation reads; it is derived from the append-only event rows and can
    be rebuilt.
11. On success and catchable interruption, Pi's native JSONL remains the model
    context authority and includes the assistant/Tool state Pi recorded.
12. If `SIGKILL`, OOM or node loss prevents Pi from writing a final Session
    entry, the next Worker converts only canonical PostgreSQL public semantics
    newer than the Pi checkpoint into one hidden Pi custom message. Running
    Tools become `unknown`; raw reasoning and internal Run identifiers are not
    reconstructed. Pi's `buildSessionContext()` includes this entry, and the
    next native checkpoint absorbs it once.

## Consequences

- Provider token frequency no longer equals PostgreSQL transaction frequency.
- A normal streamed Run produces at most roughly 20 text events per second
  before byte/semantic flushes, and several logical events can share one remote
  commit.
- One batch no longer repeats Session/Lease ownership queries and cursor updates
  for every event. A regression test proves a mixed redelivery/new suffix uses
  one event insert and one cursor/Session advance.
- A real Worker-process `SIGKILL` test proves that a locally fsynced, unacknowledged
  event is replayable. Browser visibility still begins only after PostgreSQL ACK.
- AgentDock does not maintain a parallel `messages[]`; it restores Pi JSONL and
  lets Pi construct the effective model messages, including the one-time durable
  recovery bridge.
- Kafka/NATS remain unnecessary until measured PostgreSQL saturation, independent
  stream consumers or retention requirements justify moving the event authority.

## Remaining capacity work

Measure active concurrent streams against PostgreSQL transaction rate, WAL
bytes, connection-pool wait and SSE lag. If row retention becomes material,
compact terminal high-frequency delta rows only after a canonical Pi checkpoint
and semantic projection are committed, while preserving the public sequence
high-water contract.
