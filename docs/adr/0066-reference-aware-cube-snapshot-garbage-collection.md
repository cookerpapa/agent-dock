# ADR-0066: reference-aware Cube snapshot garbage collection

Status: accepted

## Context

ADR-0064 makes an immutable Cube snapshot the physical data behind an ordinary
Workspace version. A snapshot can outlive the Run that created it. Failures
between Cube snapshot creation, object upload and the PostgreSQL Workspace
version commit can therefore leave an unreferenced snapshot behind.

Blind age-based deletion is unsafe. PostgreSQL stores the Artifact rows and
Workspace-version graph, while MinIO stores the immutable checkpoint envelope
that contains the Cube snapshot ID. Neither Cube's snapshot catalog nor object
age alone proves that a snapshot is unreferenced.

## Decision

AgentDock uses a fail-closed mark-and-sweep protocol:

1. The Control Plane lists every retained `workspace_snapshot` Artifact.
2. It downloads every object from MinIO and verifies the recorded byte length,
   SHA-256 digest and checkpoint tenant binding.
3. Portable checkpoints are ignored; all Cube snapshot IDs are deduplicated
   into the complete retained reference set.
4. A separate GC-only credential sends that set to the Sandbox Manager.
5. The Manager lists Cube's snapshot catalog and fails the entire scan if any
   retained reference is absent.
6. Only snapshots with exactly one AgentDock-owned `adws-<48 hex>` name are
   candidates. Base templates and unknown snapshots are never touched.
7. A candidate must remain unreferenced across at least two distinct scans and
   for at least 24 hours. Candidate state is atomically persisted outside the
   container.
8. Deletion is bounded per scan and Cube's idempotent delete endpoint is used.

The materializer, ordinary Sandbox Manager and snapshot GC use three different
bearer credentials. The GC credential cannot create a Tool Sandbox or read a
historical file.

## Failure semantics

- Missing, corrupt, oversized or tenant-mismatched MinIO data means no GC
  request is sent.
- A PostgreSQL reference to a missing Cube snapshot aborts the scan before any
  candidate state or deletion is changed.
- A Manager restart retains the observation clock in its private runtime state.
- Repeated delivery of the same `scanId` returns the persisted result without
  increasing the observation count.
- Deletion is disabled unless deployment configuration explicitly enables it.
- The current protocol is bounded to 10,000 retained Cube references. Exceeding
  the bound disables collection instead of truncating the mark set.

This protocol reclaims failed/uncommitted snapshots. It does not itself define
a Workspace-version retention policy; all Artifact rows that remain in
PostgreSQL are treated as live.

## Consequences

The ordinary production backup must include the private Sandbox Manager GC
state directory. Snapshot GC does not make Cube data portable or replicated.
Node-loss recovery remains unavailable until ADR-0064's streaming exporter or a
coordinated Cube data mover has passed a restore-to-empty-node drill.
