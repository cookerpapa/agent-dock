# Pi Worker pool and conversation persistence

## What is pooled

A Pi Worker is a trusted, long-lived host process. Production Workers each own
exactly one active Run slot, but do not retain one Pi runtime per Session:

```text
many durable Sessions
        |
        v
PostgreSQL admission + Temporal Task Queue
        |
        +----> Pi Worker A (one SDK activation)
        +----> Pi Worker B (one SDK activation)
        +----> Pi Worker C (one SDK activation)
```

For one active Run, the selected Worker constructs one temporary pinned Pi SDK
`AgentSessionRuntime` in the Worker process. When the Run settles, the runtime
is disposed. No operating-system process is created per message. A later Run
for the same Session may run on another Worker.

Every Worker has:

- a unique stable Supervisor ID;
- a fresh boot and sandbox identity per process start;
- an independent fsynced boot ledger;
- an independent durable event spool;
- a declared capacity of exactly one active SDK Session;
- one Temporal Workflow/Activity poller on the Cell queue, bounded by the
  process-wide SDK execution-slot limit;
- an outbound authenticated management/liveness WebSocket to the Control Plane
  that does not assign production Runs;
- a private management address validated against an operator URL template.

Shared durable authorities are PostgreSQL, S3-compatible object storage, the
Tool Broker, and the Model Gateway credential store. Worker local memory is
never required to resume a cold Session.

## What is saved after a turn

AgentDock intentionally saves two different representations.

### Product and control data in PostgreSQL

PostgreSQL contains normalized records such as:

```text
Session
Run
RunAttempt
Turn
durable Event
conversation projection
ToolExecution
UsageRecord
ContextCompaction metadata
Checkpoint metadata
```

These rows drive the Web UI, SSE replay, scheduling, auditing, cost reporting,
and failure recovery. They are not assembled into a replacement Pi
`messages[]` array.

### Pi-native state in object storage

Pi writes an append-only `session.jsonl`. It contains the session header and
tree entries for user/assistant/tool messages plus Pi-specific entries such as
model changes, thinking changes, branch information, and compaction entries.

After Pi emits its settled completion, but before AgentDock publishes the
durable `turn.completed`, the Worker:

```text
read complete session.jsonl
        |
        v
upload immutable object to MinIO/S3
        |
        v
commit checkpoint metadata and Run settlement
```

The current v2 implementation stores line-aligned, content-addressed JSONL
segments and commits an immutable manifest after each settled Run. It does not
append every token to PostgreSQL and does not store one mutable database
`messages[]` column. Restore verifies every segment and the whole-session digest.
Only the current content-addressed manifest format is accepted; older
development snapshots are intentionally incompatible.

## How the next turn resumes

For a later user message:

```text
Control Plane commits Run/outbox and starts its Temporal Workflow
        |
        v
Temporal matches the Activity on the Session's Cell queue
        |
        v
Worker creates the eligible fenced RunAttempt
        |
        v
download latest committed pi-session.jsonl
        |
        v
reconstruct and verify private temporary session.jsonl
        |
        v
SessionManager.open(...) + createAgentSessionRuntime(...)
        |
        v
Pi rebuilds its active context
        |
        v
send the new user prompt
```

Pi constructs the provider-facing `messages[]` in memory. AgentDock does not
need to know every rule used by Pi to turn the session tree into current model
context.

## What compact changes

Compaction does not delete old JSONL history. Pi appends a `compaction` entry:

```json
{
  "type": "compaction",
  "summary": "...",
  "firstKeptEntryId": "...",
  "tokensBefore": 50000
}
```

On restore, Pi finds the active branch and builds model context from:

```text
compaction summary
+ entries beginning at firstKeptEntryId
+ entries written after the compaction
```

Older raw entries remain in JSONL for the session tree/export/audit path, but
they are not all sent to the model again. Therefore this sequence remains
correct across Worker changes:

```text
Worker A: user -> assistant -> user -> assistant -> compact
Worker A: upload complete JSONL checkpoint
Worker A exits
Worker B: download the checkpoint
Worker B: Pi rebuilds summary + recent context
Worker B: process the next user message
```

AgentDock also records a `context_compactions` row containing event identity,
reason, token counts, summary hash, and status. The summary text itself remains
inside the private Pi checkpoint and is not exposed through public SSE.

## Why this is reasonable

The design preserves the native semantics of the Agent runtime instead of
maintaining a second, subtly different conversation implementation. It also
allows true Worker replacement: no active Run means no Pi `AgentSession`, and
any healthy Worker can restore the next Run.

Worker capacity is an explicit density/failure-domain trade-off. The enterprise
profile admits four independent Pi SDK runtimes per Pod by default. A
programming defect, native dependency failure or memory exhaustion that
terminates the process can therefore interrupt up to four active Runs, but it
cannot corrupt their committed Session or Workspace state. Operators that need
the narrowest process failure domain can configure one slot; operators with
measured memory headroom can choose up to sixteen.

Production replicates the complete Worker process. All replicas in one Cell
poll that Cell's Temporal Task Queue:

```text
Cell Temporal Task Queue
├── Pi Worker 1, up to configured runtime slots
├── Pi Worker 2, up to configured runtime slots
└── Pi Worker N, up to configured runtime slots
```

Temporal's Worker Activity slot limit is the only process-capacity gate. When
all slots are active, unmatched work remains on the Cell queue and directly
drives backlog-based autoscaling. A later Run may land on any Worker; each
Worker keeps an opportunistic local checkpoint read cache, but correctness and
recovery always use the shared PostgreSQL/S3 path.

The supported single-host profile runs those replicas as Docker Compose
services. Kubernetes is not required for this horizontal-scaling property:
replaceability comes from external durable state plus a common Task Queue.
ADR-0058 now provides a separate Kubernetes Worker-pool Helm chart for the same
contract.

The chart deliberately uses a StatefulSet rather than a Deployment. A Pod
ordinal is the stable Supervisor ID and its private `ReadWriteOncePod` claim
retains only the boot ledger and not-yet-ACKed/quarantined event spool. It does
not retain the user's conversation. Pi JSONL segments/manifests remain in S3,
and PostgreSQL remains the authority for the checkpoint head, fence, mailbox,
Run and semantic projection. Therefore a later Session Run can still land on
any healthy Worker.

Kubernetes Worker code changes use Temporal Worker Deployment name plus an
immutable Build ID. A second Helm release starts the new build; the operator
promotes or ramps it only after pollers are healthy and leaves the old pool
until its pinned Run Workflows drain. This avoids treating an in-place Pod
rolling update as a safe Workflow-code upgrade.

Pi Worker count and Tool Sandbox count are separate capacity controls. A pure
chat Run consumes a Worker without materializing Cube. Coding Runs acquire the
Tool Broker's bounded FIFO admission on their first Tool operation. The
single-host default permits two simultaneous Cube guests, so additional Pi
Workers can continue model-only work without allowing a burst of 2 GiB guests
to exhaust the host.

Long-session storage uses the current-format optimization described in
[ADR-0071](adr/0071-sdk-only-pi-runtime-and-current-format-only-restores.md):
tenant/session-scoped content-addressed, line-aligned JSONL segments plus an
immutable manifest. Reconstructing
history from UI messages remains incompatible because it would lose Pi-specific
branch, compact, tool, model, and extension state.
