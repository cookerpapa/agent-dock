# ADR-0089: Enterprise Cells and a Pluggable Durable Event Log

## Status

Implemented for staged deployment on 2026-08-09.

The PostgreSQL payload-Outbox portion was superseded by
[ADR-0091](0091-kafka-first-worker-event-ingest.md) after the transfer ledger
was found to duplicate high-frequency payloads without an atomic business-state
mutation to protect. Cell placement, Kafka ordering, projection and terminal
barrier decisions below remain current.

This ADR supersedes the capacity-one Worker and process-local Sandbox Manager
ring decisions in ADR-0057, ADR-0058, ADR-0059, ADR-0071 and ADR-0088. Their
durable-state and isolation decisions remain in force.

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

## Capacity gate result

The repeatable 2,000-Session PostgreSQL profile was executed on 2026-08-09 at
revision `4cddb77`. It committed 128,000 logical events without loss or
sequence error, but sustained only 3,223 events/s with a batch-ACK p95 of
3,592ms and approximately 1,038 WAL bytes/event. This failed the selected
10,000 events/s and 500ms p95 gate even after hash partitioning and set-based
cross-Session group commit.

The measured gate therefore authorized the Kafka adapter described by this
ADR. The enterprise profile now uses a one-way pipeline:

```text
Worker WAL
  -> PostgreSQL transactional batch Outbox + identity/hash registration
  -> Kafka (Session key, at-least-once)
  -> idempotent Event Gateway projection
  -> partitioned PostgreSQL replay/semantic tables
  -> resumable SSE
```

The Outbox is a bounded transfer ledger, not a second readable event stream.
It lets the request transaction acknowledge an ordered durable batch without
holding Session row locks across a Kafka network call. Published Outbox rows
are retained for one day and then pruned; Kafka is the durable high-frequency
transport and the PostgreSQL event table is its rebuildable browser/semantic
projection. Content hashes and `(session_id, seq)` registrations reject
conflicting redelivery at both boundaries.

The Control Plane still owns terminal events and business settlement. A
terminal transaction is admitted only when `last_projected_seq` has caught up
with `last_persisted_seq`; it then advances persisted, projected and
acknowledged cursors together. Thus a completed Turn cannot overtake text or
Tool facts that the Worker already crossed through its durable ACK barrier.

The checked-in Strimzi Stage 2 baseline has three KRaft controllers, six
brokers, 256 Session-keyed partitions, replication factor three and
`min.insync.replicas=2`. These are deployable capacity inputs, not a claim that
10,000 concurrent Runs have been measured on the local machine.

Event Gateway uses Confluent's maintained JavaScript client backed by
librdkafka. It is the only Kafka client in this path. KEDA scales the shared
projector group from consumer lag and CPU, with a non-zero failure fallback;
the maximum replica count stays below the topic partition count. The baseline
listener uses TLS plus SCRAM-SHA-512, and its KafkaUser is restricted to the
event topic, projector group and idempotent producer operation.

## Adopt-before-build evidence

See [Enterprise Cell and Event Plane Survey](../research/enterprise-cell-and-event-plane.md).
