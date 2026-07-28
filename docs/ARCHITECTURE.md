# Architecture

## 1. Product boundary

AgentDock is a multi-tenant cloud product around the Pi SDK. Pi owns the Agent
Loop, native Session tree, model messages, compaction and Tool selection.
AgentDock owns everything required to execute that loop durably and safely:

- browser authentication and tenant isolation;
- conversations, Workspaces and durable Run admission;
- scheduling, retries, cancellation, leases and fencing;
- model credential isolation and usage;
- remote Tool execution;
- Workspace checkpointing and recovery;
- streaming events, audit and observability.

CubeSandbox is the only untrusted execution runtime in the current product.

## 2. Components

### Web

The React Web product exposes:

- login/registration;
- conversation list and transcript;
- named Workspace selection/creation for a new conversation;
- resumable SSE output;
- a committed `/workspace` directory browser;
- a dedicated platform-administrator settings page.

The browser never receives a model credential, Cube API key, Tool capability or
object-store credential.

### Control Plane

The NestJS/Fastify Control Plane owns:

- tenant/user/browser-session authentication;
- platform-administrator authorization;
- Project, Workspace and conversation APIs;
- transactional Run admission and idempotency;
- same-Session serialization and tenant quotas;
- PostgreSQL business state and event cursors;
- immutable checkpoint pointers;
- model/proxy configuration metadata;
- Temporal Workflow creation and cancellation.

PostgreSQL is the source of truth. Temporal is the durable execution engine, not
the business database.

### Temporal

Every accepted Run starts one Workflow. Workflow code contains deterministic
orchestration only. Model calls, Tool execution, checkpoint I/O and database
mutation are Activities.

The Worker pool uses:

- a common Activity Task Queue for fairness/fallback;
- capacity-one Worker-specific queues for soft Session affinity;
- durable defer timers and a single-attempt Agent Activity policy;
- explicit cancellation.

Affinity is an optimization. Any Worker can restore a Session and produce the
correct result for a new Run. A started Agent Activity is never transparently
replayed on another Worker.

### Trusted Pi Worker

A Worker slot executes one active Run:

1. resolve the current committed Pi checkpoint;
2. read immutable JSONL segments from its bounded cache or object storage;
3. reconstruct the exact native Pi Session file;
4. open it through the Pi SDK;
5. append the new user prompt;
6. stream model and Tool events;
7. commit the new Pi checkpoint after `agent_settled`;
8. dispose the in-memory AgentSession.

The Worker does not run user Bash locally. It has no Cube control credential,
container runtime socket or writable shared tenant filesystem.

### Model Gateway

The trusted model gateway resolves the deployment-owned model configuration,
injects the provider credential, enforces request identity and records usage.
Only the trusted Runner can reach it. The Cube guest cannot.

### Sandbox Manager

The Manager is the only application component that controls Cube. Its API is
narrow and authenticated. It:

- validates Tool leases and fencing tokens;
- maps a logical activation to one exact Cube microVM;
- creates, rebinds, inspects, stops and destroys that runtime;
- forwards bounded Tool requests;
- coordinates trusted Workspace checkpoints;
- reconciles orphan runtime inventory.

Pi and the browser cannot choose a Sandbox ID, runtime, image, mount, network
policy or resource policy.

### Cube execution plane

CubeMaster/Cubelet schedule a KVM microVM from the deployment-owned template.
The guest contains:

- `/workspace`;
- `bash`, `git`, Node.js, Java and Python;
- the minimal AgentDock Tool service;
- no platform or model credentials.

HTTP/HTTPS egress is routed through the Cube egress gateway. The gateway can
use a hot-configured host proxy, but it rejects private, link-local, metadata
and platform addresses.

### Workspace Data Mover

The Data Mover is trusted and separate from the guest Tool authority. It
connects the Cube Volume Plugin/POSIX Workspace to immutable Kopia checkpoints.
PostgreSQL CAS advances the Workspace-owned head only if tenant, Workspace,
RunAttempt, base revision and fence still match. Ordinary conversations share
that head but retain independent Pi checkpoints. Explicit Fork/Candidate-Race
Sessions use isolated branch heads until promotion.

Cube runtime lifetime and Workspace lifetime are independent.

## 3. State ownership

| State | Authority |
| --- | --- |
| tenants, users, roles, browser sessions | PostgreSQL |
| conversations and titles | PostgreSQL |
| Workspace identity and current revision | PostgreSQL |
| Runs, Attempts, leases and fences | PostgreSQL |
| Workflow timers/retry history | Temporal |
| Pi native Session bytes | immutable object storage |
| active Pi `messages[]` | Pi SDK memory for one active Run |
| Workspace checkpoint bytes | immutable Kopia/object storage |
| live process tree | one Cube microVM |
| streamed event log/high-water mark | PostgreSQL |
| UI transcript projection | PostgreSQL-derived read model |

The rendered browser transcript is not used to reconstruct Pi context.

## 4. Workspace and conversation model

```text
Tenant
└── Workspace (durable /workspace directory)
    ├── Conversation A (Pi Session A)
    ├── Conversation B (Pi Session B)
    └── Workspace revisions
```

A new conversation requires a title and either:

- an existing Workspace; or
- a new named empty Workspace.

Deleting a conversation archives only that Session. It disappears from tenant
listing and direct conversation reads, while the shared Workspace and durable
audit/checkpoint records remain.

The Workspace row owns the authoritative committed version. A newly created
ordinary conversation starts from that version with no Pi checkpoint. Claims
for ordinary conversations sharing one Workspace are serialized under a
Workspace row lock, then rebased to the latest committed head. Completion uses
base-version CAS, so a stale Attempt cannot overwrite a newer directory.

Committed Kopia checkpoints are tenant/Workspace scoped and carry their source
Session only as provenance. On a cold Run, the current Workspace head is
restored into that conversation's own Session-scoped POSIX volume. Ordinary
conversations therefore share committed directory state without sharing live
processes or uncommitted writes; explicit candidate branches retain the same
physical isolation.

Fencing tokens are monotonic within one Session ownership sequence, not
globally comparable across conversations. A same-Session restore must advance
the checkpoint's fence; a different Session may reuse the same numeric value
while the Workspace-head revision CAS prevents stale cross-conversation
commits.

## 5. New conversation flow

```text
Browser
  → POST /projects (only when creating a new Workspace)
  → POST /projects/:projectId/sessions {workspaceId, title}
  → Control Plane commits the cold Session
  → Browser opens the conversation
```

No Pi Worker or Cube runtime is created yet.

## 6. Run flow

### Pure chat

```text
Browser POST prompt
  → PostgreSQL transaction: message + Run + Attempt + outbox
  → Temporal Workflow
  → eligible Pi Worker
  → Pi checkpoint restore
  → model stream
  → batched durable events + SSE
  → Pi native checkpoint commit
  → Run completed
```

Cube is never contacted.

### Tool-using Run

```text
Pi emits Tool Call
  → Worker requests a Tool lease
  → Sandbox Manager validates Attempt/fence
  → ensure exact Session Cube activation
  → restore current Workspace if activation is cold
  → execute Tool in guest
  → return bounded stdout/stderr/result
  → Pi continues its Agent Loop
  → checkpoint dirty Workspace with CAS
  → commit final Pi checkpoint and Run
```

The first Tool call pays cold activation cost. An eligible warm activation can
serve later Tools/Run follow-ups for the same tenant/Workspace/Session.

## 7. Pi compaction and restore

Pi writes its native append-only Session tree, including compaction records.
After `agent_settled`, the Worker:

1. segments the complete JSONL by content hash;
2. uploads missing immutable segments;
3. writes a new immutable manifest;
4. advances the PostgreSQL checkpoint head under the current fence.

On another Worker:

```text
PostgreSQL checkpoint head
  → immutable manifest
  → cache/object-store segments
  → reconstructed session.jsonl
  → Pi SessionManager.open()
  → Pi reconstructs effective model context
```

Compacted Sessions therefore behave exactly as Pi defines. AgentDock does not
flatten or invent a replacement `messages[]`.

## 8. Event delivery

Pi events enter a bounded local queue. Adjacent text deltas are coalesced and
published in ordered batches. PostgreSQL commits each batch with a unique
`(run_id, attempt_no, seq)` identity and returns a cumulative ACK.

SSE uses the same durable event table:

- event IDs are sequence numbers;
- `Last-Event-ID` resumes from the committed suffix;
- database notification is a wake-up hint only;
- the table remains the truth if notification is lost.

Final messages, Tool results and terminal state are strong-durability events.
Intermediate streaming deltas can be reconstructed from the final semantic
projection if a Worker node is lost before remote ACK.

## 9. Lease and fencing

A lease expresses current ownership. A fencing token prevents a stale owner
from committing side effects.

The token increases when:

- an Attempt is retried;
- ownership moves to another Worker;
- cancellation invalidates the current Attempt;
- a lease expires and recovery begins.

Every mutating Tool request, checkpoint head update, terminal Run commit and
runtime handoff checks the current fence. A paused or partitioned old Worker
can resume its process, but its requests are rejected.

Tool commands with ambiguous completion are not blindly replayed. They become
`UNKNOWN` or force runtime destruction/recovery according to the Tool policy.

## 10. Administrator model

Tenant roles (`owner`, `member`, `viewer`) apply only inside one tenant.
Platform administration is a separate identity flag derived from the
deployment-owned operator tenant ID.

The platform administrator:

- lands directly on the settings page;
- can update model/provider configuration;
- can update the Cube egress proxy origin;
- does not inherit ordinary user conversation UI by virtue of administration.

Configuration records are versioned in PostgreSQL. New connections/Runs read
the latest value without a cluster restart; already-running work retains its
immutable start snapshot.

## 11. Failure and recovery

- Duplicate browser submission: idempotency key returns the original Run.
- Browser disconnect: the Run continues; `Last-Event-ID` replays the durable
  suffix without replacing visible output.
- Worker loss before durable Start ACK: assignment reconciliation may requeue
  the same Run under a new fenced Attempt.
- Worker loss after Start ACK: destroy or prove absence of the old runtime,
  settle the Run as `interrupted`, preserve every durable event, and wait for
  an explicit continuation Run. Temporal does not replay the Agent Activity.
- Possible Tool side effect: the continuation inspects committed Workspace and
  Tool evidence; uncertain external effects remain unknown until reconciled.
- Cube loss: restore the committed Workspace into a fresh activation.
- object upload succeeds but DB commit fails: immutable orphan is garbage
  collected later.
- DB commit succeeds but ACK is lost: commit ID/fence returns the prior result.
- stale runtime cleanup: inventory identity and physical runtime ID must match
  before destruction.

## 12. Deployment topology

The single-node development/production profile runs:

- Web ingress;
- Control Plane;
- PostgreSQL;
- MinIO;
- Temporal;
- Pi Workers (Compose or Kubernetes deployment);
- Sandbox Manager;
- Cube control/execution plane;
- Cube egress gateway;
- trusted Workspace Data Mover;
- optional observability stack.

The Pi Worker manifests are horizontally scalable. Multi-node deployment needs
shared PostgreSQL, object storage, Temporal and Cube infrastructure, but does
not require changing the Worker execution contract.

## 13. Current architectural decisions

- [ADR-0053: CubeSandbox primary runtime](adr/0053-cubesandbox-primary-execution-plane.md)
- [ADR-0056: Temporal as sole Run scheduler](adr/0056-temporal-as-sole-run-scheduler.md)
- [ADR-0070: Visible Attempt interruption and explicit continuation](adr/0070-visible-attempt-interruption-and-explicit-continuation.md)
- [ADR-0064: Workspace checkpoints](adr/0064-cube-native-workspace-checkpoints.md)
- [ADR-0069: Cube-only runtime and Workspace-first conversations](adr/0069-cube-only-runtime-and-workspace-first-conversations.md)

Older ADRs and migrations are immutable history, not supported runtime choices.
