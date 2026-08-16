# ADR-0100: Bounded Sandbox and Workspace admission

## Status

Accepted on 2026-08-12.

## Context

Agent Run quotas alone do not bound execution-plane occupancy. A persistent or
warm Cube can outlive its creating Run, so one tenant can exhaust a shared
Sandbox Domain even while its concurrent-Run count is low. Workspace restore,
indexing and materialization are also I/O-heavy POSIX operations. A Volume
Gateway replica that accepts an unbounded number of these requests can exhaust
memory, subprocesses and storage throughput before Kubernetes adds capacity.

The solution must not introduce another durable scheduler. PostgreSQL remains
the Run, tenant, Sandbox and Workspace authority,
and PostgreSQL advisory locks remain the cross-replica per-volume exclusion
boundary.

## Decision

1. Every tenant runtime policy carries `maximum_active_sandboxes`. Reservation
   counts reserved, materializing, active, warm, cleaning and unknown
   activations across all Sandbox Domains. Unknown activations consume quota
   until reconciled because their physical Cube may still exist.
2. Domain capacity and tenant capacity are checked in the same PostgreSQL
   reservation transaction. The Domain row serializes Domain admission and the
   tenant policy row serializes that tenant across Domains.
3. Public-registration and bootstrap tenants receive separate defaults. The
   quota is configurable through the same administrative policy surface as Run
   quotas; no tenant identity is added to metric labels.
4. Each Workspace Volume Gateway replica uses the maintained `p-queue` package as a
   process-local execution gate. Concurrency, queued request count and queue
   wait are bounded. Queue-full and queue-timeout responses are retryable and
   do not begin Volume I/O.
5. The local queue is not durable and performs no distributed ownership. A
   request admitted by another replica still uses the PostgreSQL volume lock,
   fencing and Workspace-head CAS before it can commit an effect.
6. Volume Gateway active, waiting, limit, wait, duration and rejection metrics are
   exported without tenant labels. The ordered default budgets are 30 seconds
   for queue admission, 600 seconds for Volume I/O, 660 seconds for the internal
   HTTP request and 720 seconds for process termination grace.

## Consequences

- A tenant cannot retain every Cube in a shared Domain merely by selecting
  persistent Sessions.
- Unknown owner-loss state fails capacity closed until orphan reconciliation
  confirms and removes the old runtime.
- Storage overload becomes explicit backpressure instead of unbounded local
  work and cascading timeouts.
- Volume Gateway replicas can still scale horizontally; the local limit is tuned
  against each replica's CPU, memory and storage bandwidth.
- A retryable rejection can delay Workspace restore/checkpoint, but it cannot
  weaken fencing or create a second Workspace authority.

## Adopt-before-build evidence

`p-queue` supplies the required maintained Node.js concurrency queue,
AbortSignal cancellation and queue introspection. `p-limit` only limits
concurrency, while Bottleneck and adaptive concurrency libraries introduce
distributed rate-limiting or feedback-control concepts that are unnecessary
for this process-local gate. PiCloud therefore adopts `p-queue` and keeps
durable/distributed correctness in PostgreSQL.
