# ADR-0074: Runtime simplification and one orchestration authority

- Status: accepted
- Date: 2026-07-30
- Supersedes: ADR-0061 and the remaining PostgreSQL worker-matching portions
  of ADR-0056

## Context

AgentDock's production path is real, but several individually defensible
features accumulated faster than measured product needs. In particular:

- Temporal matches a long Run Activity to a Pi Worker, while the Activity then
  enters `OutboxDispatcher` for a second claim, fairness, retry and lease
  protocol;
- Worker affinity adds one private Task Queue per Worker plus PostgreSQL
  reservations even though immutable Pi checkpoints are small and any Worker
  can restore them;
- Pi checkpoints are split into content-addressed segments despite measured
  checkpoints being only a few KiB;
- optional experiments and a full telemetry stack are part of the default
  single-node topology.

The resulting system has more authorities and operational surfaces than the
current self-hosted product needs. This conflicts with the repository rule that
one concern must have one durable authority.

## Decision

1. Temporal is the only Run orchestration and Worker-matching authority.
   PostgreSQL remains the product database and external-side-effect fence, not
   a competing scheduler.
2. A transactional relay may deliver an accepted Run ID to Temporal, but it
   cannot select a Worker, implement fairness, own retry timers or issue a
   scheduling claim lease.
3. All Pi Workers poll one shared Activity Task Queue. Temporal's Worker slot
   count bounds concurrency and its tenant fairness key prevents starvation.
   Worker-specific Task Queues, affinity reservations and Session affinity
   columns are removed.
4. Exact Session/Workspace serialization moves into durable Temporal entity
   orchestration. Run Activities load bounded product state, execute Pi and
   commit projections; they do not poll the outbox for eligible work.
5. Temporal heartbeat and cancellation replace scheduling heartbeats and
   cancellation discovery loops. Monotonic Tool/Workspace fencing remains
   because an Activity retry can overlap an old process with ambiguous external
   side effects.
6. Pi native JSONL is stored as one immutable, checksummed object per committed
   checkpoint. The PostgreSQL head references that object. Segment manifests,
   object-segment caches and their compatibility paths are removed.
7. Candidate racing, GitHub delivery and advanced environment experiments are
   not started by the default deployment. Code without a current browser
   product loop is removed after its durable data is retired by an explicit
   migration.
8. The default profile contains the product-critical services only.
   Observability and development diagnostics move to explicit opt-in profiles.
9. Streaming durability remains a product invariant. Its implementation may
   use a bounded append-only WAL, but the browser continues to read only
   PostgreSQL-committed events.

## Consequences

- A cache miss may add a few milliseconds to Pi restore, but removes a
  reservation table, private queues and worker-routing failure modes.
- Temporal becomes visibly responsible for ordering, retry, cancellation and
  Worker distribution instead of merely wrapping the PostgreSQL dispatcher.
- PostgreSQL still stores Runs, attempts, messages, usage, events and committed
  checkpoint heads. Fencing/CAS remains at every external mutation boundary.
- Existing affinity data and segmented checkpoint metadata are intentionally
  incompatible and may be deleted during this pre-release refactor.
- Historical ADRs remain evidence of exploration; current architecture and
  deployment documentation describe only the simplified path.

## Acceptance

- two shared-queue Pi Workers execute different Workspaces concurrently;
- one Workspace executes accepted Runs serially without dispatcher polling;
- tenant fairness is visible in Temporal Task Queue evidence;
- Worker loss causes a Temporal Activity retry with a higher Tool fence;
- cancellation reaches the exact live Pi Activity through heartbeat;
- no Worker-specific Task Queue or affinity database state remains;
- Pi compact/restore is byte-identical through one immutable object;
- default production startup excludes experimental and optional telemetry
  services;
- real-token chat and Cube Tool Runs pass after the cutover.
