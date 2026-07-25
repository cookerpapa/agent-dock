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
- a Temporal Workflow/Activity poller on the common Pi Task Queue;
- an outbound authenticated management/liveness WebSocket to the Control Plane
  that does not assign production Runs;
- a private management address validated against an operator URL template.

Shared durable authorities are PostgreSQL, S3-compatible object storage, the
Sandbox Manager, and the Model Gateway credential store. Worker local memory is
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
Legacy whole-file v1 snapshots remain readable and migrate on the next settled
Run.

## How the next turn resumes

For a later user message:

```text
Control Plane commits Run/outbox and starts its Temporal Workflow
        |
        v
Temporal assigns the exact-command Activity to any available Pi Worker
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

The capacity-one rule is the SDK crash boundary. An ordinary prompt normally
cannot terminate the Worker, but it can cause model parsing, extension handlers,
tool registration and cancellation paths to execute. A programming defect,
native dependency failure or memory exhaustion could terminate the process.
Because only one active activation is admitted, that failure cannot take down a
second concurrently running tenant Session. The container runtime restarts the
Worker and the Control Plane reassigns future work from committed state.

Long-session storage uses the safe optimization described in ADR-0055:
tenant/session-scoped content-addressed, line-aligned JSONL segments plus an
immutable manifest. Whole-file v1 checkpoints remain readable. Reconstructing
history from UI messages remains incompatible because it would lose Pi-specific
branch, compact, tool, model, and extension state.
