# Architecture

## Product boundary

Pi owns the Agent Loop, model messages, compaction and Tool selection.
PiCloud owns durable admission, multi-tenancy, Worker execution authority,
remote Tool routing, Workspace lifetime, streaming and recovery.

CubeSandbox KVM is the only untrusted execution runtime. PostgreSQL is the only
business/Run-state authority. There is no second workflow scheduler.

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
- the Worker/Supervisor identity on a live RunAttempt is ephemeral execution
  ownership used for heartbeat, cancellation and fencing, not affinity;
- later Turns restore their bounded Pi context from PostgreSQL and therefore
  do not depend on the previous Worker remaining alive or warm.

## Components

### Web and Control Plane

The Web product provides authentication, resizable conversation/tree panels,
focused or whole-tree navigation, conversation forks, named Workspaces,
resumable output, file browsing and administrator settings. The Control Plane
commits each idempotent message and its Run command in one PostgreSQL
transaction. It enforces tenant quota and same-Session serialization.

### PostgreSQL Run queue

Ready command Outbox rows are the Worker queue. All Pi Workers query the same
queue. `FOR UPDATE`/transactional state transitions in `RunCommandExecutor`
make competing scans and duplicate wakeups harmless. `LISTEN/NOTIFY` is a
best-effort wakeup hint with periodic polling as the correctness fallback.

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

The production coding adapter is a deliberately thin `CloudAgentRuntime`. It
loads only the newest native compaction plus its active suffix, constructs one
Pi `Agent` for the active Run, and appends complete user, assistant and Tool
result entries back to PostgreSQL. It reuses Pi's public Agent Loop and
compaction primitives rather than recreating the generic `AgentHarness`
surface. No historical `session.jsonl` is downloaded, rewritten or used as
model-context authority.

Human tree navigation is a bounded projection of the same parent-linked Pi
entries. Forking a settled final response creates a child product/Pi Session
and transactionally copies the selected root-to-leaf branch. The child shares
the Workspace and begins with no open operation records. Tree navigation is
not exposed to the model or added to its context.

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
terminal blocks Agent admission. A same-owner warm Agent Cube is retired before
the terminal starts. Input, output and resize frames are bounded; the platform
does not persist terminal transcripts. Disconnect kills the PTY and destroys
that Cube, while the stable Workspace Volume remains available to later Runs.

### Persistent Workspace Volume gateway

The service historically named Workspace Volume Gateway is now a narrow trusted
Volume gateway. It does not copy Workspaces to Kopia or object storage. It:

- prepares and verifies the stable tenant/Workspace Volume identity;
- initializes an empty/imported Workspace once;
- purges a deleted Workspace only after every live Cube activation has retired;
- captures a bounded file/hash index and external Git patch;
- reads selected current files for the UI without following symlink escapes;
- serializes operations with a process lock and PostgreSQL advisory lock.

Stopping a Cube loses its processes and memory. A new Cube attaches the same
persistent Volume, so files and dependencies remain. A Workspace revision is a
reference to that authority, not a historical byte-for-byte backup.

### Event Gateway

Workers batch events into a local WAL and send authenticated ordered batches.
Kafka is the durable high-frequency stream. A projector builds the bounded
Valkey SSE view, then advances PostgreSQL's projected watermark. The browser is
shown only the acknowledged prefix.

At terminal settlement, PostgreSQL stores one canonical complete Turn and the
terminal sequence. Raw deltas age out of Kafka/Valkey rather than permanently
doubling conversation storage. Valkey can be rebuilt from retained Kafka; it is
not an authority.

## State ownership

| State | Authority |
| --- | --- |
| tenants, users, sessions, quotas | PostgreSQL |
| Runs, Attempts, leases, fences, ready queue | PostgreSQL |
| Pi Session entries/compaction/operation records | PostgreSQL SessionStorage |
| Session Tool grants and immutable Run capability snapshots | PostgreSQL |
| conversation parent/fork graph | PostgreSQL |
| canonical completed conversation | PostgreSQL |
| retained high-frequency Worker events | Kafka |
| bounded live SSE replay | Valkey, rebuildable from Kafka |
| Workspace bytes | persistent Cube Volume |
| Workspace revision/reference and Git baseline | PostgreSQL + trusted Volume envelope |
| live process tree | one Cube KVM only |
| active in-memory `messages[]` | Pi SDK for one active Run |

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

Control Plane, Event Gateway, Pi Worker and Tool Broker are independent
replica sets. PostgreSQL/PgBouncer, Kafka, Valkey, Workspace storage and Cube
are external authorities. Scaling the Worker pool adds Agent Loop slots;
scaling Cube compute adds concurrent Tool environments. No Cell abstraction or
per-Worker affinity is required for correctness.
