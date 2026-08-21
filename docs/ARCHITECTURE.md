# Architecture

## Product boundary

Pi owns the Agent Loop, model messages, compaction and Tool selection.
PiCloud owns durable admission, multi-tenancy, Worker execution authority,
remote Tool routing, Workspace lifetime, streaming and recovery.

CubeSandbox KVM is the only untrusted execution runtime. PostgreSQL is the only
business/Run-state authority, Kafka is the bounded hot event log, and there is
no second workflow scheduler.

## Source-of-truth and terminology guardrail

This document describes the maintained production path. Historical migrations
must remain executable from an empty database, so their source files still
show when retired columns were introduced and later removed. Superseded ADRs
are kept only in Git history. Implementation logs, discussions and research are
background evidence and never reactivate a component in the current topology.

The current Worker invariant is deliberately precise:

- there is one shared PostgreSQL ready-Run queue;
- no user, Session or Workspace stores a preferred Worker;
- any healthy Worker with a free slot may claim the next eligible Run;
- a Worker that creates a Child Run may make one immediate local claim attempt
  when its reserved Child slot is free; this is an opportunistic race, never a
  queued or persisted affinity decision;
- the Worker/Supervisor identity on a live RunAttempt is ephemeral execution
  ownership used for heartbeat, cancellation and fencing, not affinity;
- later Turns restore their bounded Pi context from PostgreSQL and therefore
  do not depend on the previous Worker remaining alive or warm.

## Components

### Web and Control Plane

The Web product provides authentication, resizable conversation/tree panels,
focused or whole-tree navigation, conversation forks, recursive subtree
deletion, settled-message tail pruning, named Workspaces, resumable output,
file browsing, user-owned development environments and administrator settings. The Control Plane
commits each idempotent message and its Run command in one PostgreSQL
transaction. It enforces tenant quota and same-Session serialization.

### PostgreSQL Run queue

Ready command Outbox rows are the Worker queue. All Pi Workers query the same
queue. `FOR UPDATE`/transactional state transitions in `RunCommandExecutor`
make competing scans and duplicate wakeups harmless. `LISTEN/NOTIFY` is a
best-effort wakeup hint with periodic polling as the correctness fallback.

A Worker with a disconnected ownership channel does not scan, and a Worker
that finds candidate work checks Tool Broker readiness before claiming it. A
short execution-plane outage therefore leaves the Run queued without creating
an Attempt or starting a model call.

The queue retains the existing domain protocol:

```text
Run -> RunAttempt -> claim lease -> execution authority/fence -> terminal commit
```

Tenant scheduling timestamps order the bounded candidate scan so one tenant
cannot permanently occupy every free Worker slot. KEDA uses only the count of
ready queue rows to scale Workers; it does not own delivery semantics.

### Trusted Pi Worker pool

Workers are horizontally replaceable. A Worker slot claims one Run, opens the
Pi Session, calls the model and delegates Tools. Cold Sessions have no process
or thread.

One Worker process is an Agent Host with several bounded runtime slots; it is
not a Session owner. Each slot constructs an independent Pi `Agent`, model
capability and Tool set from the accepted Run. Process-wide registries contain
trusted definitions only and never imply that every Agent runtime can see or
execute every definition.

Pi 0.84's official `SessionStorage` interface is implemented by
`@pi-cloud/pi-session-postgres`. It stores Pi entries, lanes, records, labels
and the append log in PostgreSQL, and bounds an active branch at Pi compaction.
Every mutation checks an opaque `ExecutionAuthority` inside the same database
transaction as the write.

The same package implements Pi's tenant-scoped `SessionRepo`; Workers open or
create Sessions through that repository rather than through a second
PiCloud-only lifecycle. Pi's pinned, unmodified backend conformance suite
defines the baseline CRUD, fork, query, ledger and ordering semantics. Opaque
Pi identifiers are stored as `text`; PiCloud product UUIDs are one valid
subset. Tenant isolation and execution-authority fencing are additional cloud
contracts layered around the official port.

Forked Pi entries use copy-on-write references. PostgreSQL stores the selected
branch's IDs, parent links and local sequence in the Child, while immutable
JSON payloads remain in their canonical source rows. A per-Worker 64 MiB LRU
caches those payloads. A colocated Child therefore reuses context already read
by its parent; a remote Worker misses safely and fetches the same canonical
rows. Cache contents are never authoritative and are not required for recovery.

The production coding adapter is a deliberately thin `CloudAgentRuntime`. It
loads only the newest native compaction plus its active suffix, constructs one
Pi `Agent` for the active Run, and appends complete user, assistant and Tool
result entries back to PostgreSQL. It reuses Pi's public Agent Loop and
compaction primitives rather than recreating the generic `AgentHarness`
surface. No historical `session.jsonl` is downloaded, rewritten or used as
model-context authority.

Human tree navigation is a bounded projection of the same parent-linked Pi
entries. Forking a settled final response creates a child product/Pi Session
and transactionally records references to the selected root-to-leaf branch.
The child shares the Workspace and begins with no open operation records. Tree
navigation is not exposed to the model or added to its context.

Deleting a parent archives its whole human descendant subtree and their typed
Subagent Sessions after proving every Run has settled. Pruning after a settled
final response keeps that response, marks later product Turns invisible and
moves Pi's native `main` lane back to the retained entry. Later immutable
entries remain audit evidence but are unreachable from UI and model context;
Workspace bytes are deliberately not rolled back.

The runtime keeps only the cloud behavior the product needs: automatic
compaction, model retry, active steer, reviewed event mapping, remote Tools,
world-state changes and terminal Workspace settlement. A Tool intent is
written before its effect. If a Worker disappears before the Tool result is
known, the next Run records an unknown-effect result and interruption fact
instead of replaying arbitrary shell or file mutations.

Session Tool grants are copied into immutable Run capability snapshots during
admission. The snapshot is part of the frozen Cloud Turn context, selects which
Pi `AgentTool` proxies enter one runtime, and is carried to Tool Broker when an
activation is reserved. Each operation then carries its trusted Pi Tool name;
Broker rejects both ungranted names and invalid Tool/operation combinations.
Model visibility is therefore an affordance, while Broker authorization is the
security boundary.

### Durable Pi subagents

PiCloud pins the public `pi-subagents` package and preserves its model-visible
Tool schema, deployment-owned profiles and workflow-script runtime. A narrow
`PI_SUBAGENT_PI_BINARY` adapter replaces only local child execution. Every child
becomes a typed `session_kind=subagent` Pi Session, Run and RunAttempt in
PostgreSQL and is claimed by the ordinary shared Worker pool. The product
projects it beneath the causal parent Turn with explicit context and Workspace
mode labels; its native transcript is inspectable but read-only. Focused tree
navigation roots itself at the selected Child and shows inherited Pi context,
while whole-tree navigation attaches every Child to its causal parent Turn. It
never masquerades as a normal human conversation fork. A child never inherits
more Tools than the immutable parent Run snapshot.

Children may recursively delegate through the same cloud Tool contract. Every
execution stores its root Session/Run, immediate parent execution and depth;
all descendants share one deployment-owned tree budget. Defaults are depth 4,
32 total nodes and 3 simultaneously active descendants. The Tool is omitted at
the fixed depth/node boundary, while a concurrent-spawn race is rejected under
the root-Run lock. These bounds can be configured per Worker deployment but are
never model-controlled. Nested Child Runs use the same PostgreSQL queue,
RunAttempt fence, Tool Broker authorization and Cube Workspace modes as the
first generation. Cancelling or archiving a parent covers its full descendant
execution subtree. Admission also proves the tenant concurrent-Run quota has a
lane for the new Child; an undersized quota fails the Tool call immediately
instead of leaving a parent/child chain deadlocked in the queue.

The upstream native supervisor channel is local-file based, so PiCloud replaces
that transport with a PostgreSQL channel while preserving the
`contact_supervisor`/`subagent_supervisor` Tool semantics. Progress updates are
durable and non-blocking. Decision/interview requests pause the Child Tool,
surface immediately in the parent Tool stream, and may be answered by a parent
Run on another Worker. The reply wakes the existing Child Run; it never starts
the task again.

Workspace modes are explicit:

- `none` creates a Tool-free child and never reserves Cube capacity;
- `shared_serialized` keeps separate Pi contexts while handing the same Cube
  and Volume from parent to child under a rotated guest authority; the parent
  capability is invalid during the handoff and the parent owns the final
  shared Workspace-head commit;
- upstream `worktree:true` maps to `isolated`: Tool Broker quiesces the parent,
  the trusted Volume gateway makes an idempotent revision-bound internal
  Workspace copy, and the child keeps its resolved `fresh` or `fork` Pi context
  while running concurrently in another Cube. Its settled
  patch is returned to the parent, while the internal Workspace is hidden from
  product lists and retired after terminal settlement. Child Sandbox retention
  is always ephemeral even when the parent conversation is persistent.

For `context=fork`, PiCloud forks the native Pi branch immediately before the
current parent prompt that requested delegation, then appends the deployment-
owned Child task. Earlier conversation and compaction state are preserved, but
the orchestration request itself is not copied as another executable Child
instruction.

RunAttempt fences remain the database-side effect authority. A separate
monotonic Cube authority epoch rotates the in-guest secret across
parent→child→parent handoffs; Session-local fence numbers are never compared as
if they were one global sequence. Each Worker Host keeps at least one slot out
of ordinary-parent admission when subagents are enabled, so parents waiting in
the upstream workflow cannot occupy every slot needed by their children.

### Worker Control Channel

The authenticated Supervisor WebSocket carries registration, heartbeat,
durable event ACKs and active steer. It is not a second Run dispatcher. A brief
channel disconnect does not revoke a healthy database lease; an expired lease,
stale fence or non-retryable identity failure fails closed.

### Model Gateway

The model gateway is local to the trusted Worker boundary. It injects provider
credentials, binds model requests to Run/Step identity and records usage. Cube
cannot reach or authenticate to it.

### Tool Broker and Cube

The Broker validates opaque Tool authority, resolves a Workspace's Sandbox
Domain and reconciles Cube lifecycle. Pi cannot choose a Sandbox ID, image,
mount, runtime class, resource limit or network policy.

Broker admission is reconciled against PostgreSQL Run/Attempt state. If a
Worker disappears while Cube creation is in flight, a runtime that appears
after the Run or Attempt became terminal is treated as an orphan: the pending
operation is failed, the runtime is destroyed and the admission slot is
released. This closes the create-after-caller-death race instead of relying on
the vanished Worker to call `release()`.

Cube mounts only the `workspace/` child of a trusted persistent Volume. The
guest contains normal development tools but no platform credential. The trusted
Volume envelope holds generation and Git baseline metadata outside the guest's
view.

### Workspace Web Terminal

The authenticated public path
`/v1/conversations/:sessionId/terminal` is a WebSocket proxy, not a public Cube
port. The Control Plane resolves tenant, Project, Workspace, Sandbox Domain and
active environment from PostgreSQL. A newly-created deployment-owned
environment may still be `pending`, matching the first Agent Run's admission
rule; a `failed` environment is rejected. Terminal readiness is not persisted
as Agent environment-validation evidence because that evidence remains bound
to a fenced Run/Attempt. The Control Plane sends the trusted descriptor over a
dedicated service credential to the Tool Broker, which lazily creates a Cube
and opens a UID 1000 PTY in `/workspace` through the authenticated Cube Tool
Service. The image continues to exclude Cube `envd`, so the terminal cannot
bypass PiCloud's handoff authority and fencing boundary.

Human terminal authority is deliberately separate from Agent Tool capability,
Run lease and fence. PostgreSQL nevertheless enforces one shared Workspace
writer invariant: an active Agent activation blocks a terminal, and an active
terminal keeps a newly accepted Run queued until terminal cleanup has released
the writer reservation. A same-owner warm Agent Cube is retired before
the terminal starts. Input, output and resize frames are bounded; the platform
does not persist terminal transcripts. Disconnect kills the PTY and destroys
that Cube, while the stable Workspace Volume remains available to later Runs.

### User-owned development environments

`DevelopmentEnvironment` is a PostgreSQL product allocation keyed by tenant,
owner user and Workspace. Public REST and WebSocket handlers always derive the
owner from authenticated request identity; responses contain no Cube runtime
ID, traffic token or Broker credential. Tool Broker is the only CubeAPI client.

Provisioning eagerly creates one Cube KVM with the deployment-owned template,
resource policy, network boundary and stable Workspace Volume. The Cube timeout
is disabled for this explicit allocation. A terminal opens inside the existing
KVM, and disconnect kills only the PTY. Pause snapshots VM memory/filesystem;
resume reconnects the same Cube identity; release destroys it without deleting
Workspace bytes.

The allocation participates in tenant/Domain Sandbox quotas and the global
Workspace single-writer rule. PostgreSQL Worker scans exclude Runs whose
Workspace has a requested, provisioning, running, paused, releasing or unknown
environment. A lost Broker owner causes fail-closed orphan cleanup and a fresh
start; only the persistent Volume is guaranteed across that failure.

### Persistent Workspace Volume gateway

The service historically named Workspace Volume Gateway is now a narrow trusted
Volume gateway. It does not copy Workspaces to Kopia or object storage. It:

- prepares and verifies the stable tenant/Workspace Volume identity;
- initializes an empty/imported Workspace once;
- purges a deleted Workspace only after every live Cube activation has retired;
- captures a bounded file/hash index and external Git patch;
- reads selected current files for the UI without following symlink escapes;
- serializes operations with a process lock and PostgreSQL advisory lock;
- creates revision-bound internal Volume copies for isolated Subagent lanes.

Stopping a Cube loses its processes and memory. A new Cube attaches the same
persistent Volume, so files and dependencies remain. A Workspace revision is a
reference to that authority, not a historical byte-for-byte backup.

Source browsing materializes bounded files directly through the trusted Volume
gateway. It neither creates a Cube nor consumes Cube admission capacity; the
stored revision, path, size and SHA-256 are revalidated before bytes reach the
browser.

### Durable browser stream

Pi exposes separate Assistant-message, Tool-execution and Agent lifecycle
events. The public adapter intentionally ignores thinking fragments, streamed
Tool-call JSON and partial Tool stdout. It publishes only coalesced Assistant
text, complete Tool start/result Items and low-frequency lifecycle boundaries.

Workers combine adjacent text for 100 ms or 4 KiB, then independent Sessions
share a bounded Host-level Kafka append. Raw records are keyed by Session. An
authority consumer checks Run, Attempt, lease and fence in PostgreSQL before it
publishes to the Accepted topic. Only an Accepted broker ACK advances the
Worker boundary and makes bytes eligible for SSE.

Each Control Plane replica rebuilds a bounded in-memory Session replay view
from retained Accepted Kafka records before becoming ready, then tails that
topic. Browsers keep the same `Last-Event-ID` SSE contract and never receive
Kafka credentials. Kafka time/byte retention removes old deltas; a cursor older
than the retained window reloads canonical PostgreSQL conversation state.

Pi SessionStorage mutations use a separate Session-keyed Kafka topic. A
PostgreSQL projector applies complete entries, records and compaction facts
idempotently, while the active Worker waits at a projection barrier before the
next model Step. PostgreSQL therefore stores semantic Pi state, not token
fragments. Terminal Run state and a one-row Kafka outbox commit in the same
PostgreSQL transaction. Abnormal interruption recovery reads only the retained
Accepted tail needed to preserve a visible prefix that never reached
`message_end`.

## State ownership

| State | Authority |
| --- | --- |
| tenants, users, sessions, quotas | PostgreSQL |
| Runs, Attempts, leases, fences, ready queue | PostgreSQL |
| Pi Session entries/compaction/operation records | PostgreSQL SessionStorage |
| Session Tool grants and immutable Run capability snapshots | PostgreSQL |
| conversation parent/fork graph | PostgreSQL |
| canonical completed conversation | PostgreSQL |
| bounded live SSE replay | Accepted Kafka topic + rebuildable Gateway memory |
| Workspace bytes | persistent Cube Volume |
| Workspace revision/reference and Git baseline | PostgreSQL + trusted Volume envelope |
| live process tree | one Cube KVM only |
| active in-memory `messages[]` | Pi SDK for one active Run |
| development-environment ownership/lifecycle | PostgreSQL |
| development-environment process/memory state | one Cube KVM |

## First and later messages

For the first message, the Control Plane creates/uses a Workspace and Pi
Session, then queues the Run. Pure conversation stays entirely in the trusted
plane. If Pi chooses a Tool, the Broker lazily creates Cube and mounts the
Workspace Volume.

For a later message, any Worker can resume the same Pi Session from PostgreSQL.
Pi reconstructs the active model context and respects its native compaction
boundary. If the previous Cube is still warm it is rebound under a newer fence;
otherwise a new KVM mounts the same persistent Volume. Process state is not
claimed as durable.

## Failure rules

- queue delivery is at-least-once; state commits are idempotent/fenced;
- arbitrary shell start is not exactly-once and is never blindly replayed;
- stale Workers cannot mutate Pi SessionStorage, execute Tools, commit a
  terminal Run or advance a Workspace revision;
- cancellation revokes authority before process termination;
- during `cancel_requested`, Tool authority is revoked while the current
  Attempt/Fence retains narrowly bounded Pi Session write authority to commit
  interruption and unknown-effect facts; terminal cancellation then closes it;
- visible live events are durable before SSE; successful terminal messages are
  Pi-native and canonical before completion;
- interruption and Sandbox reset boundaries are minimal model-visible facts;
  an unfinished Tool becomes an explicit unknown effect, never a fabricated
  success or an automatic replay;
- Cube/process loss preserves files only; the next model is told when the
execution world materially changed.

A conversation fork resumes through the same path as any other Session. Its
Pi branch already contains the selected inherited context, while its product
transcript renders the parent history through the fork Turn followed by child
Turns. SSE sequence numbers remain local to the child Session.

## Scaling

Control Plane, Pi Worker and Tool Broker are independent replica sets.
PostgreSQL/PgBouncer, Workspace storage and Cube are external authorities.
Scaling the Worker pool adds Agent Loop slots;
scaling Cube compute adds concurrent Tool environments. No Cell abstraction or
per-Worker affinity is required for correctness.
