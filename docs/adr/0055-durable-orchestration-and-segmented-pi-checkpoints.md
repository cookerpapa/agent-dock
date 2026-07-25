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
2. Temporal is the preferred mature candidate if post-admission Run
   orchestration outgrows the current bounded protocol. The pinned TypeScript
   spike proves Task Queue distribution, heartbeat retry, cancellation,
   Worker/service recovery, bounded history, and duplicate Workflow-ID
   rejection. It also shows that the current Run maps almost entirely to one
   long Pi Activity, so Temporal does not yet remove enough application
   protocol to justify another production service and consistency boundary.
   Production adoption is deferred rather than assumed.
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
7. Pi JSONL remains the native conversation authority. The v2 checkpoint uses
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
10. Segment chains consolidate after 32 segments. This is a physical
    representation change only and does not alter the logical Session or Pi
    compaction semantics.
11. Production Pi execution uses the direct SDK inside a capacity-one,
    replaceable Supervisor Host. Every Run creates and disposes one
    `AgentSessionRuntime`, but no longer creates an operating-system process.
    Model credentials and remote-tool activation capabilities are
    activation-local in-memory objects rather than process environment
    variables. A failed cooperative abort or runtime disposal poisons and
    retires the whole Worker boot; a peer Worker restores the committed native
    Pi checkpoint under a newer Attempt/fence. Horizontal capacity comes from
    more Worker processes, never concurrent tenant activations inside one SDK
    Worker.
12. The pinned RPC runner remains a compatibility and fault-test adapter, not
    the production execution path. The measured reason for the switch is a
    direct SDK activation p50 of 5.61 ms versus 630.60 ms for a fresh RPC child
    through `get_state`, while capacity-one Worker replacement retains a
    process-level crash boundary between simultaneously active Sessions.

## Consequences

- Mature durable-workflow machinery can eventually replace custom matching,
  Worker polling, retry timers, and orchestration replay without replacing
  AgentDock's tenant policy or safety fences.
- The present PostgreSQL dispatcher remains the sole production authority;
  Temporal is retained as executable migration evidence, not a dormant second
  scheduler.
- Temporal adds a distributed service, schema, deterministic-code/versioning
  discipline, and operational burden. The acceptance gate prevents an
  architecture-only dependency.
- The v2 Pi format changes physical checkpoint storage, not Pi's logical
  Session format or public APIs.
- A cold Session consumes no `AgentSession`. An active Run consumes one SDK
  activation in one capacity-one Worker. A Worker crash can fail that Run, but
  cannot corrupt another concurrently active tenant because no second
  activation is admitted to that process.
- Stored transcript bytes approach the size of the append-only Session plus
  bounded manifest overhead rather than repeated complete prefixes.
- Restore may issue multiple object reads; consolidation, streaming, and Worker
  caches are performance optimizations.
- PostgreSQL, S3-compatible storage, Pi, Temporal, Kubernetes, and Cube each
  have one explicit responsibility. None becomes a universal state store.

## Evidence

- Temporal spike and migration gate described in
  `docs/research/2026-07-25-durable-orchestration-and-conversation-storage.md`;
- zero-token Temporal fault probe: two Workers, killed-Worker retry with fence
  100 to 101, cancellation cleanup, duplicate-ID rejection, service restart,
  and no raw prompt/credential in Event History;
- v1/v2 checkpoint compatibility, append/rebase, byte-identical restore,
  corrupt/missing/reordered segment rejection, S3 conditional-create
  collision validation, and existing fenced base-revision commit tests;
- 120-turn local storage benchmark: 33,897,660 v1 cumulative bytes versus
  1,439,612 v2 segment/manifest bytes, a 95.75% reduction; final 560,167-byte
  session restored byte-identically from 26 segments, with local in-memory
  p50/p95 reconstruction of 6.185/11.807 ms;
- zero-token Pi runtime benchmark: direct SDK activation p50/p95 5.61/6.99 ms
  versus fresh RPC process readiness p50/p95 630.60/673.17 ms.
- direct SDK integration tests: stream/event parity, activation-local
  credential isolation, cooperative cancellation, byte-identical JSONL
  rehydration and threshold compaction across fresh activations.

Still required before a Temporal cutover or a claim of complete retention
operations: a real Pi/Tool Activity comparison, production backup/upgrade and
rollback drill, S3-network restore latency, grace-period orphan collection, and
native compact/branch restoration through the production v2 object path.
