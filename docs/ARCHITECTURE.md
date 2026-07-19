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
the prompt or credential material. Acceptance locks the session row and
allocates a positive, immutable `mailbox_position` from its durable
`next_mailbox_position` counter in the same transaction. The accepted public
resource exposes that position. A duplicate idempotent request returns the
original position and consumes no new one.

The multi-tenant HTTP surface also has `GET /v1/identity`,
`GET /v1/conversations`, and `GET /v1/conversations/:sessionId`. Authentication
resolves the tenant before a store is constructed; clients never select a
tenant. Lists are bounded to the newest 100 sessions, details to the newest 200
prompt turns, and foreign exact UUIDs return the same `404` as absent rows.
`POST /v1/registrations` is the sole optional anonymous route. It is disabled
by default and, when explicitly enabled for loopback validation, atomically
creates one bounded tenant/owner/profile/policy and returns an indexed owner
token once. Concurrent admission serializes on a stable tenant row so the
configured total count cannot be exceeded.

The second Phase 1 slice adds an explicit transactional-outbox dispatcher. It
claims one due command using `FOR UPDATE SKIP LOCKED`, locks the owning session,
and enforces lowest-nonterminal-`mailbox_position` order. Timestamp and UUID
order are not correctness inputs. The claim transaction
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

The Phase 2 ownership slice drives the existing heartbeat contract with one
shared loop per supervisor. A heartbeat batches every active session and its
turn, lease, fencing token, state, highest produced event sequence, and
cumulative ACK cursor. The control plane renews only an exact unexpired match
against the durable sandbox boot, command lifecycle, session/turn state, fence,
and event cursor. A missing renewal revokes that assignment. A heartbeat
transport/protocol failure quarantines the sandbox and revokes all assignments;
the runtime must finish teardown before the dispatcher records the failure.
Cold and queued sessions have neither a heartbeat timer nor a runtime.

Restart reconciliation is host-side and deliberately separate from lease
expiry. After the caller has fenced the old supervisor boot so it cannot create
another runtime, the reconciler lists only Docker containers labelled for that
sandbox, validates supervisor/boot/command/session/turn/lease/fence identity,
re-inspects immediately before `docker rm --force`, and confirms absence. Only
then may PostgreSQL settle an acknowledged ambiguous turn as `assignment_lost`,
remove its lease, and recompute capacity. A pre-ACK command can return to the
same mailbox position after absence is proven. Unknown containers, changed
labels, failed termination, and inconsistent durable identity fail closed and
leave the sandbox quarantined. A new supervisor boot never adopts the old
process or claims exactly-once recovery of tool side effects.

The transport-neutral production registration/health manager now makes that
caller boundary durable. A trusted provisioner pre-creates a
supervisor/boot/sandbox identity and supplies an authenticated transport ID;
registration JSON cannot create or claim a sandbox. PostgreSQL stores one
active connection generation per sandbox, its control-plane owner, pinned
runtime versions/capabilities, heartbeat policy, last observation, and expiry.
Same-boot reconnect atomically supersedes the old generation. An expired
connection cannot be revived, and a new boot uses a separate sandbox while the
old one is quarantined.

Timeout and new-boot fencing enqueue a separate durable retirement row rather
than deleting leases. A bounded claim first invokes a trusted owner boundary
whose success means the exact boot can no longer create runtimes; only then does
it call the assignment reconciler. Retryable failures are delayed, invariant or
identity failures are blocked, and an expired claim can be taken by another
control-plane replica. Heartbeat connection validation, liveness extension, and
lease renewal use one transaction, so registration supersession and an old
heartbeat have a database-defined order. `acceptingAssignments=false` blocks
new registered acquisitions without terminating current assignments.

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
The worker receives either the image-owned Java fixture or a trusted-host-
resolved, bounded workspace seed through its typed private protocol, restores it
into workspace tmpfs, creates a baseline Git commit, and starts pinned Pi with an explicit `bash/edit` tool
allowlist, and embeds the loopback fake model so the container can remain
networkless. Host and worker exchange a private, closed, versioned JSONL
protocol over attached stdin/stdout. Each worker event waits for the existing
durable control-plane ACK before Pi continues. A successful terminal event may
include a validated unified diff bounded to 64 KiB. Cancellation propagates to
Pi first and then requires exact-name outer-container removal confirmation.

This is a real sandbox/workspace transport. The Web demo still chooses the local
control-plane adapter; the production entry point composes the same boundary
through a two-phase outbound WebSocket, authenticated boot provisioning, bounded
remote dispatch lanes, and exact owner/inventory management. PostgreSQL event
persistence, cumulative ACK, SSE replay, cross-replica high-water notification,
and Docker execution are executable. Each production control-plane replica owns
one dedicated PostgreSQL listener; notifications wake a process-local hub, while
event bodies are always read from the durable table. The trusted Supervisor host
uses a private, crash-safe file spool that syncs every event before transport and
replays an unacknowledged suffix after reconnect. Controlled small public GitHub
repositories are accepted only as a normalized coordinate plus exact commit and
are provisioned as immutable seeds before Pi starts. Arbitrary/private Git
sources, policy-approved extensions, acknowledged-cancellation crash recovery,
and Windows Job Object containment remain later slices. A crash after durable
command ACK is treated as ambiguous and failed rather than replaying possible
tool side effects.

### TypeScript sandbox supervisor

Responsibilities:

- start and supervise a pinned `pi --mode rpc` child process;
- translate typed Pi commands/events into the versioned AgentDock contract;
- proxy extension UI requests and responses between Pi and the web client;
- spool unacknowledged events locally and replay them after reconnect;
- propagate cancellation and shutdown to the complete Pi/tool process tree;
- manage Git worktrees and workspace snapshots;
- report heartbeat, resource usage, and health.

### Trusted Supervisor host and production topology

`@agent-dock/supervisor-host` is the exclusive process owner for one stable
Supervisor identity. Every process start generates a fresh boot, sandbox, and
memory-only connection secret; network reconnects retain that boot. A private
fsynced ledger preserves bounded current/recent generations so owner-stop proof
cannot be invented after a restart. The host probes Docker, PostgreSQL, and S3,
provisions the boot through a file-backed enrollment credential, recovers its
event spool while drained, then becomes ready only after the outbound WebSocket
is registered.

The host alone receives the Docker socket and S3 credential. It composes the
Docker runner, disposable public-GitHub importer, PostgreSQL workspace-import
lease/seed resolver, local Supervisor, PostgreSQL checkpoint metadata adapter,
S3-compatible byte store, tenant model-credential resolver/gateway,
active/quarantine spool roots, reconnect client, and an authenticated private
management endpoint. The control plane receives neither Docker authority nor S3
credentials; Pi workers receive neither of those, database/API/owner credentials,
nor any long-lived provider credential. Fake workers have no network. Real-model
workers have only a Compose-internal route to the Supervisor gateway; only that
trusted host also has fixed provider egress. A one-shot importer joins only the
repository-egress bridge, receives no prompt or secret, and cannot join the
database, object-storage, management, model-runtime, or provider-egress
networks. The trusted Supervisor anchors that bridge in the bundled Compose
topology, so its reachable HTTP surfaces still require credentials or a turn
capability that the importer does not possess.
Every assignment inventory request is constrained again to a sandbox generation
known by this host's ledger, and a terminate/absence request must match that
generation's stable Supervisor and exact boot before Docker is inspected.
In the bundled object store, MinIO root authority is restricted to the storage
and idempotent bootstrap services. The host receives a distinct checkpoint
identity limited to bucket location/list and object get/put for one bucket; its
policy does not grant object deletion.

The supported Compose deployment adds persistent PostgreSQL and MinIO, explicit
migration/bootstrap jobs, one control-plane replica, one trusted host, static Web
ingress, isolated networks, private secret-file mounts, health checks, bounded
resources/logs, and four declared volumes. Only Web publishes a loopback port.
This topology is complete for the bounded private multi-tenant fixture and
controlled public GitHub commits with either a deterministic model or owner-
configured DeepSeek; it does not imply arbitrary/private repository,
arbitrary-provider/extension support, public SaaS,
Kubernetes, or direct Internet hardening. The running control plane is
tenant-neutral: it mounts no tenant API token and reads no default tenant or
profile. A verified bearer credential creates request scope, while one shared
Supervisor pool executes globally fair tenant work. Optional loopback
self-registration changes tenant admission convenience, not that threat model.
See ADR-0023, ADR-0025, ADR-0026, ADR-0027, ADR-0028, and the production
runbook.

### Model profiles and credentials

The control plane exposes tenant-owned allowlisted model profiles rather than
accepting raw provider endpoints from clients. Every tenant runtime policy owns
one default profile. New tenants use the deterministic fake; an owner-only Web/API
configuration may select an allowlisted DeepSeek model and replace its encrypted
API key. A session references the resolved profile; every
turn snapshots the resolved provider, model, thinking level, and opaque
credential-binding version so later policy changes do not rewrite history.

Credential material is not conversation state. Tenant provider keys are sealed
with AES-256-GCM and binding-specific associated data; only the control plane and
trusted Supervisor receive the deployment master-key file. The Supervisor
resolves the exact snapshotted version and substitutes a random, expiring,
request-limited per-turn gateway capability. Long-lived keys never enter Pi
JSONL, workspace snapshots, Docker arguments/environment/labels, browser events,
logs, or the untrusted tool environment. Provider-reported token counts are
persisted per tenant/turn; mutable monetary prices are not inferred. See
ADR-0006 and ADR-0027.

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
capabilities, `no-new-privileges`, no ports/binds/devices, and bounded CPU,
memory, PIDs, file descriptors, `/tmp`, and workspace tmpfs. It does not mount a
host repository or Docker socket. The embedded fake model requires no network or
real credential. The real-provider path joins only the validated internal model
network and uses the trusted request-scoped gateway; the Supervisor alone joins
provider egress, so Pi/tools never receive a long-lived provider credential.

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

It also stores model-profile policy, opaque credential bindings, tenant runtime
limits/fairness cursors, SHA-256 tenant API credential digests, the desired
session profile, and each turn's immutable resolved model snapshot. It never
stores provider tokens or plaintext tenant API tokens in ordinary rows.

Important uniqueness constraints include `(session_id, idempotency_key)`, one
positive execute-command `mailbox_position` per session, and
`(session_id, seq)`.

The initial Kysely migration also enforces tenant-consistent composite foreign
keys, one non-queued active turn per session, positive fencing tokens, bounded
sandbox capacity, approval outcome/state consistency, ACK cursors that cannot
advance beyond durable events, and non-negative usage. Multiple queued turns
remain legal and are consumed in explicit mailbox order. Non-execute control
commands have no mailbox position and therefore cannot be confused with the
prompt FIFO. Database checks constrain
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
that sequence and advanced the cursor in the same transaction. The in-memory
implementation remains a fast protocol reference. The file implementation
stores a hashed closed manifest per assignment and one hashed, canonical event
file per sequence. It atomically publishes and syncs an event before transport,
atomically advances the cumulative cursor before compaction, rejects corrupt or
gapped state, and redelivers pending files from a fresh store instance. Active
state is scoped by boot. When the current control plane permanently rejects an
exact publication as `stale_fence`, the store atomically moves the complete
assignment to a separate per-boot quarantine root and fsyncs a checksummed safe
rejection record; it neither fabricates an ACK nor deletes the original event.
Corruption, mismatch, unsupported rejection, or quarantine I/O failure remains
terminal. The spool assumes one trusted supervisor owns its private persistent-
volume root; it is not shared-filesystem coordination or process-memory
recovery. See ADR-0024.

## 4. Execution flow

1. Client submits a prompt with an idempotency key.
2. The control plane locks the session and stores the turn, positioned execute
   command, outbox record, and advanced mailbox counter transactionally.
3. The API returns `202 Accepted`.
4. The session coordinator acquires the session execution lease.
5. The scheduler assigns or creates a sandbox runner.
6. The supervisor validates the fencing token, resolves and reverifies the
   immutable workspace seed, and loads settled session/workspace state.
7. The selected execution backend activates Pi, loads policy-approved
   extensions, and executes the agent loop.
8. The supervisor translates and emits sequenced events; the control plane persists and ACKs them.
9. On `agent_settled`, the runner creates stable snapshots.
10. The control plane completes the turn and schedules the next mailbox command.

Steps 1-10 are executable for the bounded sample or controlled-GitHub workspace
path through the local integration boundary: the control plane acquires a real PostgreSQL
lease/fence, persists ACK before run,
activates an ephemeral hardened Docker workspace, and receives public text,
tool, and terminal events from pinned Pi. Step 8 stores each complete event plus
command/lease/fence identity, advances the session cursor and next sequence
atomically, and returns the cumulative ACK only after commit. The same durable
log, including the bounded final patch, is available through SSE and resumes
after a browser reconnect with `Last-Event-ID`. Step 9 uses a private
checkpoint-before-terminal ACK: Pi JSONL and a safe regular-file workspace
manifest are content-hashed, stored outside the container, recorded as artifact
metadata under the current fence, and restored into the next fresh container.
The latest durable `turn.completed` event is the snapshot commit marker, so a
worker crash after upload but before terminal publication falls back to the
previous settled pair. The demo adapter uses a private host directory. The
production adapter keeps the same provider-neutral logical keys in PostgreSQL
and conditionally stores bounded bytes in a configured S3-compatible
bucket/prefix. A digest-pinned localhost MinIO proof discards the writer and
restores through a fresh client; declared and streamed size limits, S3 checksum,
and the independent database hash fail closed on corruption. The supported
production topology composes this S3 path with the trusted remote Supervisor.
For a public GitHub source, PostgreSQL grants one expiring lease for the first
activation. A separate hardened Docker importer fetches the exact 40-hex commit,
removes `.git`, captures the existing safe manifest, and conditionally writes a
content-addressed seed below a tenant/workspace prefix. Publishing ready state
and the workspace pointer is one fenced transaction. Concurrent activations
wait; expired leases are reclaimable; stale owners cannot publish. Every turn
revalidates object key, size, digest, and manifest before the worker receives
the seed. A settled session checkpoint overlays that baseline, so a follow-up
neither reclones nor depends on GitHub availability. See ADR-0028.
The local file spool now protects already-produced events across a supervisor
process restart, including the PostgreSQL-commit/ACK-loss window. Unknown
in-flight execution is never recreated: after the old owner boot is fenced, the
host reconciler confirms its labelled runtime is absent and records the
acknowledged turn as ambiguous `assignment_lost`. The durable health manager now
automates timeout fencing, owner-stop confirmation, and retryable retirement;
registration/heartbeat and two-phase command/event delivery can cross a real
outbound WebSocket. The client now performs bounded same-boot reconnect only
after revoked assignments settle, and remote backends resolve the guarded
connection generation per command. Cross-instance claims follow the durable
socket owner as described below. `RemoteControlPlaneRuntime` now wires the shared
event store/hub, gateway, one connection-discovery loop, bounded per-capacity
execute/cancel lanes, and an independent maintenance loop. Shutdown prevents a
late discovery result from starting new lanes, detaches remote command waiters,
drains the lanes, and closes Nest in order. Production `main.ts` wires the
PostgreSQL credential authorizer, allowlisted boot provisioner, fixed authenticated
HTTP owner/inventory adapters, and explicit remote runtime. The separate
Supervisor host entry point supplies fresh boot identity, exact Docker inventory,
S3 checkpoint composition, and durable boot/spool volumes.

## 5. Delivery and recovery semantics

### Internal supervisor wire contract

Every internal message carries `protocolVersion`, `messageId`, `sentAt`, a
discriminator, and a closed typed payload. The contract is transport-neutral
JSON intended for the supervisor's outbound WebSocket connection.

Supervisor-to-control messages are registration, command ACK/result, event
publication, and heartbeat. Control-to-supervisor messages are registration
acceptance, turn execution/cancellation, command commit/release, approval
resolution, cumulative event ACK, permanent event rejection, and heartbeat ACK
with lease renewals.
Registration advertises the exact Pi/supervisor versions and capabilities. It
also declares the initial `acceptingAssignments` drain state so registration
cannot briefly reopen a drained supervisor. Post-registration mutations carry
a lease ID and fencing token.
The execute command additionally carries the turn's immutable provider, model,
thinking level, and opaque credential-binding snapshot; it never carries a
credential value or arbitrary provider endpoint.

Authentication is established by the transport/sandbox assignment rather than
by trusting tenant identity supplied by the sandbox. A heartbeat demonstrates
liveness but cannot make a stale fencing token current.

The implemented registration boundary requires an authenticated authority with
the exact supervisor, boot, sandbox, and fresh transport IDs. Exact same-channel
registration retransmission returns the original ACK; a cross-transport replay,
changed payload, superseded generation, or expired generation is rejected.

The optional gateway authenticates the HTTP Upgrade before opening the socket,
generates the fresh transport ID, requires registration as the first bounded
text frame, and serializes a bounded number of pending frames per connection.
It routes heartbeats through the durable manager and returns exact ACKs. The
sandbox client applies those ACKs through one server-negotiated heartbeat loop
covering all active assignments. A same-process reconnect proactively closes
the old socket; a cross-replica reconnect is rejected through PostgreSQL on the
old socket's next frame. Close alone does not prove process death.

The process-lifetime reconnect wrapper creates a new single-generation client
after retryable network, heartbeat, overload, or server failures. It uses
bounded exponential backoff with jitter and does not retry authentication,
protocol, normal-close, or superseded-identity outcomes. Before another socket
opens, the local supervisor must confirm that all assignments revoked by the
old lease channel have settled; timeout is terminal and requires owner
reconciliation. Operator drain state is applied before every registration.
Remote execution resolves a current connection-guarded lease coordinator once
per new command and retains it for that exchange. A reconnect restores future
command capacity, never an ambiguous committed tool execution. See ADR-0018.

If a current socket publishes an event under a lease/fence that has already been
permanently released by the control plane's ambiguous-failure decision, the
gateway sends an exact non-retryable `event.rejected(stale_fence)` without
closing that current socket. The client correlates it only to its pending
publication and the file spool quarantines the immutable delivery copy. All
other authentication, generation, schema, sequence, conflict, and service
failures retain fail-closed socket/error behavior. See ADR-0024.

When `command.two_phase.v1` is advertised, the connection also multiplexes
execute/cancel preparations, command ACK/commit/release/result, and event
publish/ACK. A preparation is side-effect free. The dispatcher persists its
acknowledged lifecycle before `command.commit` may invoke `run`; a failed
transaction best-effort sends `command.release`. Results are independently
bounded because runtime failures may precede a terminal public event. Event
authority is checked against both the current connection generation and the
sandbox holding the session lease before `DurableEventStore` commits it. Only
then is `event.ack` sent. Socket loss releases uncommitted work and locally
revokes committed assignments, while durable timeout/owner retirement remains
the external fence. See ADR-0017.

Remote dispatcher claims can carry an exact sandbox/control-plane affinity.
Execute eligibility requires a local active, unexpired, assignment-accepting
connection plus sandbox capacity; guarded lease acquisition repeats those
checks after the outbox lock. Cancellation eligibility instead joins the target
session lease to its sandbox's current connection owner and intentionally
ignores the drain flag. A wrong or stale owner returns `idle` without consuming
an outbox attempt. Same-boot reconnect changes this ownership through the
existing connection-generation transaction, so the current topology needs no
second command broker. See ADR-0019.

### Event and command semantics

- Public events use an AgentDock-owned, versioned, closed TypeBox union rather
  than raw Pi RPC objects. Version 1 carries `eventId`, `sessionId`, `turnId`,
  `agentId`, per-session `seq`, `occurredAt`, `type`, and a typed `payload`.
- `turn.completed` may carry a unified workspace patch. It is collected inside
  the sandbox, UTF-8 bounded to 64 KiB, and schema-validated before publication;
  the control plane never reads the live container filesystem to construct it.
  The collector marks only currently untracked paths as intent-to-add before a
  working-tree diff, so new files, tracked edits, and deletions remain visible
  together relative to the immutable imported baseline.
- Only session-level state events may use a null `turnId`; turn, tool, approval,
  assistant, and notification events require a concrete turn identity.
- Event validation succeeds before the supervisor spool accepts a sequence.
- Commands use at-least-once delivery plus durable idempotency. Command ACK says
  that the current fenced supervisor accepted responsibility, not that execution
  completed.
- Remote delivery is two-phase: ACK only records a side-effect-free preparation;
  `command.commit` starts work after the control-plane transaction, while
  `command.release` discards an uncommitted preparation. `command.result`
  returns bounded completion, cancellation, or safe failure metadata and does
  not replace the durable public event history.
- A prompt submitted while an earlier turn is active is accepted as a separate
  queued follow-up with its own mailbox position. It starts only after every
  lower nonterminal position settles and restores the latest committed
  Pi/workspace checkpoint. It never injects text into the active model loop.
  Steer requires a future explicit command/API and capability check.
- Events use contiguous per-session sequence numbers and at-least-once delivery.
  ACK is cumulative and means durably persisted, so an ACK lost in transit can
  safely cause replay.
- Duplicate current ACKs are idempotent. Regressing ACKs, ACKs beyond the highest
  publication, sequence gaps, and stale lease/fencing metadata are rejected.
- A permanent `stale_fence` event rejection is not an ACK. It preserves the
  rejected delivery copy in Supervisor quarantine and permits the same healthy
  boot to serve a distinct future command; it never changes the failed old turn
  or authoritative PostgreSQL event stream.
- `GET /v1/sessions/:sessionId/events` emits the session sequence as SSE `id`,
  the AgentDock event type as `event`, and the complete versioned event as JSON
  `data`. It subscribes before reading the durable suffix and deduplicates the
  replay/live overlap. Exact durable redelivery may be re-ACKed after lease
  release when the earlier ACK packet was lost; it cannot add or alter history.
- Event commit transactionally emits a PostgreSQL `NOTIFY` containing only the
  tenant, session, and durable high-water sequence. Each replica accepts valid
  hints for all tenants and uses `(tenant, session)` in the local hub to
  coalesce one high-water wake per exact SSE subscriber; it never queues event
  bodies. The stream reads the
  missing durable suffix on a wake and on an idle heartbeat, so duplicate or
  missed notifications cannot create a sequence gap. Listener reconnect wakes
  every local subscription.
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

The implemented client uses fetch-based SSE rather than native `EventSource` so
an explicit reconnect can send the last rendered sequence in `Last-Event-ID`.
It validates the shared event schema plus SSE `id`/`event` identity before
updating a pure transcript reducer; replayed sequences are idempotent and gaps
fail visibly. Vite proxies only `/v1` to the loopback demo control plane, keeping
browser requests same-origin without enabling permissive CORS. The local demo
starts ephemeral PGlite and independent execution/cancellation polling loops.
The production Web build requires the public bearer login, is served by a
non-root read-only Caddy container, proxies only `/v1`, rejects private internal
and health paths, and publishes the deployment's only loopback host port. Its
login card can request an opt-in self-service tenant, verify the returned
one-time owner token, and then list only that tenant's conversations. Token
change/logout clears transcript, conversation list, pending operations, SSE
cursor, and stream before another security context is rendered. Historical
selection loads bounded prompt metadata and then resumes the matching durable
SSE suffix; the token remains in memory rather than Web Storage or the URL.
