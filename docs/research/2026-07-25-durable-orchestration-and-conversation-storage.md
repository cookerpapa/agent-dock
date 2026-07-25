# Durable orchestration and conversation-storage selection

- Date: 2026-07-25
- Scope: Pi Worker scheduling, durable Run orchestration, conversation
  projections, and Pi-native session checkpoints
- Source policy: official documentation, official repositories, releases, and
  licenses; GitHub popularity is context rather than a selection rule

## Executive conclusion

There is no single store or scheduler that should own the whole AgentDock
system.

The recommended target is:

```text
PostgreSQL
  product transactions, tenant admission/fairness, semantic projections,
  usage, audit, and the committed checkpoint head

Temporal
  post-admission durable Run orchestration and horizontally polled Worker tasks

S3-compatible object storage
  content-addressed Pi JSONL segments/manifests, Workspaces, and large artifacts

Pi
  native session-tree, compaction, and provider-facing messages[] construction

Kubernetes
  trusted Worker replica lifecycle/autoscaling

CubeSandbox
  untrusted Tool microVM scheduling and lifecycle
```

Temporal is the best-fit mature open-source durable workflow engine for a
future controlled migration. It must replace the matching part of the current
dispatcher rather than become a second scheduler. The current PostgreSQL
Run/Attempt/Lease/Fencing path remains production authority until a parity and
fault-injection gate passes.

Conversation state should not be moved into Temporal. AgentDock's current split
is sound: PostgreSQL stores queryable product/control state and Pi's exact JSONL
is the native resume authority. The current whole-file snapshot is a safe v1;
the storage-efficient v2 should upload only content-addressed, line-aligned
JSONL suffix segments and commit an immutable manifest through the existing
PostgreSQL revision/fence CAS.

## What Temporal is

Temporal is an MIT-licensed, self-hostable durable-execution platform descended
from the engineers and concepts behind Uber Cadence. A Workflow is
deterministic orchestration code whose event history can be replayed after a
Worker crash. Non-deterministic operations run as Activities.

Its Task Queues are demand-created durable queues polled outbound by one or
more Workers. Workers poll only when they have spare capacity, so adding Worker
processes load-balances work without service discovery or inbound Worker
ports. Temporal persists Workflow and Activity tasks when a Worker is absent.

Temporal is more than a cron scheduler:

```text
ordinary scheduler:
  run task X at time T

Temporal:
  durably run A
  then B
  wait for an external event
  cancel or time out C
  retry according to policy
  recover orchestration state after process/node failure
```

The service is open source; Temporal also sells a managed cloud. Self-hosting
is supported with official containers and Helm charts but adds a real
production subsystem and its own persistence/visibility schemas.

## Candidate comparison

Repository activity was checked on 2026-07-25.

| Candidate | Origin/governance | Fit | Important limitation | Decision |
| --- | --- | --- | --- | --- |
| Temporal | Temporal; Cadence lineage; MIT; official TypeScript SDK | Durable code workflows, outbound Worker polling, retry/timeout/cancel, replay, versioning | Extra service; deterministic Workflow rules; Activities are not exactly once | Preferred migration target |
| Cadence | Uber-origin, Apache-2.0 | Mature durable workflow semantics | First-class ecosystem is Go/Java; weaker TypeScript fit than Temporal | Do not choose |
| Dapr Workflow | Microsoft-origin/CNCF, Apache-2.0, Durable Task engine | TypeScript, workflow/activity model, Kubernetes sidecars, pluggable state stores | Broad sidecar/actor platform; state-store/reminder latency; all workflow/activity registrations in an app scale together | Viable second choice |
| Argo Workflows | CNCF, Apache-2.0 | Excellent Kubernetes batch/DAG and container workflows | Pod/YAML-oriented; poor fit for low-latency interactive agent Runs and streaming | Retain for batch/eval only if needed |
| Netflix Conductor | Netflix-origin, Apache-2.0 | External workers and microservice orchestration | JSON-centric orchestration and less natural TypeScript code/replay model | Not preferred |
| PostgreSQL `SKIP LOCKED` | PostgreSQL | Simple durable admission, transactionally aligned with product state | Custom retry/heartbeat/Worker transport grows with workflow complexity | Keep for admission during migration |

GitHub stars at the observation time were approximately Temporal 21.8k, Dapr
26.0k, Argo Workflows 16.8k, Netflix Conductor 12.8k, and Cadence 9.4k. These
numbers did not determine the decision.

## Why Temporal fits AgentDock

The current system already contains many concepts that Temporal standardizes:

```text
AgentDock today                 Temporal primitive
-----------------------------------------------------------------
durable Run                     Workflow Execution
outbound Supervisor connection Task Queue polling Worker
RunAttempt                      Activity attempt
heartbeat/lease expiry          Activity heartbeat/timeout
cancel request                  Workflow cancellation/signal
retry scheduling               Activity/Workflow retry policy
Run history                    Workflow Event History
```

The important mismatch is arbitrary Agent side effects. Temporal recommends
idempotent Activities and can execute an Activity more than once. It cannot
make an unknown `bash`, GitHub write, or model charge exactly once. AgentDock
must retain:

- unique Tool Call IDs;
- RunAttempt identities;
- monotonically increasing fences;
- Workspace revision CAS;
- fresh-Sandbox recovery after an ambiguous process;
- non-retryable/`UNKNOWN` classification for unsafe side effects.

Temporal reduces orchestration plumbing; it does not replace application-level
idempotency and fencing.

## Proposed Temporal ownership boundary

Use one bounded `RunWorkflow` per accepted AgentDock Run, not one indefinitely
growing Workflow containing a complete user Session.

```text
HTTP transaction
  write Turn + Run + outbox in PostgreSQL
        |
tenant-fair admission
        |
idempotent start Workflow ID = agent-dock/run/<runId>
        |
Temporal RunWorkflow
  allocate fenced RunAttempt
  restore immutable references
  execute Pi Activity
  checkpoint Activity
  commit terminal projection
        |
PostgreSQL/S3 remain product and byte authorities
```

Reasons:

- per-Session mailbox order and tenant fairness are already transactional
  product rules;
- one Run has a bounded lifecycle and avoids unbounded Workflow history;
- a retry can map cleanly to a new RunAttempt/fence;
- existing Run/Attempt APIs remain stable during migration;
- Pi JSONL, event deltas, Tool output, and Workspace bytes stay outside Temporal.

Temporal Event History has explicit size/event limits. Workflow payloads should
contain only bounded IDs, hashes, policy versions, and immutable object
references. Streaming model deltas continue through the existing batched
PostgreSQL event/SSE path.

## Temporal migration gate

Do not deploy Temporal as a second production authority. First implement a
separate spike and require:

1. TypeScript Workflow replay and version-upgrade tests.
2. At least two polling Pi Activity Workers.
3. same-Run start idempotency and same-Session ordering parity.
4. Worker kill during model execution and during Tool execution.
5. Temporal service restart and PostgreSQL/S3 temporary failure.
6. cancellation propagation to Pi and exact Sandbox teardown.
7. an unsafe Tool result is never blindly replayed.
8. a retry allocates a newer RunAttempt/fence.
9. Event History contains no prompt, transcript, Tool output, credential, or
   checkpoint bytes.
10. latency, throughput, database load, backup, upgrade, and rollback evidence.

Only after this gate passes may a deployment choose the Temporal dispatcher.
Cutover must make Temporal the sole post-admission Run orchestration authority
and retire the superseded custom matching path.

## Conversation storage: separate three representations

### 1. Semantic product projection

PostgreSQL keeps bounded, tenant-scoped conversation projections for the Web
product. It is optimized for list/detail/search and may be rebuilt from durable
AgentDock events. It is not a Pi resume format.

### 2. AgentDock durable event stream

PostgreSQL keeps immutable, ordered domain events and sequence cursors for SSE,
audit, and failure recovery. This follows selective event sourcing: append-only
events plus materialized views. Full event sourcing is deliberately not applied
to ordinary user/account configuration.

### 3. Pi-native runtime state

Pi JSONL remains byte-for-byte authoritative for Session tree entries, tools,
model/thinking changes, branches, extensions, and compaction. Pi alone builds
the provider-facing `messages[]`.

This split follows the standard event-sourcing guidance that immutable events
are the record while query-optimized materialized views and periodic snapshots
serve different access patterns. It also preserves Pi's documented native
format instead of inventing a lossy replacement.

## Pi checkpoint v2: content-addressed segments

Current v1:

```text
Run 1 -> upload bytes [0..A]
Run 2 -> upload bytes [0..B]
Run 3 -> upload bytes [0..C]
```

This is self-contained and atomic, but repeated snapshots approach quadratic
stored bytes for a steadily growing session.

Target v2:

```text
Run 1 -> segment sha256:S1 + manifest M1
Run 2 -> segment sha256:S2 + manifest M2 = [S1, S2]
Run 3 -> segment sha256:S3 + manifest M3 = [S1, S2, S3]

PostgreSQL checkpoint head -> M3
```

Each segment:

- contains complete JSONL lines;
- is immutable and addressed by SHA-256;
- is scoped under tenant/session object prefixes, so no cross-tenant
  deduplication side channel exists;
- is uploaded with checksum validation and create-if-absent semantics;
- is bounded independently of the total Session size.

Each canonical immutable manifest contains:

```json
{
  "format": "agent-dock.pi-session-manifest.v2",
  "piVersion": "pinned version",
  "previousManifestSha256": "optional",
  "segments": [
    { "sha256": "...", "sizeBytes": 123, "lineCount": 4 }
  ],
  "sessionSha256": "...",
  "totalSizeBytes": 123,
  "totalLineCount": 4
}
```

Settlement:

1. Validate the new JSONL is a byte-for-byte append of the committed base.
2. If it is not append-only, write a new base segment and record a rebase
   instead of guessing.
3. Upload only new content segments and their immutable manifest.
4. Verify object checksums.
5. In the existing PostgreSQL transaction, validate Attempt/lease/fence/base
   revision, insert artifact metadata, advance the manifest head, and commit
   `turn.completed`.
6. Unreferenced uploads are harmless orphans and are collected after a grace
   period.

Restore:

1. Read the committed manifest reference from PostgreSQL.
2. Fetch segments in manifest order.
3. Verify every segment and the reconstructed whole-session SHA-256.
4. Stream-concatenate into a private temporary `session.jsonl`.
5. Start pinned Pi with `--session`.

Pi compaction remains correct because compaction is another appended native
JSONL entry. Neither AgentDock nor Temporal reconstructs its summary.

To prevent too many small object reads, periodically create a consolidated base
segment when measured segment count/restore latency crosses a threshold.
Consolidation is an optimization; old manifests remain immutable until
retention and GC permit removal.

## Why not another conversation framework

- LangGraph-style checkpointers serialize that framework's graph state, not
  Pi's Session tree.
- Temporal Event History is an orchestration log with a bounded history, not a
  transcript/blob store.
- Kafka/Pulsar are distributed logs, but introduce a separate cluster without
  solving Pi byte fidelity or committed checkpoint-head CAS.
- EventStoreDB/Kurrent can hold domain streams, but AgentDock already needs
  PostgreSQL transactions for tenant admission, projections, fences, and usage.
- Git/Iceberg/Delta Lake solve different repository or analytical-table
  problems and would add impedance rather than remove custom Pi adaptation.

PostgreSQL plus S3-compatible storage are already mature open-source
foundations. The small AgentDock-owned manifest format is the required adapter
between those general systems and Pi's documented byte format.

## Primary sources

- Temporal Task Queues:
  <https://docs.temporal.io/task-queue>
- Temporal Workers:
  <https://docs.temporal.io/workers>
- Temporal Workflow Execution and Event History:
  <https://docs.temporal.io/workflow-execution>
  and <https://docs.temporal.io/encyclopedia/event-history>
- Temporal Activity semantics:
  <https://docs.temporal.io/activities>
- Temporal history limits and Continue-As-New:
  <https://docs.temporal.io/workflow-execution/limits>
  and <https://docs.temporal.io/workflow-execution/continue-as-new>
- Temporal server and TypeScript SDK:
  <https://github.com/temporalio/temporal> and
  <https://github.com/temporalio/sdk-typescript>
- Temporal Helm chart:
  <https://github.com/temporalio/helm-charts>
- Cadence: <https://github.com/cadence-workflow/cadence>
- Dapr Workflow:
  <https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/>
- Argo Workflow concepts:
  <https://argo-workflows.readthedocs.io/en/latest/workflow-concepts/>
- Pi Session file format and compaction:
  <https://pi.dev/docs/latest/session-format> and
  <https://pi.dev/docs/latest/compaction>
- Microsoft event-sourcing guidance:
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing>
- AWS event-sourcing and S3 integrity/conditional-write guidance:
  <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/event-sourcing-pattern.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>,
  and
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>
