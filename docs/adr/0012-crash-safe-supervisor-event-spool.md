# ADR-0012: Crash-safe supervisor event spool and restart replay

- Status: Superseded by ADR-0076
- Date: 2026-07-19

## Context

ADR-0003 requires the sandbox supervisor to retain every `event.publish` until
the control plane durably commits the event and returns a cumulative ACK.
ADR-0008 implements that ACK boundary in PostgreSQL, but the current supervisor
uses `InMemoryEventSpool`. A supervisor process crash can therefore erase the
only delivery copy of an event that Pi already produced.

There are two important crash windows. The supervisor can stop after locally
accepting an event but before the control plane receives it, or the control
plane can commit the event while the returning ACK is lost. The second case
must be recovered as an exact duplicate, including after terminal settlement
has released the lease. PostgreSQL already supports that read-only duplicate
proof.

This problem is event-delivery recovery, not arbitrary tool-execution recovery.
A crash while a shell command is running remains ambiguous and must not be
described as exactly once.

## Decision

1. The supervisor gains a replaceable event-spool boundary. The default unit
   implementation remains in memory; the durable local implementation stores
   data under a supervisor-owned private directory on a persistent host volume.
2. Each execution assignment has one spool directory addressed by a SHA-256
   digest of session, lease, and fencing identity. A closed manifest records
   that immutable identity, the cumulative durable ACK cursor, and configured
   capacity. It never contains prompts, credentials, Pi JSONL, or workspace
   bytes.
3. Each pending `event.publish` is stored as one closed-schema canonical JSON
   envelope with an explicit SHA-256 digest, named by its decimal session
   sequence. Publication uses a private
   temporary file, file sync, atomic no-overwrite link, and directory sync.
   The supervisor may call the transport only after this operation completes.
4. ACK handling first atomically replaces and syncs the manifest with the new
   cumulative cursor, then deletes event files covered by that cursor. A crash
   before deletion can only cause safe duplicate replay. A crash before the
   manifest replacement leaves the old cursor and delivery copies intact.
5. Opening a spool validates its manifest, assignment identity, contiguous
   pending suffix, file names, closed wire schema, hashes implied by the exact
   bytes, and configured bounds. Symlinks, special files, unknown durable
   entries, sequence gaps, conflicting duplicates, malformed JSON, and ACK
   regression fail closed.
6. A fresh supervisor instance scans durable spool directories before normal
   recovery completes. It republishes each pending suffix in session order and
   applies only matching cumulative ACKs. An exact event already committed in
   PostgreSQL is re-ACKed without creating a second row. A stale or corrupt
   spool is retained for reconciliation rather than silently discarded.
7. The first implementation assumes one trusted supervisor process owns a
   spool root at a time. It is not a shared network filesystem coordination
   protocol and does not replace command leases or fencing. Production must
   give each supervisor identity its own persistent volume.
8. Empty acknowledged manifests are retained in this slice so a reopened
   assignment preserves its high-water mark. Bounded garbage collection may
   remove them only after the control plane proves the assignment terminal.
9. Restart replay guarantees delivery of events that were durably appended to
   the spool. It does not restart Pi, resume an in-flight tool, recreate process
   memory, or settle an acknowledged command whose execution outcome is
   unknown. Those require runner/lease reconciliation.

## Consequences

- A supervisor process restart no longer loses an event merely because its
  control-plane ACK was absent or lost.
- Disk persistence and sync latency are added to every public event before
  transport. This is intentional because the event copy is the recovery
  authority until PostgreSQL ACKs it.
- File-per-event storage is simple to inspect and crash-test but is not intended
  for unbounded high-throughput telemetry. The bounded agent event stream can
  later move behind the same spool interface if measurements justify a log
  database.
- PostgreSQL remains the durable event authority after ACK; the local spool is
  only an at-least-once delivery copy.
- Mid-tool side effects remain explicitly ambiguous.

## Rejected alternatives

### Keep the spool only in memory and rely on Pi JSONL

Pi JSONL is conversation authority, not the AgentDock public event log. It does
not reproduce exact event IDs, sequence numbers, delivery identity, tool
boundaries, or browser-visible ordering after a crash.

### Write supervisor events directly to PostgreSQL

That would couple an execution-side component to control-plane storage and
bypass the versioned supervisor transport, lease validation, and ACK boundary.

### Introduce Kafka or Redis Streams

The current bounded single-supervisor workload does not demonstrate a need for
another distributed service. A private durable directory is sufficient to
prove the required crash windows without changing the public semantics.

### Delete event files before persisting the ACK cursor

A crash between those operations could erase the only local copy while leaving
the manifest unable to prove what PostgreSQL acknowledged.
