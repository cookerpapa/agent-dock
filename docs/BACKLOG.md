# Backlog

This backlog covers the current PostgreSQL + Pi SDK + Cube persistent-Volume
architecture. Temporal, Cells, MinIO/Kopia and alternate Sandbox runtimes are
retired and remain only in Git history or explicitly superseded ADRs.

## Release verification

- [ ] Keep formatting, typecheck, unit/integration, build, Helm and security
      gates green.
- [ ] Run a clean self-hosted install after every deployment contract change.
- [ ] Re-run real-model pure-chat and multi-round coding acceptance after Pi or
      provider changes.
- [ ] Verify Cube destruction followed by attachment of the same persistent
      Workspace Volume to a fresh KVM.

## Reliability

- [ ] Add process-level tests for two Workers racing the same ready command and
      prove one current Attempt/fence produces effects.
- [ ] Prove lost `NOTIFY`, duplicate wakeup and Worker restart do not lose or
      duplicate a Run.
- [ ] Exercise PostgreSQL/PgBouncer failover while direct notification
      connections reconnect.
- [x] Validate transaction-scoped SessionStorage authority through deterministic
      Pi Agent Run, Tool, compaction, lane and deferred-recovery contracts.
- [ ] Run the staged SessionStorage Harness through real model, Cube Tool,
      Workspace settlement and cross-Worker recovery before production cutover.
- [ ] Expand orphan reconciliation for Cube activations and persistent Volumes.
- [ ] Publish sustained Kafka/Valkey projection and SSE reconnect evidence.

## Distributed deployment

- [ ] Validate HPA/KEDA and node autoscaling on at least three physical nodes.
- [ ] Validate shared PostgreSQL queue fairness at target tenant concurrency.
- [ ] Validate RWX storage behavior, quotas and failure recovery for the chosen
      production CSI/Volume backend.
- [ ] Record Tool Broker, persistent Volume gateway and Cube compute-node drain
      evidence.

## Security and operations

- [ ] Add an enterprise egress allowlist and searchable network audit trail.
- [ ] Add tenant/session hard deletion and PostgreSQL/Kafka/Volume retention.
- [ ] Add backup/restore coverage for PostgreSQL and Workspace storage as two
      explicit authorities.
- [ ] Define a separate trust policy before enabling user Pi extensions.

## Optional modules

Candidate Race, review bundles, GitHub delivery and advanced governance remain
default-off experiments. Promotion requires a complete user workflow, measured
benefit and an amended architecture decision.
