# Architecture decision index

This directory contains decisions that still constrain the current product or
maintained optional modules. Superseded implementation ADRs are removed rather
than presented as selectable architecture. Their history remains available in
Git and in [`../IMPLEMENTATION_LOG.md`](../IMPLEMENTATION_LOG.md).

ADR numbers are stable historical identities, so gaps are intentional.

## Core trust, state and protocol

- ADR-0002 through ADR-0009 define events, authority, fencing, credentials and
  cancellation.
- ADR-0011 through ADR-0027 define checkpointing, Session ordering, Worker
  transport, multi-tenancy and model brokering.
- [ADR-0029](0029-trusted-pi-runner-and-remote-tool-sandbox.md) separates the
  trusted Pi runtime from untrusted Tool execution.
- [ADR-0030](0030-pluggable-sandbox-provider-boundary.md) keeps the provider
  seam internal while supporting Cube only.
- [ADR-0031](0031-durable-run-attempt-protocol.md) defines Run/Attempt authority.

## Current platform chain

- [ADR-0053](0053-cubesandbox-primary-execution-plane.md): Cube KVM execution.
- [ADR-0054](0054-horizontal-pi-worker-pool-and-native-session-checkpoints.md):
  horizontal Pi Workers and Pi-native Sessions.
- [ADR-0056](0056-temporal-as-sole-run-scheduler.md): Temporal as the sole Run
  scheduler.
- [ADR-0063](0063-hot-proxy-mediated-cube-web-egress.md): governed Cube egress.
- [ADR-0067](0067-cube-posix-volumes-and-kopia-workspace-authority.md) and
  [ADR-0068](0068-session-resident-cube-and-posix-workspaces.md): durable POSIX
  Workspace and warm exact-Session Cube lifecycle.
- [ADR-0069](0069-cube-only-runtime-and-workspace-first-conversations.md):
  Cube-only cutover and Workspace-first conversations.
- ADR-0070 through ADR-0079 define terminal commit recovery, SDK-only Pi,
  trusted Workspace/Git metadata, exact-command Activities, the Worker WAL,
  steer, the Control Channel and interrupted Pi checkpoints. Historical
  cutover-only ADR numbers in this range are intentionally absent.
- [ADR-0080](0080-cloud-step-and-recoverable-tool-execution.md) freezes the
  accepted execution view, makes Tool operations reconnectable by identity,
  orders command output and makes the terminal delivery barrier explicit.
- [ADR-0081](0081-per-sampling-cloud-step-world-state.md) captures a fresh
  credential-free Step before every Pi provider request, binds remote Tools to
  that Step and projects only material execution-world deltas into model
  context.
- [ADR-0082](0082-cloud-turn-attempt-and-step-contexts.md) separates the stable
  accepted Turn contract from rotating Attempt ownership and binds every
  sampling Step and remote Tool operation to both.
- [ADR-0083](0083-model-sampling-attempt-identity.md) keeps transient provider
  retries inside one logical Step while durably correlating model attempts,
  Tool boundaries, request accounting and traces.
- [ADR-0084](0084-explicit-bounded-settlement-gate.md) adds an opt-in,
  project-defined verification stop hook with at most one Pi-native follow-up.
- [ADR-0085](0085-single-active-cube-tool-execution.md) preserves model order
  before Tool RPC because one Cube activation deliberately admits one
  cancellable operation at a time.
- [ADR-0086](0086-reconnectable-worker-control-channel.md) lets healthy fenced
  Runs survive a retryable Control Plane process replacement.
- [ADR-0087](0087-committed-stream-batching-and-model-context.md) defines the
  committed-before-visible stream, set-based batching and Pi-context recovery
  contract.
- [ADR-0088](0088-distributed-kubernetes-and-demand-scaling.md) defines the
  external-authority Kubernetes topology, version-aware Temporal/KEDA Worker
  scaling and exact Worker management DNS. Its process-local Manager ring is
  superseded by ADR-0089's DB-owned replica model.
- [ADR-0089](0089-enterprise-cells-and-durable-event-log.md) assigns each
  Workspace to an immutable execution Cell and defines the measured cutover
  boundary for a pluggable high-frequency durable event log.
- [ADR-0090](0090-session-selected-sandbox-retention.md) makes Cube retention a
  durable Session choice while preserving lazy activation, fencing and the
  one-live-process-world-per-Workspace invariant.
- [ADR-0091](0091-kafka-first-worker-event-ingest.md) removes the PostgreSQL
  payload transfer Outbox and makes authenticated Kafka append the enterprise
  Worker stream's first shared durability boundary.
- [ADR-0093](0093-kafka-valkey-live-events-and-canonical-conversations.md)
  keeps streaming deltas in Kafka plus a rebuildable Valkey replay view while
  PostgreSQL stores only terminal canonical Turns and sequence/business state.
- [ADR-0094](0094-cross-component-time-and-retention-budgets.md) treats
  timeout, lease, shutdown and live-retention values as one ordered recovery
  policy and validates the relationships in startup/CI checks.
- [ADR-0095](0095-sandbox-domains-and-cube-control-plane.md) separates
  lightweight Pi Worker execution Cells from shared Sandbox Domains and
  narrows the application control layer to a fenced Tool Broker.
- [ADR-0096](0096-temporal-handoff-and-capacity-backpressure.md) makes the
  transactional Outbox end at Temporal handoff and bounds Worker-capacity
  retry churn.
- [ADR-0097](0097-shared-temporal-worker-capacity.md) removes Worker-private
  queues and makes the Cell queue plus Temporal Activity slots the sole Worker
  capacity boundary.

[ADR-0061](0061-capacity-aware-temporal-worker-affinity.md) is retained as the
superseded record of the removed private-queue affinity experiment.

## Maintained optional modules

- [ADR-0032](0032-versioned-workspaces-and-github-gateway.md),
  [ADR-0033](0033-context-and-model-governance.md),
  [ADR-0042](0042-versioned-project-environment-plane.md),
  [ADR-0043](0043-cursor-informed-cloud-agent-product-loop.md),
  [ADR-0047](0047-attempt-rewind-and-immutable-review-bundles.md) and
  [ADR-0051](0051-parallel-candidate-races.md) document optional backend
  capabilities. See [`../OPTIONAL_MODULES.md`](../OPTIONAL_MODULES.md).
