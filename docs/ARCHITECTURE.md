# Architecture

## 1. System boundary

AgentDock owns the cloud control plane, execution scheduling, sandbox lifecycle,
durability, policy, extension Web-UI bridge, and user-facing event stream. A
pinned Pi runtime owns the agent loop, extension/resource discovery,
conversation context, model/tool interaction, compaction, retry behavior, and
session-tree format inside an execution worker or active sandbox.

AgentDock must not fork Pi unless a required capability cannot be implemented
through the public RPC protocol, SDK, or extensions. Raw Pi RPC messages are
hidden behind a supervisor adapter so that upstream upgrades do not leak into
the control-plane domain model. ADR-0005 permits direct SDK embedding only as an
execution-side backend for trusted portable extensions. Pi and extension code
never load into the NestJS control-plane process.

## 2. Components

### TypeScript control plane

Responsibilities:

- authentication, projects, sessions, and public APIs;
- durable turn-command intake and idempotency;
- per-session mailbox and state machine;
- scheduling, tenant quotas, fairness, and backpressure;
- sandbox leases and fencing tokens;
- approvals and audit records;
- event persistence/indexing and SSE replay;
- usage and cost ledger;
- recovery coordination.

The initial implementation uses NestJS with the Fastify adapter. This keeps the
API, browser, shared protocol, extension bridge, and supervisor in one language
without allowing untrusted extension code into the control-plane process.

The HTTP request that submits a turn must not wait for the agent to finish. It
returns after durable acceptance, while execution continues as a background job.

The first Phase 1 intake slice makes the beginning of that flow executable.
`POST /v1/projects` creates a project and initial workspace;
`POST /v1/projects/:projectId/sessions` creates a cold session; and
`POST /v1/sessions/:sessionId/turns` requires an `Idempotency-Key`. Turn,
command, and outbox rows commit in one PostgreSQL transaction before the API
returns `202 Accepted`. A same-key/same-body retry returns the original turn,
while same-key/different-body reuse returns `409`. The command retains a SHA-256
request fingerprint and the outbox carries only identifiers; neither duplicates
the prompt or credential material.

The second Phase 1 slice adds an explicit transactional-outbox dispatcher. It
claims one due command using `FOR UPDATE SKIP LOCKED`, locks the owning session,
and enforces oldest-nonterminal-command mailbox order. The claim transaction
moves `pending/queued` to `dispatched/dispatching` and gives the outbox record a
bounded reclaim time. The incremented attempt acts as a local fencing token, so
a superseded pre-ACK claimant cannot later start. An execution backend must
persist `started()` before doing work; this advances the command to
`acknowledged`, the turn to `running`, and the session to `running`, and marks
the outbox delivery published. A retryable pre-ACK failure returns the command
to the mailbox, while completion or any
post-ACK failure settles command, turn, and session state transactionally. The
deterministic backend used by tests stores no prompt or credential data in its
execution records.

The third Phase 1 slice connects that dispatcher to a local supervisor adapter.
`command.turn.execute` now carries the immutable turn model snapshot and opaque
credential-binding version. A database coordinator reserves sandbox capacity,
increments the session fencing token, and creates a lease. The supervisor's
side-effect-free `prepare` returns an exact command ACK; the dispatcher validates
the lease and persists that ACK before `run` can send the prompt to Pi. The
supervisor owns a pinned Pi `0.80.10` RPC child, isolated temporary agent config,
strict LF-delimited JSONL, bounded diagnostics, process-group shutdown, and the
reviewed Pi-to-AgentDock text/tool/terminal event mapping. Completion and
post-ACK failure release the matching lease and capacity in the settlement
transaction; a stale lease or event fence is rejected.

The fourth Phase 1 slice makes cancellation an independent durable command
path. `POST /v1/sessions/:sessionId/turns/:turnId/cancellations` requires its own
idempotency key and commits a cancellation command plus outbox record before it
returns `202`; acceptance does not claim that the process has stopped. A second
dispatcher can reach the active assignment while the execute dispatcher is
waiting for Pi. Its supervisor prepare step is side-effect-free. Persisting that
exact ACK and moving turn/session to `cancelling` is the linearization point:
natural terminal settlement before it wins, while execute settlement defers to
cancellation after it. Only then does the supervisor send Pi's native `abort`.
On POSIX, grace-period expiry escalates to process-group `SIGTERM` and `SIGKILL`,
including tool descendants. The public `turn.cancelled` event is emitted only
after process-tree teardown, persisted under the target execute command's
lease/fence, and cumulatively ACKed. That event authorizes final cancelled/idle
settlement and exact capacity release. Failure after cancellation ACK instead
fails the turn/session and retains the unconfirmed reservation for later
reconciliation.

The fifth Phase 1 slice connects the same `SupervisorTurnRunner` boundary to a
real Docker activation. A trusted host-side manager starts one ephemeral
container for an active turn; inactive sessions retain no process or container.
The worker copies an image-owned Java fixture into workspace tmpfs, creates a
baseline Git commit, starts pinned Pi with an explicit `bash/edit` tool
allowlist, and embeds the loopback fake model so the container can remain
networkless. Host and worker exchange a private, closed, versioned JSONL
protocol over attached stdin/stdout. Each worker event waits for the existing
durable control-plane ACK before Pi continues. A successful terminal event may
include a validated unified diff bounded to 64 KiB. Cancellation propagates to
Pi first and then requires exact-name outer-container removal confirmation.

This is a real sandbox/workspace transport behind an integration-only local
control-plane adapter, not yet the production remote supervisor connection. The
HTTP application deliberately does not auto-start dispatchers. PostgreSQL event
persistence, cumulative ACK, SSE replay, and Docker execution are executable;
the live SSE hub is process-local and the supervisor spool is memory-only.
Generic repository import, policy-approved extensions, a request-scoped model
gateway, lease renewal/reconciliation, acknowledged-cancellation crash
recovery, durable snapshots, cross-replica event notification, and Windows Job
Object containment remain later slices. A crash after durable command ACK is
still treated as ambiguous rather than replaying possible tool side effects.

### TypeScript sandbox supervisor

Responsibilities:

- start and supervise a pinned `pi --mode rpc` child process;
- translate typed Pi commands/events into the versioned AgentDock contract;
- proxy extension UI requests and responses between Pi and the web client;
- spool unacknowledged events locally and replay them after reconnect;
- propagate cancellation and shutdown to the complete Pi/tool process tree;
- manage Git worktrees and workspace snapshots;
- report heartbeat, resource usage, and health.

### Model profiles and credentials

The control plane exposes allowlisted model profiles rather than accepting raw
provider endpoints from clients. v0 has one operator-configured default profile
and no required model picker. A session references the desired profile; every
turn snapshots the resolved provider, model, thinking level, and opaque
credential-binding version so later policy changes do not rewrite history.

Credential material is not conversation state. Refresh tokens never enter Pi
JSONL, workspace snapshots, browser events, logs, or the untrusted tool
environment. The target execution path obtains request-scoped authorization
from a trusted credential broker or model gateway. A local, explicitly enabled
ChatGPT-subscription probe may reuse the owner's Pi login only as a Phase 0 SDK
integration test; it is not the production credential boundary. See ADR-0006.

### Deterministic model test boundary

The loopback-only fake model server implements the OpenAI Chat Completions SSE
shape used by the pinned Pi adapter. A typed scenario header selects text,
fragmented tool calls, HTTP 429, no-response timeout, malformed SSE, or
mid-stream disconnect. This is executable failure injection, not a production
model gateway: it accepts only a fixed valueless test key, refuses non-loopback
bind addresses, and records request metadata without authorization values or
message content. Default tests send real HTTP requests through Pi's provider
adapter but consume no provider quota.

### Execution backend boundary

The durable session identity is independent from its current execution
mechanism. The execution layer supports three explicit recovery tiers:

- `embedded-rehydrate` recreates a short-lived Pi SDK `AgentSession` from Pi
  JSONL for each activation. It is restricted to trusted portable extensions
  inside an execution worker/sandbox. Because this path bypasses Pi's CLI entry
  point, the worker installs a pinned, environment-aware Undici dispatcher before
  model calls rather than relying on ambient Node fetch behavior;
- `isolated-process` starts pinned Pi RPC in an isolated process or sandbox and
  remains the default compatibility path;
- `hibernate` delegates full process/filesystem checkpointing to an optional
  external sandbox backend.

Every backend consumes the same durable command, lease, fencing, event, and
snapshot contracts. Recovery claims distinguish event replay, semantic session
restore, workflow-step restore, workspace restore, and process-memory restore.

The embedded rehydrate spike demonstrates that several logical sessions can
share one worker process while every activation constructs and disposes its own
Pi runtime. It does not authorize untrusted extension code in that shared
process.

### Pi RPC process

The Pi process uses native session, extension, package, command, compaction,
retry, and event behavior. It is the only process that loads user or project
extensions. Inactive sessions are snapshotted and the complete sandbox is
evicted rather than leaving one Pi process alive per stored session.

### Sandbox

The sandbox is the security and workspace boundary. The initial implementation
uses Docker; the target implementation supports Kubernetes pods and optional
stronger runtimes such as gVisor or Kata.

Minimum controls:

- non-root user and read-only root filesystem;
- isolated writable workspace;
- dropped Linux capabilities and seccomp/AppArmor profile;
- CPU, memory, PID, disk, execution-time, and output limits;
- no host Docker socket or host home-directory mount;
- restricted network egress;
- no long-lived model/provider secrets exposed to the agent.

The Phase 0 Compose topology remains a zero-token configuration probe. The
Phase 1 Java repair path now activates a separate one-shot container with UID/GID
`1000:1000`, read-only rootfs, the engine's default seccomp policy, dropped
capabilities, `no-new-privileges`, no network/ports/binds/devices, and bounded
CPU, memory, PIDs, file descriptors, `/tmp`, and workspace tmpfs. It does not
mount a host repository or Docker socket. The embedded fake model requires no
egress or real credential. A later real-provider path must use a trusted
request-scoped gateway and explicit egress policy rather than exposing
long-lived provider credentials to Pi or tools.

## 3. State ownership

### PostgreSQL

Authoritative for control state:

- users and tenants;
- projects and workspaces;
- sessions and turn commands;
- agent-tree metadata;
- sandbox leases and fencing tokens;
- approvals;
- event sequence/index;
- usage ledger;
- transactional outbox.

It also stores model-profile policy, opaque credential bindings, the desired
session profile, and each turn's immutable resolved model snapshot. It never
stores provider tokens in ordinary session or turn rows.

Important uniqueness constraints include `(session_id, idempotency_key)` and
`(session_id, seq)`.

The initial Kysely migration also enforces tenant-consistent composite foreign
keys, one non-queued active turn per session, positive fencing tokens, bounded
sandbox capacity, approval outcome/state consistency, ACK cursors that cannot
advance beyond durable events, and non-negative usage. Multiple queued turns
remain legal and are consumed in mailbox order. Database checks constrain
persisted values; `@agent-dock/domain` remains the single authority for legal
transition order.

### Pi session JSONL

Authoritative for model conversation history and Pi's session tree. Only one
runner may write a particular live session at a time. Stable snapshots are
uploaded at safe turn boundaries.

### Object storage

Authoritative for cold artifacts:

- Pi session snapshots;
- workspace snapshots;
- large tool output;
- patches, test reports, and generated artifacts;
- crash diagnostic bundles.

### Supervisor delivery spool

The supervisor retains only unacknowledged event delivery copies. A cumulative
ACK permits deletion only after PostgreSQL has durably stored every event up to
that sequence and advanced the cursor in the same transaction. The current
in-memory spool is an executable reference for ordering, fencing, bounded
backpressure, ACK, and replay behavior; it is not the final crash-safe storage
implementation.

## 4. Execution flow

1. Client submits a command with an idempotency key.
2. The control plane stores the command and outbox record transactionally.
3. The API returns `202 Accepted`.
4. The session coordinator acquires the session execution lease.
5. The scheduler assigns or creates a sandbox runner.
6. The supervisor validates the fencing token and loads session/workspace state.
7. The selected execution backend activates Pi, loads policy-approved
   extensions, and executes the agent loop.
8. The supervisor translates and emits sequenced events; the control plane persists and ACKs them.
9. On `agent_settled`, the runner creates stable snapshots.
10. The control plane completes the turn and schedules the next mailbox command.

Steps 1-8 and 10 are executable through the local integration boundary: the
control plane acquires a real PostgreSQL lease/fence, persists ACK before run,
activates an ephemeral hardened Docker workspace, and receives public text,
tool, and terminal events from pinned Pi. Step 8 stores each complete event plus
command/lease/fence identity, advances the session cursor and next sequence
atomically, and returns the cumulative ACK only after commit. The same durable
log, including the bounded final patch, is available through SSE and resumes
after a browser reconnect with `Last-Event-ID`. Step 9, a durable
supervisor-side spool, cross-control-plane live notification, generic repository
snapshot import/export, and production remote sandbox assignment are not
implemented, so this does not yet claim runner reconnect recovery or durable
Pi/workspace restoration.

## 5. Delivery and recovery semantics

### Internal supervisor wire contract

Every internal message carries `protocolVersion`, `messageId`, `sentAt`, a
discriminator, and a closed typed payload. The contract is transport-neutral
JSON intended for the supervisor's outbound WebSocket connection.

Supervisor-to-control messages are registration, command ACK, event publication,
and heartbeat. Control-to-supervisor messages are registration acceptance, turn
execution/cancellation, approval resolution, cumulative event ACK, and heartbeat
ACK with lease renewals. Registration advertises the exact Pi/supervisor versions
and capabilities. Post-registration mutations carry a lease ID and fencing token.
The execute command additionally carries the turn's immutable provider, model,
thinking level, and opaque credential-binding snapshot; it never carries a
credential value or arbitrary provider endpoint.

Authentication is established by the transport/sandbox assignment rather than
by trusting tenant identity supplied by the sandbox. A heartbeat demonstrates
liveness but cannot make a stale fencing token current.

### Event and command semantics

- Public events use an AgentDock-owned, versioned, closed TypeBox union rather
  than raw Pi RPC objects. Version 1 carries `eventId`, `sessionId`, `turnId`,
  `agentId`, per-session `seq`, `occurredAt`, `type`, and a typed `payload`.
- `turn.completed` may carry a unified workspace patch. It is collected inside
  the sandbox, UTF-8 bounded to 64 KiB, and schema-validated before publication;
  the control plane never reads the live container filesystem to construct it.
- Only session-level state events may use a null `turnId`; turn, tool, approval,
  assistant, and notification events require a concrete turn identity.
- Event validation succeeds before the supervisor spool accepts a sequence.
- Commands use at-least-once delivery plus durable idempotency. Command ACK says
  that the current fenced supervisor accepted responsibility, not that execution
  completed.
- Events use contiguous per-session sequence numbers and at-least-once delivery.
  ACK is cumulative and means durably persisted, so an ACK lost in transit can
  safely cause replay.
- Duplicate current ACKs are idempotent. Regressing ACKs, ACKs beyond the highest
  publication, sequence gaps, and stale lease/fencing metadata are rejected.
- `GET /v1/sessions/:sessionId/events` emits the session sequence as SSE `id`,
  the AgentDock event type as `event`, and the complete versioned event as JSON
  `data`. It subscribes before reading the durable suffix and deduplicates the
  replay/live overlap. Exact durable redelivery may be re-ACKed after lease
  release when the earlier ACK packet was lost; it cannot add or alter history.
- The current in-process live hub is bounded and single-replica. PostgreSQL is
  authoritative for reconnect, while multi-replica live fan-out awaits
  `LISTEN/NOTIFY` or a measured broker requirement.
- Read-only tool calls may be retried when safe.
- Mutating or external side effects require an execution ledger, reconciliation,
  or human confirmation after an ambiguous crash.
- Recovery initially returns to the last settled turn, not an arbitrary point
  in the middle of a shell command.
- A non-empty Pi `sessionFile` path is not itself a durable boundary. Pi may
  defer JSONL creation until an assistant message exists, so snapshots are
  published only after the settled assistant state is durably present.
- Lease expiry creates a new fencing token; stale runners are rejected.

## 6. Session lifecycle

```text
COLD -> STARTING -> IDLE -> RUNNING -> IDLE
                         -> WAITING_APPROVAL -> RUNNING
RUNNING -> CANCELLING -> IDLE
RUNNING -> FAILED -> RECOVERING -> IDLE
IDLE -> EVICTING -> COLD
```

Cold sessions retain durable state without retaining a process, platform thread,
or sandbox. Idle sessions are evicted with an LRU policy after safe snapshotting.

The executable transition tables live in `@agent-dock/domain`, including the
command lifecycle `PENDING -> DISPATCHED -> ACKNOWLEDGED -> COMPLETED`. Only
`DISPATCHED -> PENDING` may retry; both `COMPLETED` and `FAILED` are terminal.
Self-transitions are rejected: duplicate messages are handled by command/event
idempotency before they reach a state transition, rather than being confused
with a second valid transition.

Turn execution follows:

```text
QUEUED -> DISPATCHING -> RUNNING -> COMPLETED
                    |          -> WAITING_APPROVAL -> RUNNING
                    |          -> CANCELLING -> CANCELLED
                    |          -> FAILED
                    -> QUEUED
```

`DISPATCHING -> QUEUED` is permitted only because execution has not been
observed to start. `RUNNING -> QUEUED` is forbidden: after a runner crash, an
in-flight turn becomes failed/ambiguous and is reconciled instead of blindly
replaying arbitrary tool side effects.

Approvals leave `pending` exactly once through `resolved`, `expired`, or
`cancelled`. Sandboxes move through provisioning, ready/leased, draining, and
terminated states; a failed sandbox may be terminated but never returned to the
ready pool. Agent nodes use the same explicit waiting, cancelling, and terminal
discipline. These rules are pure domain code so API handlers, database workers,
and supervisor consumers cannot invent different legal transitions.

## 7. Subagents

The runner registers cloud-aware collaboration tools such as `spawn_agent`,
`send_message`, `wait_agent`, `cancel_agent`, and `list_agents`.

Each child agent has an independent Pi session, context, status, event identity,
model configuration, tool set, and budget. The agent tree enforces:

- maximum depth;
- maximum children per node;
- maximum active and total agents;
- token and wall-clock budgets;
- cancellation propagation.

Read-only children may share a workspace. A writing child receives a separate
Git worktree and branch; the parent consumes a patch or commit after review.

## 8. Extension compatibility

Compatibility is defined by capability rather than by claiming universal TUI
compatibility:

- tools, lifecycle events, providers, commands, context hooks, compaction hooks,
  and package/resource discovery use Pi's native runtime;
- `confirm`, `select`, `input`, and `editor` are mapped to versioned approval
  events and responses; `notify` is mapped to a notification event;
- status, widget, title, and editor-text requests require explicit future web
  mappings and are never passed through as raw Pi objects;
- terminal shortcuts, themes, and custom TUI components are unsupported or
  explicitly remapped and covered by a published compatibility matrix;
- project-local extensions load only after a recorded trust decision;
- all extension code remains inside the sandbox because it has arbitrary Node
  process permissions.

Extension state is classified as `portable` (stateless or reconstructed from
session entries), `workspace` (reconstructed from durable files), or
`process-bound` (heap, subprocess, socket, or browser state). Only trusted
portable extensions are eligible for a shared embedded worker.

## 9. Deferred infrastructure

Flink or Kafka may later consume AgentDock events for analytics, audit pipelines,
cost aggregation, or batch workloads. They are not the interactive session
coordinator. Redis or a dedicated workflow engine is deferred until PostgreSQL
queue/lease behavior is measured and shown to be insufficient.

## 10. Web presentation

The first React session surface uses Pi `/export` as its visual reference:
compact monospace typography, a resizable tree sidebar, a narrow readable
transcript, and collapsible thinking/tool blocks. AgentDock adds durable SSE
replay status, turn cancellation, approval cards, and sandbox health. The Web
client consumes only AgentDock-owned REST/event schemas; it never reads Pi JSONL
directly or starts/manages Pi runtimes. Detailed direction is recorded in
`docs/WEB_UI_DIRECTION.md`.
