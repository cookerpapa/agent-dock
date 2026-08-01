# ADR-0076: Append-only Worker event WAL

## Status

Accepted. Supersedes the original file-per-event storage layout while
preserving its delivery semantics.

## Context

Every browser-visible Agent event must be durable before it is published to the
Control Plane. The original Worker spool implemented that invariant with one
fsynced file per event plus a separately replaced manifest. It was easy to
inspect but produced hundreds of files for a normal streamed response and
required an atomic create, file sync, directory sync and later unlink for each
event.

A zero-model benchmark of 500 events measured 74.4 durable appends per second
and a 40.0 ms cumulative ACK on the development host.

## Decision

1. Each Run assignment owns one private append-only WAL named by the SHA-256 of
   its Session, lease and fencing identity.
2. The first checksummed record fixes that identity, the starting cumulative
   ACK cursor and bounded event/byte capacity.
3. Every event and cumulative ACK is a closed-schema, checksummed JSON record.
   An append is acknowledged to the producer only after the WAL file is
   synced.
4. Recovery verifies the assignment, checksums, exact wire schema, contiguous
   sequence and cumulative ACK history. Complete corrupt records fail closed.
5. A final incomplete crash tail is truncated to the previous newline. It was
   never acknowledged as a durable append and therefore is not replayed.
6. ACKed records remain safe duplicate history until compaction. Compaction
   atomically replaces the WAL with its current assignment head and pending
   suffix.
7. A permanent stale-fence rejection is first appended and synced, then the
   whole WAL is atomically moved to the quarantine directory. Recovery of the
   crash window between those operations quarantines without redelivery.
8. PostgreSQL remains the durable public event authority after cumulative ACK.
   The Worker WAL remains an at-least-once delivery copy, not a Tool
   exactly-once mechanism.

The layout deliberately uses ordinary files rather than adding SQLite, Kafka
or Redis. Node 24's built-in SQLite API is still experimental in this runtime,
and another external service is unnecessary for a private per-Worker log.

## Consequences

- The same-host benchmark now measures 153.1 durable appends per second and a
  24.3 ms cumulative ACK.
- A drained assignment retains one WAL file instead of a manifest directory
  and one file per event.
- The codec/storage primitives and spool state machine are separate modules.
- Existing pre-release file-per-event volumes are not read. Compose uses new
  named volumes; a Kubernetes development upgrade must drain Workers and
  recreate their spool PVCs.
- The WAL still fsyncs each event because weakening visible-event durability is
  outside this optimization.
