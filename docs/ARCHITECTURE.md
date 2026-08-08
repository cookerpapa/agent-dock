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

- a common Activity Task Queue with `tenantId` fairness metadata;
- capacity-one Worker-specific queues for soft Session affinity;
- durable timers and retry policy;
- explicit cancellation.

Affinity is an optimization. Any Worker can restore a Session and produce the
correct result.

Each Activity receives one exact `commandId`. The Worker-side
`RunCommandExecutor` performs transactional eligibility and lifecycle commits
for that command; it has no API for polling or selecting another tenant,
Session or Run. PostgreSQL mailbox/Workspace/quota checks can defer the exact
command, while Temporal remains responsible for Task matching, cross-tenant
fairness and retry timers. Temporal cancellation reaches the owning Activity;
its `RunCancellationExecutor` can claim only a cancellation record that targets
that Activity's exact command.

### Trusted Pi Worker

A Worker slot executes one active Run:

1. resolve the current committed Pi checkpoint;
2. read immutable JSONL segments from its bounded cache or object storage;
3. reconstruct the exact native Pi Session file;
4. open it through the Pi SDK;
5. append the new user prompt;
6. stream model and Tool events;
7. commit the new Pi checkpoint after successful `agent_settled`, or an
   explicitly typed interrupted checkpoint after terminal failure/cancellation;
8. return a private prepared result to the Control Plane;
9. dispose the in-memory AgentSession.

The Worker does not run user Bash locally. It has no Cube control credential,
container runtime socket or writable shared tenant filesystem.

### Worker Control Channel

The authenticated Supervisor WebSocket is a narrow control channel. It carries
registration, heartbeat, durable event batches/ACKs and fenced active Pi steer.
It does not dispatch Run execution or cancellation. Temporal Activity task
matching starts exact-command execution on a Pi Worker, while cancellation
travels through Temporal and the exact cancellation executor. Keeping those
paths out of WebSocket removes the former duplicate execution authority.

### Model Gateway

The trusted model gateway resolves the deployment-owned model configuration,
injects the provider credential, enforces request identity and records usage.
Only the trusted Runner can reach it. The Cube guest cannot.

### Sandbox Manager

The Manager is the only application component that controls Cube. Its API is
narrow and authenticated. It:

- validates Tool leases and fencing tokens;
- binds every reservation and operation to one stable logical Turn digest and
  one rotating Attempt digest, then admits monotonically advancing
  per-sampling Step digests;
- maps a logical activation to one exact Cube microVM;
- creates, rebinds, inspects, stops and destroys that runtime;
- forwards bounded, identity-recoverable Tool requests;
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

The physical POSIX Volume is a trusted envelope containing a generation
marker, AgentDock's external Git baseline and a `workspace/` child. Kopia
snapshots the complete envelope, while the Cube Volume Plugin mounts only the
`workspace/` child at `/workspace`. The trusted Data Mover computes the
cumulative Patch with explicit `GIT_DIR`/`GIT_WORK_TREE` paths while Cube
processes are frozen. Platform checkpoint and review metadata is therefore
outside the untrusted guest's filesystem view.

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
  → PostgreSQL transaction: message + Run + command + outbox
  → transactional relay starts deterministic Temporal Workflow
  → eligible Pi Worker
  → exact-command transactional admission creates RunAttempt/fence
  → freeze model/environment/Workspace/policy as one logical Turn contract
  → bind command/Worker/lease/fence as one Attempt contract
  → Pi checkpoint restore
  → capture a fresh Cloud Step before each model request
  → bind each provider transport attempt beneath that Step
  → model stream
  → batched durable events + SSE
  → Pi native checkpoint commit
  → private prepared result
  → atomic terminal event + Run commit
```

Cube is never contacted.

### Tool-using Run

```text
Pi context hook captures Step N and its semantic WorldState
  → model emits Tool Call from Step N
  → Pi serializes sibling remote Tools in model order
  → Worker sends Turn + Attempt digests and Step N sequence/digest
  → Sandbox Manager validates Turn contract, Attempt/fence ownership and rejects stale Steps
  → ensure exact Session Cube activation
  → restore current Workspace if activation is cold
  → execute Tool in guest
  → return bounded stdout/stderr/result
  → Pi continues its Agent Loop
  → checkpoint dirty Workspace with CAS
  → commit final Pi checkpoint and Run
```

Text reads use bounded line ranges, so a large source file does not have to
cross Tool RPC in full. Edits first read a content digest and then submit that
expected digest; the guest writes and fsyncs a same-directory temporary file,
checks for a stale revision and atomically renames it over the destination.
Readers therefore observe the old or new file, never a partially written file.

The Cube Tool service returns stdout and stderr as one monotonically sequenced
observation stream with a digest over the reconstructed bytes. The trusted
adapter rejects gaps or corruption before output enters Pi context. Large Bash
output is then truncated once into a head/tail preview for Pi. The full raw
output is stored as a trusted Artifact and the preview includes the Artifact
identity plus a concrete recovery instruction.

One Cube activation admits one cancellable Tool operation at a time. All four
remote Tools therefore declare Pi's public sequential execution mode. This
does not prevent different Runs or isolated candidate activations from running
in parallel; it prevents sibling Tools from racing one shared process and
Workspace state. See ADR-0085.

`operationId` identifies an execution rather than an HTTP request. A brief
Worker-to-Manager or Manager-to-Cube transport break can reattach to the same
bounded operation ledger entry and obtain the original result. A changed
request under the same ID is rejected. Loss of the Manager ledger, Tool service
or VM still yields `UNKNOWN`; arbitrary Bash is never started again.

Every model request carries the current Cloud Step sequence/digest and a
separate sampling-attempt number. A transient provider retry reuses the frozen
Step because no Tool or world-state transition occurred; normal post-Tool and
post-compaction requests advance to a new Step. The Model Gateway records the
identity in its request ledger and trace, while durable sampling events bind
the resulting Tool boundaries to the same Step. Provider error text is not
copied into public events.

Production uses Pi's native agent-level transient retry with two retries and a
500 ms exponential-backoff base delay. The provider SDK itself receives
`maxRetries: 0`, so no hidden HTTP retry can bypass the Model Gateway ledger.
Cancellation interrupts Pi's backoff. A failed sampling attempt cannot have
started a Tool; if a later successful attempt emits a Tool call, that operation
still follows the normal operation-ID and `UNKNOWN` rules and is never replayed
by the model retry mechanism.

Projects can opt into one bounded settlement gate by naming an offline
environment verification command `settlement-gate`. If `write`, `edit` or
`bash` may have changed the Workspace and that exact verification was not
observed succeeding, a trusted Pi extension queues one hidden native follow-up.
The model then runs and interprets the command through normal remote Tools; the
platform never executes project code in the Worker and never repeats the gate.
Projects without the named command pay no gate latency or model cost.

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

### Interrupted Runs

A started Run that fails or is cancelled does not advance the Workspace head.
The Worker does preserve Pi's native Session branch and appends a hidden,
model-visible `agent-dock.run_interrupted` marker before storing an
`pi_interrupted_session_snapshot`. If Pi failed before recording the accepted
prompt, the Worker appends that user message first. It never converts streamed
browser deltas into an assistant message.

The next Run therefore restores:

```text
last committed Pi branch
  → accepted interrupted user prompt
  → any native Pi error/aborted assistant and Tool results
  → explicit interruption marker
  → next user prompt
```

The marker is the model-visible interrupted-Turn boundary. It records that Tool
side effects may be partial and background processes may still be active. It
does not expose failure codes, Run/Attempt identity or a prescribed recovery
procedure to the model. The next model call decides how to respond from that
fact and the user's new prompt. Pre-execution dispatch failures do not create
this checkpoint and may be retried without changing the conversation head.

Catchable provider failures preserve Pi's native aborted/error assistant
message. An integration test disconnects the provider after publishing
`partial-before-disconnect` and proves that the same visible text is present in
the interrupted Pi JSONL checkpoint. AgentDock still does not synthesize an
assistant message from browser deltas: Pi-native state is the authority.

If the Worker is killed by `SIGKILL`, OOM or node loss, it cannot append that
native interruption marker. The next Worker then restores the latest committed
Pi checkpoint and appends one hidden, model-visible semantic recovery suffix
derived from canonical PostgreSQL Turn projections newer than the checkpoint.
The suffix contains the accepted prompt, public assistant text, Tool
boundaries/results and canonical failure/cancellation state. An in-flight Tool
is marked `unknown`; raw thinking is never reconstructed. The bridge describes
what was durably observed but does not prescribe a recovery strategy. The next
Pi checkpoint absorbs this one-time bridge, so Pi JSONL remains the conversation
authority.

Pi JSONL also keeps a typed, versioned and hidden
`agent-dock.runtime_world_state` custom entry that does not participate in
model context. It records only facts that can affect later reasoning: Sandbox
availability/continuity, environment fingerprint, committed Workspace revision
and Tool-policy fingerprint. The Sandbox Manager reservation reports whether
the exact Session runtime is a `warm_reuse` or a `cold_restore`. If a previously
active Cube is no longer available, the Worker appends one short model-visible
`<sandbox_reset>` fact before the next prompt:

```text
The committed Workspace is preserved, but running processes and in-memory
environment state were not carried forward.
```

The hidden state entry prevents the same loss from being announced on every
pure-chat Run. A later Tool-using Run records the newly active Cube, allowing a
future real replacement to produce a new one-time marker. Activation IDs and
lifecycle reason codes remain outside model context.

The Pi `context` extension hook runs immediately before every provider request.
At a new logical sampling boundary AgentDock captures an immutable Step
containing the exact active remote Tool registry and current typed runtime world
state; a scheduled provider retry reuses that Step with another sampling
attempt. Consecutive identical states do not add Session entries. In addition
to a lost active Cube,
an environment-image change or Tool/network-policy change produces one short
hidden custom message. Worker handoff alone is not model-visible when the same
warm Cube remains continuous.

### Active steer

An ordinary prompt submitted during a Run remains a queued follow-up. The
separate steer endpoint persists one `turn.steer` command, resolves the exact
active RunAttempt and sends a fenced two-phase `command.turn.steer` to the
Worker that owns its Pi Runtime. Commit invokes Pi's public
`session.steer(text)` API. The current Tool batch finishes first; Pi consumes
the steer before its next model call. A settled Run rejects steer instead of
turning it into another Turn.

Steer is the only Control Plane initiated command on the Worker Control
Channel. The two-phase prepare/commit exchange binds it to the current lease
and fence; reconnecting or stale Workers cannot apply it to another Attempt.

## 8. Event delivery

Pi non-terminal events enter a bounded local queue. Adjacent text deltas are
coalesced and published in ordered batches. PostgreSQL commits each batch with
a unique `(run_id, attempt_no, seq)` identity and returns a cumulative ACK.
The Worker cannot publish `turn.completed`, `turn.failed` or `turn.cancelled`;
its private `command.result` is only a prepared result.

Before returning that prepared result, the Worker crosses an explicit durable
barrier: the local spool must have no pending event and its cumulative ACK must
equal the highest sequence produced by the Run. Terminal settlement therefore
cannot overtake a non-terminal event still buffered at the Worker.

The Control Plane creates the public terminal event in the same PostgreSQL
transaction that settles Run/Attempt/command/turn/session state, advances
checkpoint and Workspace heads, materializes the semantic transcript and
emits the database wake notification. A browser terminal event therefore
cannot get ahead of canonical business/checkpoint state.

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
- Worker crash before Tool execution: Temporal retries on another Worker.
- Worker crash with possible Tool side effect: old fence is revoked and the
  runtime is destroyed unless exact execution state is known.
- Short Tool transport disconnect: reattach to the same operation ID and
  recover the original running/result promise without replay.
- Tool operation ledger, Tool service or Cube loss: expose `UNKNOWN`, destroy
  uncertain runtime state and do not replay the command.
- Worker hard crash after durable output but before Pi JSONL persistence:
  restore the prior Pi checkpoint plus the bounded semantic recovery suffix;
  do not synthesize raw thinking or replay unknown Tool side effects.
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

The default production profile contains 15 core services. Prometheus, Jaeger,
Grafana, their volume bootstrap and loopback ingress are enabled together by
the `observability` profile. Core services do not require an OTLP collector to
be ready.

The Pi Worker manifests are horizontally scalable. Multi-node deployment needs
shared PostgreSQL, object storage, Temporal and Cube infrastructure, but does
not require changing the Worker execution contract.

## 13. Current architectural decisions

- [ADR-0053: CubeSandbox primary runtime](adr/0053-cubesandbox-primary-execution-plane.md)
- [ADR-0056: Temporal as sole Run scheduler](adr/0056-temporal-as-sole-run-scheduler.md)
- [ADR-0074: exact-command Temporal Activity boundary](adr/0074-exact-command-temporal-activity-boundary.md)
- [ADR-0075: optional production observability profile](adr/0075-optional-production-observability-profile.md)
- [ADR-0076: append-only Worker event WAL](adr/0076-append-only-worker-event-wal.md)
- [ADR-0067: Cube POSIX volumes and Kopia authority](adr/0067-cube-posix-volumes-and-kopia-workspace-authority.md)
- [ADR-0068: Session-resident Cube and POSIX Workspace continuity](adr/0068-session-resident-cube-and-posix-workspaces.md)
- [ADR-0069: Cube-only runtime and Workspace-first conversations](adr/0069-cube-only-runtime-and-workspace-first-conversations.md)
- [ADR-0070: Atomic terminal events and hard-crash recovery suffix](adr/0070-atomic-terminal-events-and-crash-recovery-suffix.md)
- [ADR-0071: SDK-only Pi runtime](adr/0071-sdk-only-pi-runtime-and-current-format-only-restores.md)
- [ADR-0072: Trusted Workspace Volume envelope](adr/0072-trusted-workspace-volume-envelope.md)
- [ADR-0073: Trusted platform Git metadata](adr/0073-trusted-platform-git-metadata.md)
- [ADR-0077: Active Pi steer](adr/0077-explicit-active-pi-steer.md)
- [ADR-0078: Worker Control Channel and optional modules](adr/0078-worker-control-channel-and-optional-product-modules.md)
- [ADR-0079: Interrupted Pi conversation checkpoints](adr/0079-interrupted-pi-conversation-checkpoints.md)
- [ADR-0080: Frozen cloud steps and recoverable Tool execution](adr/0080-cloud-step-and-recoverable-tool-execution.md)
- [ADR-0081: Per-sampling Step world state](adr/0081-per-sampling-cloud-step-world-state.md)
- [ADR-0082: Cloud Turn, Attempt and Step contexts](adr/0082-cloud-turn-attempt-and-step-contexts.md)
- [ADR-0083: Model sampling-attempt identity](adr/0083-model-sampling-attempt-identity.md)
- [ADR-0084: Explicit bounded settlement gate](adr/0084-explicit-bounded-settlement-gate.md)
- [ADR-0085: Single-active Cube Tool execution](adr/0085-single-active-cube-tool-execution.md)

See the [ADR index](adr/README.md). Retired ADRs remain available in Git history,
not as supported runtime choices.
