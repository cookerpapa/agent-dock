# Optimization Boundary

Status: proposed scope, not authorization to remove product capabilities.

This document records the boundary for simplifying AgentDock after the external
architecture review. The review is evidence, not a deletion checklist. The
project must reduce duplicate implementation while preserving the product and
runtime behavior that was intentionally built.

## Product contract to preserve

The following capabilities must remain working throughout the optimization:

### Product

- public registration, authentication and tenant isolation;
- the ChatGPT-style conversation UI, conversation history, deletion and
  question navigation;
- Workspace creation/selection when creating a conversation;
- the expandable Workspace file browser and source-file preview;
- an administrator-only settings page;
- hot-reloaded model/provider credentials, model selection and Cube proxy
  settings without restarting the cluster;
- real-model execution, resumable SSE and durable visible output.

### Agent runtime

- the Pi SDK Agent Loop rather than one CLI process per Run;
- Pi-native session JSONL as the conversation recovery authority;
- Pi compaction, summaries, branches and tool-call semantics;
- recovery on a different Pi Worker after a process or node failure;
- bounded horizontal Pi Worker scaling;
- capacity-aware, soft Session affinity with shared-queue fallback;
- different Sessions may run concurrently while one Session remains ordered.

### Execution and isolation

- a trusted Pi Worker separated from untrusted tool execution;
- CubeSandbox as the only production Sandbox runtime;
- narrow, authenticated Tool RPC with lease/capability and fencing checks;
- one Workspace identity cannot be resolved to another tenant's Sandbox;
- warm Cube reuse across Runs, idle expiry and orphan reconciliation;
- persistent Workspace files plus immutable recovery points;
- background processes remain available while the Cube is warm;
- the selected `full` egress policy: public Internet access is allowed while
  platform services, private networks and metadata endpoints remain blocked and
  audited.

### Reliability

- PostgreSQL business state and MinIO immutable artifacts;
- Temporal durable execution, retry, cancellation and Worker task matching;
- Run, RunAttempt, lease, heartbeat, fencing token and revision CAS;
- idempotent message submission and terminal-state commit;
- durable event sequence, resumable SSE and final-message recovery;
- explicit handling for interrupted/failed model output;
- Workspace checkpoint, fork, rollback and recovery behavior.

### Optional research capabilities

Candidate Race, Attempt rewind, immutable Review Bundles, model governance,
usage/context inspection and Project Environment history remain available only
when `AGENT_DOCK_ADVANCED_MODULES_ENABLED=true`. The default Control Plane does
not instantiate their services or register their routes. GitHub Gateway is a
separate Compose profile.

The unfinished Web/API product surfaces for Preview, structured Diff, Artifact
download, test-result navigation, Fork/Rollback, GitHub App/PR delivery and
organization/RBAC/audit search were explicitly removed from the core product.
Their underlying correctness metadata may still be used internally by
checkpointing, Candidate Race and evaluation code.

## Explicit product choices not to reverse

Optimization must not silently reintroduce features that were deliberately
removed or declined:

- no gVisor, `runsc`, Docker Sandbox or lower-security production fallback;
- no repository-import button in the main chat UI;
- no "changes in this Run" Diff panel in the main chat UI;
- no token-by-token Tool stdout UI; the final Tool result is sufficient;
- no Pi extension compatibility layer;
- no per-tool approval system unless the product decision changes later;
- no arbitrary user-controlled Pod, VM or Cube specification.

Backend Patch and test data may still exist for recovery, Review Bundles and
evaluation. Removing a UI surface does not imply deleting correctness metadata.

## Refactors that may proceed without removing behavior

These changes target duplicate implementation and maintain the contracts above.
Each requires regression tests before the old path is removed.

### 1. One orchestration authority

Temporal should own durable Run orchestration, retry, cancellation, task
matching and fairness. PostgreSQL should remain the business-state authority and
transactional acceptance boundary.

The former `Temporal Workflow -> Activity -> OutboxDispatcher` path is replaced
by an exact-command `RunCommandExecutor`. Periodic PostgreSQL dispatch scanning,
retry scheduling and fair-queue selection must not remain as a second
scheduler.

This refactor must preserve:

- transactional message acceptance;
- same-Session ordering;
- tenant concurrency limits;
- tenant fairness;
- capacity-aware Session affinity and shared-queue fallback;
- RunAttempt, fencing and CAS;
- cancellation races and stale-Worker rejection.

The small transactional relay that starts a deterministic Temporal Workflow
from an accepted outbox record is not considered a second scheduler.

### 2. Modularize large files

Split large protocol, store, API and dispatcher modules by cohesive domain. This
is a source-organization refactor; public contracts and behavior remain stable.

Priority targets:

- `control-plane-store.ts`;
- `control-plane-api.ts`;
- `run-command-executor.ts` after the Temporal cutover;
- `candidate-race-service.ts`;
- `checkpoint-store.ts`;
- `ChatApp.tsx`.

### 3. Lighter default deployment

Provide a core profile and optional profiles without deleting services:

```text
core:
  PostgreSQL, Temporal, MinIO, Control Plane, Web, Pi Workers,
  Sandbox Manager/Cube control and required gateways

observability:
  Prometheus, Jaeger, Grafana and observability ingress

github:
  GitHub Gateway

evaluation:
  fake model and evaluation helpers
```

Production security controls and health checks must remain identical when an
optional profile is enabled.

### 4. Simplify implementation after measurement

Two internals are candidates for a behavior-preserving replacement:

- file-per-event durable spool -> append-only WAL or SQLite WAL;
- Pi checkpoint read/manifest layers -> a simpler immutable-object layout.

Neither implementation should be removed until a replacement passes crash,
deduplication, corruption, cancellation, restart and live-model tests.

The Pi checkpoint candidate has now been measured. The long-session result and
the decision to retain the segmented native JSONL layout are recorded in
[the 2026-07-30 storage report](reports/pi-session-storage-optimization-2026-07-30.md).

The file-per-event spool has been replaced after crash-window tests and a
same-host benchmark. See
[the WAL report](reports/event-spool-wal-optimization-2026-07-30.md).

## Changes requiring explicit approval

The following are not authorized by this document:

- removing Worker affinity;
- removing Candidate Race, Rewind or Review Bundle from the optional module;
- deleting database tables for an existing capability;
- removing a package or service rather than making it optional;
- changing the `full` Sandbox public-egress product choice;
- replacing Pi-native JSONL with reconstructed UI messages;
- weakening visible-event durability;
- removing fencing/CAS because Temporal is present;
- deleting old migrations or resetting current user data;
- removing Pi checkpoint segmentation/cache before presenting measured
  complexity and performance impact.

## Candidate residue cleanup

Runtime residue can be removed after proving it is unreachable:

- obsolete gVisor/Docker provider runtime code or configuration;
- superseded subprocess/RPC Agent paths;
- old compatibility readers and write paths;
- stale deployment variables and dead feature flags;
- historical implementation documents presented as current architecture.

Migration files and historical acceptance reports are not runtime fallbacks.
They should either remain clearly marked as history, or be replaced by a
deliberate fresh-schema baseline. They must not be deleted piecemeal because
that would make fresh database creation inconsistent.

## Required gates

Every simplification slice must demonstrate:

1. focused unit/integration tests;
2. repository typecheck and formatting;
3. same-Session multi-round Pi recovery, including compacted sessions;
4. multi-tenant concurrent real-model execution;
5. Cube tool execution, warm reuse, timeout and cancellation;
6. cross-tenant Workspace and platform-network isolation;
7. SSE reconnect and interrupted-output recovery;
8. no regression in measured first-token or total-settlement latency;
9. a small, reviewable commit that can be reverted independently.
