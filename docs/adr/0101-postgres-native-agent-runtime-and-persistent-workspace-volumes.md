# ADR-0101: PostgreSQL-native Agent runtime and persistent Workspace Volumes

## Status

Accepted on 2026-08-13.

## Context

The previous architecture combined a PostgreSQL Outbox/claim state machine
with Temporal Workflows, then stored small Pi checkpoints in S3 and copied a
persistent POSIX Workspace into Kopia after Runs. Execution Cells and Worker
affinity added routing state without providing correctness: any healthy Worker
already had to restore external state and pass the same lease/fence checks.

Each component was individually defensible, but together they created duplicate
schedulers and duplicate durable copies without measured benefit.

Pi 0.84 provides a public `SessionStorage` interface for entries, branches,
compaction and operation records. Cube Volume Plugin provides persistent
Workspace attachment independently of a microVM's lifetime.

## Decision

1. PostgreSQL is the sole business and Run scheduling authority. Ready command
   Outbox rows form one shared Worker queue. `LISTEN/NOTIFY` is a wakeup hint;
   bounded polling is the fallback.
2. Remove Temporal, execution Cells and Worker affinity. All Pi Workers compete
   for the same queue and remain horizontally replaceable.
3. Implement Pi's public `SessionStorage` over PostgreSQL. Bind every mutation
   to an opaque Run/Attempt execution authority and check it inside the same
   transaction as the Session write.
4. Keep the stable Pi coding-agent JSONL adapter temporarily because upstream
   `AgentHarness.prompt/resume` is not implemented in Pi 0.84. Store those
   small compatibility objects in PostgreSQL, not S3. Do not patch upstream.
5. Make one persistent Cube Volume the Workspace byte authority. Stopping a
   Cube discards processes/memory but a new Cube attaches the same Volume.
   Workspace revisions contain bounded identity/hash/Git metadata, not a full
   archive copy.
6. Remove MinIO/S3 and Kopia from the default topology. Backup of PostgreSQL and
   the chosen persistent Volume backend is an operator concern separate from
   normal Run settlement.
7. Retain Kafka/Valkey for the measured high-frequency live stream: Kafka is
   durable before visibility; Valkey is rebuildable; PostgreSQL stores terminal
   canonical Turns and watermarks rather than every token delta.

## Consequences

- one fewer scheduler and two fewer storage systems are required;
- a lost notification cannot lose work, and competing Workers remain safe
  through the existing claim/lease/fence protocol;
- Workspace cold activation avoids upload/download/archive work;
- file state survives Cube replacement, but process trees, sockets and memory
  are explicitly not durable;
- historical Workspace rollback now requires a deliberate storage snapshot
  policy instead of an incidental per-Run Kopia copy;
- production migration is intentionally destructive for the pre-0101 local
  development data model.

## Rejected alternatives

- keeping Temporal only for timers retained a second delivery history without
  removing PostgreSQL claims;
- making Temporal the only state authority conflicted with transactional
  tenant/session/fence invariants and high-frequency event storage;
- continuing S3/Kopia for small Sessions and persistent Volumes optimized for
  a scale not present in measurements;
- privately implementing Pi AgentHarness would create an unsupported fork.
