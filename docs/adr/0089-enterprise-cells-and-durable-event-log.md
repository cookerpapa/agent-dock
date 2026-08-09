# ADR-0089: Enterprise Cells and a Pluggable Durable Event Log

## Status

Accepted for staged implementation on 2026-08-09.

This ADR supersedes the capacity-one Worker deployment decision in ADR-0057,
ADR-0058, ADR-0059, ADR-0071 and ADR-0088. Their durable-state and isolation
decisions remain in force.

## Context

The distributed profile introduced in ADR-0088 has one fixed Sandbox Manager
ring, one Temporal Activity Task Queue and PostgreSQL as both the business
database and high-frequency stream log. That is an appropriate bounded first
deployment, but ring resize remaps Workspaces and per-Session event
transactions are not an acceptable unmeasured basis for a 2,000/10,000 active
Run claim.

## Decision

1. A Workspace receives one immutable `cell_id` from a durable Cell Directory
   when it is created. Existing Workspaces are assigned to the initial Cell by
   migration. Adding Cells affects only new Workspace placement.
2. A Cell owns a versioned Temporal Activity Task Queue, a Pi Worker pool, a
   replicated AgentDock Sandbox Manager service, a Cube cluster target and a
   Workspace storage target.
3. PostgreSQL remains authoritative for Cell membership, Workspace placement,
   Run/Attempt/Lease/Fence state, terminal settlement and transcript
   projections.
4. Sandbox Manager activation and operation identity is persisted through an
   AgentDock-owned repository. Process-local promises remain only an
   optimization. On owner loss, an operation is reattached by its immutable
   operation ID when Cube can prove the execution ledger; otherwise it becomes
   `UNKNOWN` and is never replayed.
5. High-frequency events use an AgentDock-owned `DurableEventLog` port. The
   initial PostgreSQL adapter remains the sole authority until a repeatable
   capacity benchmark fails the selected SLO. An Apache Kafka adapter may then
   replace it at an explicit sequence barrier; dual active authorities are
   prohibited.
6. Browser delivery always follows the selected durable log's acknowledgement.
   Terminal settlement additionally waits for the PostgreSQL semantic
   projection/checkpoint barrier.
7. Scaling from 2,000 toward 10,000 active Runs is performed by adding Cells,
   not by growing one global Sandbox Manager ring.
8. The default enterprise Pi Worker Pod admits four independent SDK runtime
   slots. This is a density setting, not an isolation boundary: a process-level
   Worker failure can interrupt at most those four active Runs, whose next
   execution starts from committed state. Operators can set the capacity back
   to one for the smallest failure domain.

## Consequences

- Existing Worker, Tool and event protocols gain a Cell identity, but callers
  cannot choose a Cell or Cube runtime directly.
- Manager replicas may sit behind a Cell Service only after activation state
  and recovery semantics no longer depend on one process-local map.
- Cell migration is an explicit offline/drained operation because live process
  state cannot be atomically transferred.
- The first release of this ADR is deployable code and deterministic tests; a
  2,000/10,000 production claim still requires real multi-node load evidence.

## Adopt-before-build evidence

See [Enterprise Cell and Event Plane Survey](../research/enterprise-cell-and-event-plane.md).
