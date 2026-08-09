# Backlog

This file tracks work that is still relevant to the current Cube + Temporal +
Pi SDK product. Completed migration plans and retired runtime experiments belong
in the implementation log or Git history, not in the active backlog.

## Deployment ergonomics

- [x] Provide an idempotent, checksum-pinned one-command self-hosted installer
      with read-only preflight, resumable phases, Cube/K3s bootstrap and
      post-deployment health verification.
- [x] Publish one configuration reference that separates administrator hot
      settings, supported operator settings, fixed production policy,
      generated identity and secrets.
- [x] Provide a strict distributed Helm profile, preflight/deploy command,
      migration hook, explicit external-authority contract and workload
      autoscaling policies.

## Release verification

- [ ] Keep the zero-token CI gate green: formatting, strict TypeScript,
      unit/integration tests, package builds and deployment configuration.
- [ ] Re-run the live Cube/KVM acceptance suite after Cube, K3s, template,
      Volume Plugin or egress changes.
- [ ] Re-run a bounded real-model multi-turn acceptance after Pi/model/provider
      integration changes.
- [ ] Keep generated acceptance reports tied to the exact commit and deployment
      configuration that produced them.

## Reliability and recovery

- [x] Lock the cloud recovery contract with deterministic tests covering an
      interrupted Pi Session across native Compaction/fresh-Worker restore and
      proving that post-ACK or ambiguous Tool failures are not replayed.
- [x] Separate stable logical Turn state from rotating Attempt ownership, bind
      Tool RPC to both digests, recover short transport disconnects by
      operation identity, order Bash output and require an explicit durable
      event barrier before terminal settlement.
- [x] Capture a Step at every logical Pi sampling boundary, reject stale Tool
      Steps and preserve minimal environment/Sandbox/policy deltas through Pi
      Compaction and fresh-Worker restore.
- [x] Persist Step/sampling-attempt identity across model request accounting,
      durable events, Tool boundaries and traces without exposing provider
      failure payloads.
- [x] Enable Pi-native bounded transient-model retry within one frozen Step;
      independently budget attempts, interrupt backoff on cancellation and
      prove that the resulting Tool executes only once.
- [x] Add an explicit project settlement gate that queues at most one Pi-native
      verification follow-up after mutating Tools and remains disabled by
      default.
- [x] Measure Pi sibling-Tool concurrency against the Cube guest admission
      contract and retain explicit model-order serialization until a
      multi-operation guest protocol proves a real benefit.
- [ ] Add sustained fault injection for Pi Worker loss, Temporal Activity
      retry, Control Channel reconnect, Cube node loss and object-store outage.
- [x] Add real process-level `SIGKILL` tests for Control Plane replacement and
      Worker-WAL recovery; a retryable Control Channel gap no longer revokes a
      healthy PostgreSQL-leased Agent Loop.
- [ ] Expand orphan reconciliation and retention tests for Cube activations,
      POSIX volumes, Kopia snapshots, Pi checkpoints and quarantined Worker WALs.
- [x] Make ambiguous Tool execution (`UNKNOWN`) explicit in the browser and
      operator diagnostics; never offer an automatic shell replay.
- [ ] Measure Session affinity under load and keep it only while it improves
      restore latency without starving other task queues.
- [ ] Publish a repeatable capacity report for Worker, Cube, PostgreSQL,
      Temporal and object-storage saturation.
- [x] Hash-partition the PostgreSQL Session event log without weakening global
      Event-ID idempotency or resumable per-Session sequence order.
- [x] Move authenticated resumable SSE connections onto a dedicated Event
      Gateway that can scale independently from REST/Run admission.
- [ ] Measure active concurrent streaming Sessions against PostgreSQL commit
      rate, WAL bytes, connection-pool wait and SSE delivery lag before adding
      an external event broker or terminal-delta retention compaction.

## Deployment

- [ ] Validate the existing horizontal Pi Worker manifests on more than one
      physical node with external PostgreSQL, S3-compatible storage and
      Temporal.
- [ ] Run the complete distributed Helm profile on at least three physical
      nodes and record HPA, KEDA, node-autoscaler and Manager-shard replacement
      evidence.
- [ ] Validate Cube compute-node drain, replacement and Workspace recovery from
      committed Kopia state.
- [ ] Replace workstation-specific network/proxy assumptions with explicit
      operator configuration in a multi-node deployment guide.
- [ ] Remove the remaining local Quinn/UDP test exception once the execution
      environment can run that integration test normally.

## Security and operations

- [ ] Add an enterprise egress mode with destination allowlists and searchable
      network audit records; keep private networks and metadata denied.
- [ ] Define a separate isolation policy before enabling project/user Pi
      extensions in trusted Workers.
- [ ] Before hostile public-SaaS use, add abuse controls, account recovery,
      billing/quotas, incident response and multi-node disaster recovery.
- [ ] Periodically verify that default Sandbox guests contain no model,
      database, object-store, Temporal, Kubernetes or Cube management secrets.

## Optional backend modules

The following maintained modules are intentionally disabled by default. They
are not deleted, but must not lengthen the core path when disabled:

- Candidate Race and parallel candidate evaluation;
- Attempt rewind and immutable Review Bundles;
- model, usage, context and Project-environment governance;
- the standalone GitHub Gateway repository-import experiment.

Promotion into the default product requires a complete UI/API workflow,
measured benefit, deployment ownership and an amended ADR.

## Retired scope

Docker/gVisor Tool runtimes, per-Run Cube pause/snapshot designs, the old remote
WebSocket execution dispatcher and removed browser surfaces are not backlog
items. Reintroducing an alternate runtime, Preview, structured Diff, Artifact or
test navigation, Fork/Rollback, GitHub App/PR delivery, organization/RBAC or
audit-search UI requires a new product decision and acceptance suite.
