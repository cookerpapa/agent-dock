# AgentDock

AgentDock is an unofficial, cloud-oriented coding-agent runtime built around
the Pi RPC runtime. The goal is not to wrap Pi in a web page, but to build the control
plane and execution infrastructure required to run coding agents safely and
reliably for multiple users.

## Project positioning

The finished system should demonstrate:

- ordered, durable agent sessions;
- real-time agent and tool event streaming;
- isolated workspaces and sandboxed tool execution;
- cancellation, approval, retry, eviction, and recovery;
- tenant quotas, scheduling, leases, and backpressure;
- subagent trees with independent context and resource budgets;
- Git worktree isolation for concurrent writing agents;
- observability, load testing, and failure-injection evidence.

This repository is intentionally documentation-first. Business code should be
added one verified vertical slice at a time.

## Planned architecture

```text
Browser / CLI
    |
    | REST + SSE
    v
TypeScript Control Plane (NestJS)
    |-- session mailbox and turn scheduler
    |-- sandbox leases and fencing tokens
    |-- approvals, quotas, usage, event index
    |-- PostgreSQL + MinIO/S3
    |
    | versioned command/event protocol
    v
TypeScript Sandbox Supervisor
    |-- pinned Pi RPC child process
    |-- event spool and session snapshots
    |-- extension Web-UI bridge
    |-- sandbox lifecycle and heartbeats
    v
Docker / Kubernetes Sandbox
    |-- isolated workspace
    |-- shell, compiler, tests, Git worktrees
    `-- CPU, memory, PID, disk, time, and network limits
```

## Initial technology choices

- Control plane: TypeScript, Node.js, NestJS with the Fastify adapter
- Runner: TypeScript supervisor plus a pinned `pi --mode rpc` child process
- Internal protocol: versioned TypeBox schemas over an outbound WebSocket
- Browser event delivery: SSE with resumable sequence numbers
- Metadata and durable commands: PostgreSQL with Kysely
- Session/workspace artifacts: MinIO locally, S3-compatible storage later
- Sandbox: Docker first, Kubernetes later
- Frontend: React, kept deliberately small
- Observability: OpenTelemetry, Prometheus, Grafana, Loki, Tempo
- Tests: Vitest, Testcontainers, k6, Toxiproxy

Kafka, Flink, Redis, Temporal, billing, RAG, mobile applications, and IDE
plugins are not part of the initial implementation. They should be introduced
only after a measured requirement appears.

## Core invariants

1. A session has at most one normal active turn at a time.
2. A command is durably stored before the API reports it as accepted.
3. Reusing an idempotency key never creates a second turn.
4. Only the runner holding the current fencing token may mutate a session.
5. Every session event has a monotonically increasing sequence number.
6. Cold sessions consume no dedicated process, OS thread, or sandbox.
7. A tool with external side effects is never blindly described as exactly-once.
8. Two writer agents never modify the same worktree concurrently.
9. Tenant workspaces, session state, artifacts, and secrets are isolated.
10. Every milestone has executable acceptance tests and failure tests.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Initial backlog](docs/BACKLOG.md)
- [Vibe coding playbook](docs/VIBE_CODING_PLAYBOOK.md)
- [Implementation log](docs/IMPLEMENTATION_LOG.md)
- [Extension compatibility matrix](docs/EXTENSION_COMPATIBILITY.md)
- [Web UI direction](docs/WEB_UI_DIRECTION.md)
- [Agent cloud runtime landscape research](docs/research/2026-07-18-agent-cloud-runtime-landscape.md)
- [ADR-0001: runtime language and Pi integration](docs/adr/0001-runtime-language-and-pi-integration.md)
- [ADR-0002: versioned AgentDock event envelope](docs/adr/0002-versioned-event-envelope.md)
- [ADR-0003: state ownership and ACK boundary](docs/adr/0003-state-ownership-and-acknowledgement-boundary.md)
- [ADR-0004: command delivery, sequence, leases, and fencing](docs/adr/0004-command-delivery-sequence-and-fencing.md)
- [ADR-0005: pluggable execution and recovery tiers](docs/adr/0005-pluggable-execution-recovery-tiers.md)
- [ADR-0006: v0 scope, model profiles, and credentials](docs/adr/0006-v0-product-scope-model-profiles-and-credentials.md)
- [ADR-0007: supervisor execution handshake and model snapshot](docs/adr/0007-supervisor-execution-handshake-and-model-snapshot.md)
- [ADR-0008: durable event ACK and resumable SSE replay](docs/adr/0008-durable-event-ack-and-sse-replay.md)
- [ADR-0009: durable turn cancellation and process-exit confirmation](docs/adr/0009-durable-turn-cancellation.md)
- [ADR-0010: ephemeral Docker sandbox and bounded final patch](docs/adr/0010-ephemeral-docker-sandbox-and-bounded-patch.md)
- [ADR-0011: settled checkpoint commit and cold restore](docs/adr/0011-settled-checkpoint-commit-and-cold-restore.md)
- [ADR-0012: crash-safe supervisor event spool and restart replay](docs/adr/0012-crash-safe-supervisor-event-spool.md)
- [ADR-0013: explicit session mailbox order and queued follow-ups](docs/adr/0013-explicit-session-mailbox-order.md)
- [ADR-0014: lease renewal and assignment reconciliation](docs/adr/0014-lease-renewal-and-assignment-reconciliation.md)
- [ADR-0015: authenticated supervisor registration and durable health](docs/adr/0015-supervisor-registration-and-health-management.md)
- [ADR-0016: authenticated outbound supervisor WebSocket transport](docs/adr/0016-supervisor-websocket-transport.md)
- [ADR-0017: two-phase remote command delivery](docs/adr/0017-two-phase-remote-command-delivery.md)
- [ADR-0018: supervisor reconnect and generation recovery](docs/adr/0018-supervisor-reconnect-and-generation-recovery.md)
- [ADR-0019: cross-instance supervisor command ownership](docs/adr/0019-cross-instance-supervisor-command-ownership.md)

## Current executable spikes

The first compatibility boundary lives in
[`spikes/pi-extension-compat`](spikes/pi-extension-compat). It starts a real,
pinned Pi RPC process, loads an extension, bridges a confirm/notify exchange,
maps that exchange through the public event contract, and verifies clean
shutdown without spending model tokens. The reusable TypeBox contract and Pi
adapter live in [`packages/protocol`](packages/protocol) and
[`packages/sandbox-supervisor`](packages/sandbox-supervisor). The same live
exchange now passes through the versioned supervisor wire contract and a bounded
reference spool that verifies cumulative ACK and reconnect replay behavior.

The execution-density experiment lives in
[`spikes/pi-embedded-rehydrate`](spikes/pi-embedded-rehydrate). Without calling
a model or spawning a Pi child process, it runs three logical Pi sessions in one
Node worker, recreates and disposes the SDK runtime for every activation,
restores messages and `appendEntry` extension state from JSONL, enforces
same-session FIFO plus bounded cross-session concurrency, and resumes through a
fresh backend instance using only a durable checkpoint path. This backend is for
trusted portable extensions only; it does not weaken the production sandbox
boundary.

An explicitly enabled live-provider probe shares the same embedded boundary and
has verified ChatGPT-subscription token usage plus JSONL rehydration across a
fresh backend instance. The embedded worker owns the environment-aware HTTP
bootstrap that Pi's CLI would otherwise perform. The probe is never part of
`npm run check`, disables tools and extensions, uses temporary session state,
and requires an explicit quota-consumption environment flag.

The deterministic model boundary lives in
[`packages/fake-model-server`](packages/fake-model-server). It serves real
OpenAI-compatible HTTP/SSE on loopback and the pinned Pi `0.80.10` adapter
contract-tests text, fragmented tool calls, 429, request timeout, explicit
abort, malformed SSE, mid-stream disconnect, and a three-tool Java repair loop
without provider tokens.

## Local verification and CI

The same quality command used by GitHub Actions is reproducible from a clean
checkout:

```bash
npm ci --ignore-scripts
npm run ci
```

It checks Prettier formatting, the production frontend build, TypeScript types,
the complete unit/contract suite, the two zero-token Pi spikes, and
high-severity dependency advisories. The separate
Gitleaks job scans complete Git history with read-only repository permissions.
The opt-in live subscription probe is deliberately excluded from both commands.

The hardened Phase 0 runner topology, including its effective Docker
`HostConfig`, is exercised with:

```bash
npm run container:check
```

The complete zero-token Java workspace path builds the Phase 1 sandbox image,
inspects its effective isolation, runs Pi's `bash/edit/bash` repair loop, checks
outer-container cancellation, and then repeats the run through PostgreSQL and
SSE:

```bash
npm run sandbox:check
```

The complete Phase 1 user flow is available as a one-command local demo. It
builds the sandbox image and production frontend bundle, starts an ephemeral
PGlite-backed control plane plus independent execution/cancellation dispatchers,
and serves the Pi-export-inspired page at `http://127.0.0.1:4173`:

```bash
npm run demo
```

The demo uses the embedded deterministic model and sample Java fixture, so it
consumes no provider tokens or local Pi login. Its database is intentionally
ephemeral; press `Ctrl+C` to stop both loopback servers. The production
`src/main.ts` remains separately configured and does not silently start local
Docker workers.

## Current status

Phase 0: the public event envelope, Pi UI adapter, bidirectional
supervisor/control-plane wire contract, and executable ACK/replay semantics are
implemented. The local Pi RPC extension compatibility spike passes end to end,
and the embedded rehydration spike proves that cold logical sessions do not need
dedicated Pi processes. The domain package now enforces explicit session, turn,
sandbox, approval, and agent-node transitions plus allowlisted model-profile
resolution. The database package now supplies a 20-table Kysely/PostgreSQL
schema with executable ownership, idempotency, ordering, connection generation,
fencing, ACK, and usage constraints. A hardened two-service Docker Compose topology, pinned runner
images, and executable container-configuration contracts are implemented. The
two images and probes pass on Docker Engine `29.4.2` with Compose `5.1.3`. Runtime
inspection confirms UID/GID `1000:1000`, a read-only root filesystem, no network,
no host mounts or published ports, dropped capabilities, `no-new-privileges`,
and enforced CPU, memory, PID, and `/tmp` limits. The deterministic fake model
server makes streaming and provider failures executable without tokens.
Formatting, tests, zero-token spikes, dependency audit, effective container
checks, and full-history secret scanning are defined in GitHub Actions. Their
first hosted runs will occur after the repository is pushed. Phase 0 is complete.

Phase 1 now has a NestJS/Fastify durable-intake API, transactional outbox
dispatcher, and a local supervisor integration boundary. The public API
atomically creates a project/workspace and cold session, then accepts an
idempotent turn only after PostgreSQL commits the turn, command, and outbox rows.
The dispatcher acquires a durable session lease and monotonically increasing
fence, delivers a closed `turn.execute` command containing the immutable model
snapshot, persists the exact supervisor ACK, and only then lets pinned Pi
`0.80.10` receive the prompt. Pi text deltas and completion are translated into
versioned AgentDock events. Each event is stored with its command/lease/fence,
the contiguous database cursor advances in the same transaction, and only the
committed prefix is cumulatively ACKed to the supervisor spool. The session SSE
endpoint joins live delivery with durable `Last-Event-ID` replay without a
query/subscribe gap. Completion and post-ACK failure both release lease and
sandbox capacity transactionally.

The fourth Phase 1 slice adds durable cancellation as an independent command
path, so a cancel can reach Pi while the execute dispatcher is blocked awaiting
the model. The API returns `202` only after cancellation intent commits. A
side-effect-free supervisor ACK is then persisted as the race's linearization
point before Pi receives its native `abort`. On POSIX, an uncooperative Pi or
tool descendant is escalated through process-group `SIGTERM`/`SIGKILL`, and
`turn.cancelled` is published only after the complete group has disappeared.
The terminal event remains fenced, durable, ordered, resumable through SSE, and
owns final turn/session settlement. Natural completion wins if it commits first;
a post-ACK cancellation failure fails the session without returning an
unconfirmed sandbox reservation to the ready pool.

The fifth Phase 1 slice replaces the local workspace with an ephemeral Docker
activation. A trusted host-side runner starts a non-root, read-only,
networkless container with no bind mounts, Docker socket, ports, or inherited
credentials and with CPU, memory, PID, file-descriptor, `/tmp`, and workspace
limits. The container copies a sample Java repository into workspace tmpfs,
creates a baseline Git commit, and starts pinned Pi with only `bash` and `edit`
enabled. The deterministic model drives a failing test, one source edit, and a
passing verification test. Every tool boundary is durably ACKed through the
existing fenced event path, and `turn.completed` carries a validated, 64 KiB
bounded unified diff. Completion and cancellation both confirm that the outer
container is gone.

The sixth Phase 1 slice adds the React session surface. It retains Pi `/export`'s
compact monospace language, independently scrolling and keyboard-resizable tree
sidebar, narrow transcript, restrained user cards, unboxed Markdown assistant
text, and collapsible tool details. It creates project/session/turn resources
through REST, validates all public responses, and consumes SSE with a streaming
parser that sends `Last-Event-ID`, rejects identity/sequence violations,
deduplicates replay, and visibly reconnects. Tool lifecycle, cancellation,
terminal failure, approvals, the durable sequence cursor, sandbox status, and
the final diff have explicit non-color-only states. Remote Markdown images are
not fetched, and no Pi payload, credential reference, or provider token is
written to the DOM or browser console.

The full database-to-container path and Web demo use the embedded loopback fake
model, so they consume no subscription token. The demo deliberately retains the
in-process integration bridge, while the reusable runtime now also carries
registration, heartbeat, execute/cancel, command ACK/commit/result, and durable
event ACK over a real optional outbound-WebSocket gateway/client. The client
also performs bounded same-boot reconnect after transient transport loss. The
production HTTP entry point does not start either dispatchers or a fake
supervisor owner.
The current image embeds one trusted
sample fixture. At each successful settled boundary, Pi JSONL and a bounded,
hashed regular-file workspace manifest cross the private worker channel and are
stored by the trusted host before `turn.completed`; the next turn restores both
into a different ephemeral container. The demo therefore supports a genuine
same-session follow-up without keeping an idle Pi process alive.

The development object-store adapter is a private host directory coupled to the
ephemeral demo database; it is not MinIO/S3 or host-loss durability. Generic
repository import, policy-approved extension loading, a request-scoped model
gateway, production supervisor authentication/owner and automatic dispatch-worker
wiring, and cross-replica live fan-out remain separate work. Queued-turn withdrawal,
acknowledged-cancellation crash recovery, and Windows Job Object containment are
also deferred.

Supervisor event delivery now has a replaceable crash-safe file spool. The demo
uses it to atomically persist each closed `event.publish` before transport and
advance a synced cumulative cursor before deleting ACKed files. A fresh store
instance can scan and redeliver the pending suffix; a PostgreSQL integration
test proves that an event committed before its ACK connection fails is
re-ACKed after lease release without creating a duplicate row. This protects
already-produced events, but does not pretend to resume an in-flight tool or
settle an acknowledged command with an unknown execution outcome.

Long turns now use the existing closed supervisor heartbeat protocol. One
shared loop reports every active assignment with its lease/fence and produced/
ACKed event cursors; PostgreSQL renews only an exact, unexpired lifecycle match.
An omitted or stale renewal revokes the runtime, and post-ACK lease loss fails
the session instead of returning it to the ready pool. The trusted host can
inventory Docker activations by supervisor/boot/sandbox/command/session/turn/
lease/fence labels, re-inspect the complete identity before removal, and confirm
absence before settling `assignment_lost` or releasing capacity. An
unacknowledged command may retain its mailbox position and retry only after that
absence proof. Reconciliation is an explicit post-owner-exit boundary; it does
not infer that a supervisor process is dead merely because a lease timestamp
expired.

Supervisor registration and liveness now have a durable, transport-neutral
control-plane manager. A trusted provisioner must pre-create the exact
supervisor/boot/sandbox identity; untrusted registration JSON cannot invent it.
PostgreSQL records one current connection generation, transport ownership,
pinned runtime versions, capabilities, heartbeat policy, and expiry. Same-boot
reconnect supersedes the old connection, while a new boot fences and quarantines
the old sandbox. Timeout only enqueues a claimed/retryable retirement job: a
trusted host must first confirm that the exact boot can no longer create a
runtime, after which the existing reconciler may settle ambiguous work and
release capacity. A crashed retirement claimant can be replaced by another
control-plane instance. The gateway/client is optional library code; production
`main.ts`, a real provisioner credential, and the concrete Docker/Kubernetes
owner-process adapter are not yet wired.

The supervisor network contract is now executable through the
official Fastify WebSocket plugin and a sandbox-side `ws` client. Upgrade
authentication happens before the socket opens; a development authorizer keeps
only a bearer-token hash, while the interface can be backed by mTLS/SPIFFE or a
provisioner in production. The first frame must register, frames are processed
in order with payload/queue bounds, one negotiated heartbeat timer covers all
active assignments, and PostgreSQL rejects an old socket even when reconnecting
through another control-plane listener. Socket close still waits for durable
health expiry.

The process-lifetime reconnect client creates a fresh single-generation socket
after retryable failures, using bounded exponential backoff with jitter. It
first revokes and waits for every old assignment to settle, so reconnect cannot
overlap two Pi/tool processes for one session. Authentication, protocol, and
superseded-identity failures are terminal. The registration transaction now
persists the current `acceptingAssignments` drain state, and the remote backend
resolves its guarded lease coordinator at the start of each new command. A
committed command interrupted by disconnect is still failed as ambiguous rather
than replayed on the new connection.

Cross-instance command ownership uses the existing PostgreSQL claim transaction
instead of adding another broker. An execute dispatcher is eligible only when
its fixed sandbox has capacity and an unexpired, assignment-accepting connection
owned by the local control-plane instance. Cancellation follows the target
session lease to that sandbox's current connection owner and remains eligible
while the Supervisor is draining. When the same boot reconnects elsewhere, the
old replica returns `idle` without consuming an outbox attempt and the new owner
can claim immediately.

Capability `command.two_phase.v1` additionally enables multiplexed remote
execute/cancel delivery. The Supervisor prepares without starting Pi and returns
an exact ACK; only after the dispatcher persists `ACKNOWLEDGED/RUNNING` does the
control plane send `command.commit`. A failed persistence sends best-effort
`command.release`. Runtime completion/failure returns `command.result`, while
each spooled public event still waits for PostgreSQL commit and cumulative
`event.ack`. Wrong-stage or wrong-fence frames fail closed. Losing the shared
lease channel releases uncommitted preparations and revokes running assignments.
This preserves persist-before-side-effect ordering but does not claim
distributed exactly-once execution.

ADR-0006 fixes the first product slice as single-user and self-hosted with one
operator-configured default model profile. The durable model schema remains
selection-ready, while a frontend model picker and multi-tenant credential
flows are deliberately deferred.

Phase 1 is complete: from a clean checkout, `npm run demo` lets a user submit the
Java repair, watch all ten durable events and three tool calls, inspect the
bounded Git patch, or cancel a second run and observe confirmed sandbox teardown.
The first Phase 2 slice now adds cold Pi/workspace rehydration: a follow-up runs
in another container, sees the previous assistant message, verifies the
previous Java edit, continues event sequence numbers, and replaces the settled
checkpoint. Each accepted prompt now receives an immutable per-session mailbox
position allocated under a PostgreSQL row lock. Prompts submitted while a turn
is active are explicit queued follow-ups—not steer—and the Web page displays
their durable positions. A five-input integration test concurrently accepts the
four followers, forces tied timestamps, and proves strict FIFO, no overlap, and
idempotent replay without position gaps.
Phase 2 next addresses cross-replica live notification and the MinIO/S3
object-store adapter rather than keeping a process per conversation.
