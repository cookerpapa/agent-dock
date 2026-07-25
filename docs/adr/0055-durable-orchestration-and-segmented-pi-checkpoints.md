# ADR-0055: Mature orchestration adoption and segmented Pi checkpoints

- Status: accepted
- Date: 2026-07-25
- Extends: ADR-0054

## Context

ADR-0054 removed fixed single-Worker assumptions and proved cross-Worker Pi
JSONL recovery. AgentDock still owns a substantial PostgreSQL dispatcher,
outbound Worker transport, retry, heartbeat, cancellation, and reconciliation
implementation. Reimplementing every general durable-workflow capability would
violate the project's new adopt-before-build policy if a mature framework can
preserve the required security and correctness boundaries.

The v1 conversation checkpoint uploads a complete Pi JSONL file after every
settled Run. This is correct and self-contained, but duplicates an increasing
prefix. Pi's documented format is an append-only tree log, including native
compaction entries, so an incremental representation can preserve exact bytes.

## Decision

1. AgentDock adopts the repository-level adopt-before-build policy in
   `AGENTS.md`. Established-company or foundation-backed open source is
   preferred after requirements, license, maintenance, security, operational
   cost, and exit strategy are evaluated.
2. Temporal is the preferred target for post-admission durable Run
   orchestration. It is not added to production until a separate TypeScript
   spike passes the parity, fault, security, performance, backup, upgrade, and
   rollback gate in the accompanying research.
3. There must be no dual orchestration authority. Until cutover, the existing
   PostgreSQL Run/Attempt dispatcher is authoritative. After cutover, Temporal
   owns post-admission Workflow/Activity progress and the superseded matching
   path is removed.
4. The target mapping is one bounded Temporal Workflow per AgentDock Run.
   PostgreSQL continues to own the accepted Turn, same-Session mailbox order,
   tenant admission/fairness, public resources, semantic projections, usage,
   and committed checkpoint references.
5. A Temporal Activity attempt maps to an AgentDock RunAttempt with a newer
   fence. Temporal's retry facilities never imply exactly-once Tool, model, or
   GitHub side effects. Unsafe ambiguous work remains non-blindly-retryable.
6. Temporal history may contain only bounded identifiers, hashes, policy
   versions, status, and immutable references. Prompt text, model deltas, Pi
   JSONL, Tool output, Workspace bytes, and credentials remain in the existing
   PostgreSQL/S3 authorities.
7. Pi JSONL remains the native conversation authority. A v2 checkpoint will use
   tenant/session-scoped, line-aligned, SHA-256-addressed immutable segments plus
   an immutable manifest containing the ordered segment list and whole-session
   digest.
8. The PostgreSQL checkpoint-head update remains a fenced base-revision CAS in
   the terminal commit transaction. S3 conditional creation/checksums prevent
   accidental replacement; orphan segments/manifests are reclaimed only after
   a grace period.
9. Restore verifies every segment and the complete reconstructed digest before
   starting Pi. A non-append Pi output creates an explicit new base/rebase
   manifest. AgentDock never silently derives native state from Web
   conversation projections.
10. Periodic segment consolidation is driven by measured restore latency/object
    count. It does not alter the logical Session or Pi compaction semantics.

## Consequences

- Mature durable-workflow machinery can eventually replace custom matching,
  Worker polling, retry timers, and orchestration replay without replacing
  AgentDock's tenant policy or safety fences.
- Temporal adds a distributed service, schema, deterministic-code/versioning
  discipline, and operational burden. The acceptance gate prevents an
  architecture-only dependency.
- The v2 Pi format changes physical checkpoint storage, not Pi's logical
  Session format or public APIs.
- Stored transcript bytes approach the size of the append-only Session plus
  bounded manifest overhead rather than repeated complete prefixes.
- Restore may issue multiple object reads; consolidation, streaming, and Worker
  caches are performance optimizations.
- PostgreSQL, S3-compatible storage, Pi, Temporal, Kubernetes, and Cube each
  have one explicit responsibility. None becomes a universal state store.

## Evidence required before implementation claims

- Temporal spike and migration gate described in
  `docs/research/2026-07-25-durable-orchestration-and-conversation-storage.md`;
- v1/v2 checkpoint compatibility and byte-identical restore;
- native Pi branch/compaction recovery through a v2 manifest;
- prefix-mismatch rebase and corrupt/missing/reordered segment rejection;
- stale fence/base revision cannot publish a new head;
- concurrent idempotent segment upload and orphan GC;
- measured stored bytes, restore requests, p50/p95 restore latency, and
  whole-file-vs-segment comparison.
