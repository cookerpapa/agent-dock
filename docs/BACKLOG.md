# Backlog

This backlog covers the current PostgreSQL + Pi SDK + Cube persistent-Volume
architecture. Temporal, Cells, MinIO/Kopia and alternate Sandbox runtimes are
retired and remain only in Git history or explicitly superseded ADRs.

## Release verification

- [x] Rename the maintained product and deployment contract to Pi Cloud without
      retaining mixed pre-release runtime identifiers.
- [x] Make the maintained architecture documents explicitly distinguish
      ephemeral RunAttempt ownership from the removed Worker-affinity design,
      and label migrations/discussion logs as historical evidence.
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
      Pi Agent Run, Tool, compaction and interrupted-effect recovery contracts.
- [x] Run Pi 0.84.1's published Session backend conformance suite unchanged
      against the tenant-scoped PostgreSQL `SessionRepo` and retain separate
      authority/isolation contracts.
- [x] Ensure a secondary terminal-projection outage cannot strand a failed Run;
      commit a minimal failure boundary and let later Turns start after it.
- [x] Re-run the production PostgreSQL-native Pi runtime through real model,
      Cube Tool, Workspace settlement and cross-Worker recovery.
- [x] Add bounded human Session-tree projection, inherited transcript reads and
      transactional/idempotent conversation forks.
- [x] Allow a new Workspace terminal to consume its active `pending`
      deployment environment while continuing to reject `failed` versions;
      keep formal validation evidence bound to a fenced Agent Run/Attempt.
- [x] Add recursive conversation-subtree deletion and settled-message tail
      pruning without rewriting Pi's immutable entry history.
- [ ] Add branch rename controls to the tree UI.
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
- [ ] Add administrator-owned MCP connections and Session Tool grants on top
      of the Run capability snapshot; never load tenant code in the Pi Host.
- [ ] Add tenant/session hard deletion and PostgreSQL/Kafka/Volume retention.
- [ ] Add backup/restore coverage for PostgreSQL and Workspace storage as two
      explicit authorities.
- [ ] Define a separate trust policy before enabling user Pi extensions.

## Multi-agent execution

- [x] Map the maintained `pi-subagents` contract to Child Sessions/Runs rather
      than local Pi subprocesses; forbid nested children in the first release.
- [x] Support Tool-free, `shared_serialized` and isolated Workspace modes
      without equating conversation forks with file forks.
- [x] Implement a trusted persistent-Volume branch for parallel isolated
      mutating children and return their settled patch to the parent.
- [x] Project fresh and fork-context Child Sessions as typed, read-only nodes in
      the conversation list and tree while preserving their distinct execution
      relation.

## Product expansion rule

Candidate races, Run rewind, Review Bundles and advanced governance were removed
from the current product because they had no user workflow or measured benefit.
A future expansion requires an end-to-end product decision, public contract and
acceptance suite instead of a dormant backend module.
