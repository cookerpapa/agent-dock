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

## Current release gate

- [x] Remove Temporal and the duplicate Outbox handoff scheduler.
- [x] Remove execution Cells and Worker affinity queues.
- [x] Remove MinIO/S3 checkpoint runtime and Kopia Workspace copies.
- [x] Move small Pi-native compatibility objects into PostgreSQL.
- [x] Attach the same Workspace Volume across Cube activations and conversations.
- [x] Enforce Pi Session mutations under transaction-scoped execution authority.
- [x] Implement the complete Pi 0.84.1 AgentHarness surface over PostgreSQL
      SessionStorage without forking Pi.
- [x] Update Compose and Helm/KEDA to the new topology.
- [ ] Complete full CI and fresh one-host installation acceptance.
- [ ] Re-run token-consuming multi-round chat/coding and Cube restart acceptance.

## Next reliability work

- run Worker, Control Plane, PostgreSQL connection and Cube loss injection on a
  multi-node cluster;
- validate Tool Broker and persistent Volume gateway replacement under load;
- publish PostgreSQL queue latency and Worker slot-density measurements;
- validate Kafka broker/projector rebalance and Valkey rebuild at target load;
- define Workspace snapshot/backup policy separately from normal Run commits;
- switch production from transitional JSONL compatibility objects only after
  the staged public-primitive Harness adapter passes Workspace-settlement,
  real-model/Cube and cross-Worker parity gates; then delete the JSONL path.

Every performance or availability claim must name the tested revision,
topology, workload and observed result.
