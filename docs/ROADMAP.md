# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run/Attempt/Event state, leases/fences and same-Session ordering;
- one shared, horizontally scalable PostgreSQL-backed Pi Worker queue;
- official Pi `SessionStorage` PostgreSQL adapter with compaction-bounded reads;
- resumable Kafka/Valkey/SSE event path with canonical terminal Turns;
- CubeSandbox KVM-only Tool execution;
- persistent Cube Volumes as Workspace byte authority;
- lazy/warm/persistent Cube lifecycle and model-visible reset semantics;
- Kubernetes/KEDA deployment with PostgreSQL backlog scaling;
- one-host installer, configuration UI and real Cube/model acceptance.
- human Pi Session tree navigation and transactional conversation forks.

## Current release gate

- [x] Remove Temporal and the duplicate Outbox handoff scheduler.
- [x] Remove execution Cells and Worker affinity queues.
- [x] Remove MinIO/S3 checkpoint runtime and Kopia Workspace copies.
- [x] Make PostgreSQL SessionStorage the production Pi conversation authority.
- [x] Attach the same Workspace Volume across Cube activations and conversations.
- [x] Enforce Pi Session mutations under transaction-scoped execution authority.
- [x] Replace the full Harness experiment with a thin runtime composed from
      Pi Agent, SessionStorage and compaction primitives.
- [x] Remove lifetime JSONL download/restore from the production Worker path.
- [x] Update Compose and Helm/KEDA to the new topology.
- [x] Complete full CI for the production cutover.
- [ ] Repeat the clean one-host installer on a fresh machine.
- [x] Re-run token-consuming multi-round chat/coding, native Compaction,
      cross-Worker recovery and Cube restart acceptance.
- [x] Expose focused/full Pi Session trees and fork settled assistant responses
      without making tree control model-visible.

## Next reliability work

- run Worker, Control Plane, PostgreSQL connection and Cube loss injection on a
  multi-node cluster;
- validate Tool Broker and persistent Volume gateway replacement under load;
- publish PostgreSQL queue latency and Worker slot-density measurements;
- validate Kafka broker/projector rebalance and Valkey rebuild at target load;
- define Workspace snapshot/backup policy separately from normal Run commits;
- remove the constant-size Workspace-version conversation reference after the
  Workspace schema no longer requires a legacy Pi artifact foreign key.

Every performance or availability claim must name the tested revision,
topology, workload and observed result.
