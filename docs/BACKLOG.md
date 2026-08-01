# Backlog

This file tracks work that is still relevant to the current Cube + Temporal +
Pi SDK product. Completed migration plans and retired runtime experiments belong
in the implementation log or Git history, not in the active backlog.

## Deployment ergonomics

- [x] Provide an idempotent, checksum-pinned one-command self-hosted installer
      with read-only preflight, resumable phases, Cube/K3s bootstrap and
      post-deployment health verification.

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

- [ ] Add sustained fault injection for Pi Worker loss, Temporal Activity
      retry, Control Channel reconnect, Cube node loss and object-store outage.
- [ ] Expand orphan reconciliation and retention tests for Cube activations,
      POSIX volumes, Kopia snapshots, Pi checkpoints and quarantined Worker WALs.
- [ ] Make ambiguous Tool execution (`UNKNOWN`) explicit in the browser and
      operator diagnostics; never offer an automatic shell replay.
- [ ] Measure Session affinity under load and keep it only while it improves
      restore latency without starving other task queues.
- [ ] Publish a repeatable capacity report for Worker, Cube, PostgreSQL,
      Temporal and object-storage saturation.

## Deployment

- [ ] Validate the existing horizontal Pi Worker manifests on more than one
      physical node with external PostgreSQL, S3-compatible storage and
      Temporal.
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
