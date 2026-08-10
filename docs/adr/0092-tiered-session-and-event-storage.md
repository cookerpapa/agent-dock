# ADR-0092: Tiered Pi Session and event storage

## Status

Accepted on 2026-08-10.

## Context

Long-running coding conversations produce two different data classes:

- Pi's native `session.jsonl`, which is the only accurate source for restoring
  the Agent Session tree and compaction state;
- fine-grained streaming events, which support live/resumable SSE but become
  redundant for ordinary conversation reads after a terminal semantic
  projection has committed.

Keeping either class as an ever-growing PostgreSQL payload would make database
WAL, backup, vacuum and index cost scale with raw conversation volume. A local
usage sample also contained individual Pi Sessions larger than the former 2 MiB
checkpoint envelope, including one hundreds-of-megabytes Session.

## Decision

PostgreSQL remains authoritative for business state, monotonic sequence
cursors, semantic conversation projections and immutable object metadata. Raw
Pi Session and cold event bytes live in S3-compatible object storage.

Pi checkpoints use the v3 manifest format. The Worker compresses the native
JSONL into content-addressed gzip segments with an 8 MiB uncompressed target.
An append-only save reuses prior complete segment descriptors after hashing the
current prefix and uploads only the new bounded trailing chunk; restore fetches
at most four bounded objects concurrently and validates both stored and
reconstructed hashes. The
logical Session limit is 512 MiB. Existing v2 manifests remain read-only so an
occupied deployment can migrate when the next checkpoint is written; no new v2
objects are produced.

`session_events` is a hot replay table, not permanent conversation storage.
After a terminal Turn has a committed semantic projection and exceeds the
configured hot window, a retention Worker:

1. claims the next contiguous Session prefix in PostgreSQL;
2. serializes the exact internal rows to a gzip NDJSON archive;
3. uploads an immutable content-addressed object;
4. atomically commits archive metadata, advances `replay_floor_seq` and removes
   the archived hot rows and unreferenced global event identities.

The default hot window is 14 days. A stale SSE cursor below the replay floor
receives HTTP 410 and reloads the complete semantic conversation projection;
recent and active cursors retain normal exact SSE replay. Multiple retention
replicas coordinate through row claims, so no external scheduler is required.

The existing Session-hash partitioning remains. Current interactive access is
always keyed by `session_id + seq`, and small terminal prefixes are removed
continuously. Leaf partitions use lower autovacuum thresholds to reclaim dead
tuples. Time-root repartitioning or `pg_partman` is deferred until measured
vacuum/retention cost justifies changing this access path. `pg_partman` can
automate partition DDL and partition retention, but cannot enforce AgentDock's
projection-plus-object-archive gate by itself.

## Consequences

- PostgreSQL growth follows active/recent event traffic and compact semantic
  projections rather than lifetime raw transcript volume.
- Object storage becomes part of conversation disaster recovery and must use
  lifecycle/versioning/replication policies appropriate to the deployment.
- Historical raw event inspection requires the archive reader or an offline
  analytics path; the product conversation UI remains available from semantic
  projections.
- Expiration of an old SSE cursor is explicit rather than silently returning an
  incomplete suffix.
- Large individual Session restore remains bounded per object and concurrency,
  but a near-512-MiB native Session is still expensive and Pi compaction remains
  the primary context-size control.
