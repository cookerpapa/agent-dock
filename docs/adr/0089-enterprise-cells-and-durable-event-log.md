# ADR-0089: Enterprise execution Cells

## Status

Accepted on 2026-08-09. Its original event-Outbox experiment is superseded by
[ADR-0091](0091-kafka-first-worker-event-ingest.md) and is intentionally not
retained here as a selectable design.

## Context

A single global Sandbox Manager ring and one unbounded Worker pool do not have
a stable scaling or failure domain. Resizing a hash ring can remap live
Workspaces, one unhealthy execution cluster can affect every tenant, and a
process-local Manager map cannot support safe replica replacement.

## Decision

1. Each Workspace receives one immutable `cell_id` when it is created. Adding
   Cells changes placement only for new Workspaces; moving an existing
   Workspace is an explicit drained migration.
2. A Cell owns a versioned Temporal Activity Task Queue, a Pi Worker pool, a
   replicated Sandbox Manager service, a Cube target and a Workspace storage
   target.
3. PostgreSQL is authoritative for Cell membership, Workspace placement,
   Run/Attempt/lease/fence state and Sandbox Manager activation ownership.
4. Sandbox Manager replicas persist instance leases, activation owner and Tool
   operation identity. After owner loss, a replacement may reattach only when
   Cube proves the same immutable operation; otherwise the result becomes
   `UNKNOWN` and is never replayed.
5. The default enterprise Pi Worker Pod admits four bounded SDK runtime slots.
   This is a density choice, not a tenant security boundary: failure of one
   Worker can interrupt at most those four active Runs, which resume from
   committed state.
6. Capacity grows by adding resources within a Cell and then adding Cells. A
   Cell can be drained without silently remapping an active Workspace or
   transferring its live process world.

The Worker event plane is independent of Cell placement. Its current
Kafka-first durability and canonical-transcript contracts are defined by
[ADR-0091](0091-kafka-first-worker-event-ingest.md) and
[ADR-0093](0093-kafka-valkey-live-events-and-canonical-conversations.md).

## Consequences

- Callers carry a Cell identity but cannot choose a Cube endpoint or Manager
  owner directly.
- Manager replica replacement is fenced through durable ownership rather than
  process-local promises.
- Cross-Cell migration is a maintenance operation because a running KVM cannot
  be atomically transferred together with Worker ownership.
- The checked-in topology is multi-node-capable, but throughput and HA claims
  still require evidence from the exact external authorities and node count
  used by an operator.

## Adopt-before-build evidence

See [Enterprise Cell and Event Plane Survey](../research/enterprise-cell-and-event-plane.md).
