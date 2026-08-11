# ADR-0061: Capacity-aware Temporal Worker affinity

## Status

Accepted.

## Context

Every accepted AgentDock Run is a distinct Temporal Workflow. The Pi execution
Activity is currently matched from one common Task Queue, so a same-Session
follow-up can run on any healthy Pi Worker with an available slot. This is the durable
correctness path: PostgreSQL resolves the current checkpoint head and S3 stores
the Pi-native checkpoint, while a Worker-local ten-minute cache only avoids
re-reading immutable objects.

Temporal sticky queues do not solve this problem. They are internal
per-Worker queues for Workflow Tasks, not Activity Tasks. Temporal's official
TypeScript samples instead use a Worker-specific Activity Task Queue when later
Activities should prefer machine-local state.

Blindly pinning a Session to one Worker would violate the existing elasticity
and fairness goals. A busy or dead preferred Worker must not accumulate an
unbounded private backlog, and cache affinity must never become a conversation
or checkpoint authority.

## Decision

AgentDock adds a soft, capacity-aware affinity hint on top of Temporal's sole
scheduler:

1. After a Run commits successfully, the executing Worker records a
   boot-specific affinity on the Session. Its expiry is no longer than that
   Worker's immutable checkpoint-cache TTL.
2. Before starting a later Run Workflow, the outbox relay may reserve one slot
   on that exact Worker only when:
   - the affinity has not expired;
   - the same Worker boot still has an active registered connection;
   - its durable sandbox is ready or leased; and
   - `active_sessions + unclaimed affinity reservations` is below declared
     capacity.
3. The reservation and capacity check occur in one PostgreSQL transaction under
   the target sandbox row lock. Different Run commands cannot over-reserve one
   Worker from concurrent control-plane replicas.
4. A reserved Workflow first schedules its Pi Activity on the deterministic,
   boot-specific Worker Task Queue. The private queue uses a short
   Schedule-to-Start timeout and one scheduling attempt.
5. The target Worker polls both the common queue and its private queue, but both
   pollers share one in-process execution-slot counter. A private Activity must
   claim the exact reservation and exact Worker sandbox before it can enter the
   Pi execution path.
6. A stale reservation, a busy Worker, or a private Schedule-to-Start timeout
   produces no RunAttempt and immediately falls back to the common Task Queue.
   An Activity that may actually have started is not blindly rerouted.
7. PostgreSQL FIFO, tenant admission, RunAttempt, lease, fencing, checkpoint CAS
   and ambiguous-side-effect rules are revalidated after Temporal delivery and
   remain authoritative.

The affinity input contains only bounded UUIDs and a deterministic Task Queue
name. Prompt text, Pi JSONL, model/tool output, credentials and Workspace bytes
remain outside Temporal history.

## Failure behavior

- A Worker restart creates a new boot/sandbox identity and a new private Task
  Queue. The old connection or affinity fails validation.
- A Worker that becomes busy after reservation rejects the private route before
  touching the command; the Workflow uses the common queue.
- A dead private poller triggers Schedule-to-Start timeout and common-queue
  fallback.
- Expired reservations are ignored and reclaimed opportunistically.
- Correctness never depends on a cache hit. The selected Worker still resolves
  the PostgreSQL checkpoint head and verifies every immutable object digest.

## Consequences

- Hot same-Session follow-ups normally reuse the prior Worker's checkpoint
  objects.
- Shared-queue load balancing remains available whenever affinity would reduce
  throughput.
- Each Supervisor owns two Temporal pollers but still admits only its configured
  number of Pi SDK activations.
- PostgreSQL stores bounded routing hints and reservations, not another durable
  scheduler or Task Queue.
- The optimization adds observable affinity hit, busy-bypass, stale-bypass and
  timeout-fallback outcomes that must be covered by production acceptance.
