# Architecture decision index

Only decisions that constrain the current product or maintained optional
modules remain here. Superseded Temporal, Cell, affinity and Kopia decisions
are available in Git history rather than presented as current choices.

## Core protocol and trust

- ADR-0002 through ADR-0031 define durable events, idempotency, Run/Attempt,
  leases/fences, cancellation, multi-tenancy, trusted Pi and remote Tools.
- [ADR-0053](0053-cubesandbox-primary-execution-plane.md) makes CubeSandbox KVM
  the sole Tool runtime.
- [ADR-0054](0054-horizontal-pi-worker-pool-and-native-session-checkpoints.md)
  defines replaceable Pi Workers and Pi-native recovery.
- [ADR-0063](0063-hot-proxy-mediated-cube-web-egress.md) governs public egress.
- [ADR-0068](0068-session-resident-cube-and-posix-workspaces.md) separates warm
  Cube lifetime from durable Workspace lifetime.
- [ADR-0069](0069-cube-only-runtime-and-workspace-first-conversations.md)
  defines Workspace-first product behavior.

## Cloud Agent Harness

- ADR-0070 through ADR-0087 cover terminal atomicity, SDK boundaries, trusted
  Git metadata, event WAL, steer, interruption semantics, Turn/Attempt/Step
  contexts, model retry and reconnectable Tool operations.
- [ADR-0090](0090-session-selected-sandbox-retention.md) defines automatic and
  persistent Cube retention.
- [ADR-0094](0094-cross-component-time-and-retention-budgets.md) orders timeout,
  lease, shutdown and retention budgets.
- [ADR-0100](0100-bounded-sandbox-and-workspace-admission.md) bounds Sandbox and
  Workspace control pressure.

## Current distributed architecture

- [ADR-0091](0091-kafka-first-worker-event-ingest.md) makes Kafka append the
  shared live-event durability boundary.
- [ADR-0093](0093-kafka-valkey-live-events-and-canonical-conversations.md) keeps
  live deltas in Kafka/Valkey and terminal Turns in PostgreSQL.
- [ADR-0095](0095-sandbox-domains-and-cube-control-plane.md) defines the thin
  Tool Broker and Sandbox Domain.
- [ADR-0098](0098-self-healing-live-event-read-model.md) repairs Valkey from
  Kafka before readiness.
- [ADR-0099](0099-active-turn-catch-up-snapshots.md) defines active SSE catch-up.
- [ADR-0101](0101-postgres-native-agent-runtime-and-persistent-workspace-volumes.md)
  removes Temporal/Cells/S3/Kopia and establishes the PostgreSQL queue, Pi
  SessionStorage and persistent Cube Volume architecture.

## Optional modules

ADR-0032, ADR-0033, ADR-0042, ADR-0043, ADR-0047 and ADR-0051 document
default-off GitHub, governance, environment, review and candidate-race work.
