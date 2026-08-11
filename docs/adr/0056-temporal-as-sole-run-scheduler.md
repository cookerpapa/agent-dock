# ADR-0056: Temporal as the sole post-admission Run scheduler

- Status: accepted
- Date: 2026-07-25
- Supersedes ADR-0054's production PostgreSQL-to-Supervisor matching path.

## Context

The horizontal Pi Worker pool proved that Pi SDK activations can be recovered
from native JSONL checkpoints on any trusted Worker. Its production dispatcher
still combined five concerns in one polling loop: selecting an eligible
outbox row, enforcing mailbox and tenant policy, creating a fenced RunAttempt,
choosing one live Supervisor connection, and executing the Run.

Temporal's pinned spike proved durable Task Queue distribution, Activity
heartbeats, cancellation delivery, Worker loss detection, bounded history,
Workflow-ID idempotency, and service restart. The project owner has now chosen
to accept the additional production service and operational boundary.

Adding Temporal in front of the existing connection matcher would create two
schedulers and make ownership, retries, cancellation, and capacity impossible
to reason about. The cutover therefore has to move Task assignment all the way
to the trusted Pi Worker process.

## Decision

1. Temporal is the sole production authority for post-admission Run scheduling,
   Task Queue matching, Worker distribution, Workflow retry timers, Activity
   heartbeat timeout, and Workflow cancellation delivery.
2. PostgreSQL remains authoritative for transactional request acceptance,
   same-Session mailbox position, tenant quotas, Run/RunAttempt state,
   leases/fences, events, usage, semantic projections, and committed checkpoint
   references. These are application invariants, not a second Worker matcher.
3. The transactional outbox is relayed to one deterministic Workflow ID per
   Run. The relay may start or cancel that exact Workflow; it cannot select a
   Pi Worker. Duplicate relay delivery uses Temporal's `USE_EXISTING` conflict
   policy.
4. Every trusted Supervisor Host registers a Temporal Worker on the common
   `agent-dock-pi-runs-v1` Task Queue. Its maximum concurrent Activity count is
   exactly its configured Pi SDK capacity. Temporal therefore assigns an
   Activity directly to the process that runs the Agent Loop.
5. A Run Workflow carries only `tenantId`, `sessionId`, `runId`, `commandId`,
   schema version, and bounded scheduling metadata. Prompt text, `messages[]`,
   Pi JSONL, model/tool output, credentials, and Workspace bytes are forbidden
   from Workflow history.
6. The Run Activity reads the complete immutable request snapshot from
   PostgreSQL, creates the next RunAttempt, obtains a monotonic fence, restores
   native Pi state, and invokes the existing trusted Pi SDK adapter. Tool Calls
   continue through authenticated Tool RPC to CubeSandbox microVMs.
7. Same-Session FIFO and tenant concurrency remain guarded by exact
   PostgreSQL eligibility checks. An ineligible exact command returns a bounded
   defer result; the Workflow uses a durable timer before asking the Task Queue
   again. Temporal priority fairness uses the tenant UUID as `fairnessKey`.
8. Temporal Activity retry does not make model, Bash, GitHub, or checkpoint
   side effects exactly once. Existing Tool IDs, RunAttempt fences, checkpoint
   CAS, terminal-event validation, and ambiguous-after-start failure policy
   remain mandatory.
9. User cancellation first creates the existing durable cancellation command.
   The outbox relay cancels the exact Workflow. Temporal delivers cancellation
   to the Worker that owns the running Activity through heartbeats; that Worker
   invokes the exact cancellation dispatcher against its in-memory Pi
   activation and persists the existing cancellation lifecycle.
10. The Supervisor WebSocket remains an authenticated boot/liveness,
    management, and ownership channel. It advertises
    `acceptingAssignments=false`; production does not run its legacy
    PostgreSQL matching lanes.
11. Self-hosted Temporal Server 1.29.1 runs only on an internal Compose network
    and stores `temporal` plus `temporal_visibility` schemas in the existing
    PostgreSQL service. The encrypted cold backup already archives that entire
    PostgreSQL volume, so application and Workflow histories share one
    stop-the-world backup boundary.
12. Rollback is an operator deployment rollback, not a runtime flag: stop
    admission, drain Workers, stop the stack, restore the pre-cutover
    PostgreSQL/MinIO backup and pre-cutover image revision, then restart. The
    old matcher is never activated beside Temporal in one production
    deployment.

## Consequences

- A cold Session consumes neither a Pi runtime nor a Worker slot. Each active
  Activity consumes one bounded Pi SDK slot on exactly one Worker.
- Adding Supervisor replicas increases the number of Temporal Activity
  pollers; there is no Control Plane lane count to update.
- Pure chat and coding Runs use the same durable orchestration path, while
  CubeSandbox is created lazily only when Pi emits a Tool Call.
- Temporal becomes a production dependency with schema upgrades, retention,
  metrics, backup compatibility, and deterministic Workflow versioning
  obligations.
- PostgreSQL eligibility deferral can add small timer latency to later messages
  in the same Session, but it prevents concurrent Workspace writers without
  creating a Session-resident process.
- Temporal history is useful orchestration evidence but is not a conversation
  database and cannot restore Pi by itself.

## Required evidence

- deterministic outbox-to-Workflow replay without duplicate Run execution;
- multiple Worker replicas consuming one common Task Queue within their
  declared capacities;
- same-Session FIFO and cross-Session parallelism;
- tenant fairness keys and existing tenant concurrency limits;
- Workflow cancellation reaching the exact live Pi activation;
- Worker loss before ACK requeue and after-ACK ambiguity handling;
- fenced checkpoint commit, event replay, and native Pi compaction recovery;
- Temporal restart with queued and running Workflow history retained;
- a real-token multi-round Pi/CubeSandbox regression after the cutover.
