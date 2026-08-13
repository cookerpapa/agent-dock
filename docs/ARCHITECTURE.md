# Architecture

## Product boundary

Pi owns the Agent Loop, model messages, compaction and Tool selection.
AgentDock owns durable admission, multi-tenancy, Worker execution authority,
remote Tool routing, Workspace lifetime, streaming and recovery.

CubeSandbox KVM is the only untrusted execution runtime. PostgreSQL is the only
business/Run-state authority. There is no second workflow scheduler.

## Components

### Web and Control Plane

The Web product provides authentication, conversations, named Workspaces,
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

Pi 0.84's official `SessionStorage` interface is implemented by
`@agent-dock/pi-session-postgres`. It stores Pi entries, lanes, records, labels
and the append log in PostgreSQL, and bounds an active branch at Pi compaction.
Every mutation checks an opaque `ExecutionAuthority` inside the same database
transaction as the write.

Upstream Pi 0.84 exposes `AgentHarness`, but its `prompt/resume` execution path
still throws `HarnessNotImplemented`. Therefore the production coding adapter
continues to use the stable Pi SDK/session-file entrypoint for model execution,
with its Pi-native JSONL objects stored in PostgreSQL. Switching the active loop
to `AgentHarness` is gated on an executable public upstream contract, not on a
private fork.

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

### Persistent Workspace Volume gateway

The service historically named Workspace Volume Gateway is now a narrow trusted
Volume gateway. It does not copy Workspaces to Kopia or object storage. It:

- prepares and verifies the stable tenant/Workspace Volume identity;
- initializes an empty/imported Workspace once;
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
| transitional Pi-native JSONL objects | PostgreSQL immutable object table |
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
- interruption and Sandbox reset boundaries are minimal model-visible facts,
  not fabricated Tool outcomes;
- Cube/process loss preserves files only; the next model is told when the
  execution world materially changed.

## Scaling

Control Plane, Event Gateway, Pi Worker and Tool Broker are independent
replica sets. PostgreSQL/PgBouncer, Kafka, Valkey, Workspace storage and Cube
are external authorities. Scaling the Worker pool adds Agent Loop slots;
scaling Cube compute adds concurrent Tool environments. No Cell abstraction or
per-Worker affinity is required for correctness.
