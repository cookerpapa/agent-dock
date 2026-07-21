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
Trusted TypeScript Agent Runner
    |-- pinned Pi RPC child process and model capability
    |-- event spool and session snapshots
    |-- no Docker socket and no local untrusted tools
    |
    | authenticated narrow Tool RPC
    v
Trusted Sandbox Manager (only Docker-socket owner)
    |
    | explicit OCI runtime=runsc, platform=KVM
    v
Untrusted gVisor Tool Sandbox
    |-- isolated workspace, shell, compiler and tests
    `-- no platform credential/network; bounded CPU/memory/process/disk/time
```

## Initial technology choices

- Control plane: TypeScript, Node.js, NestJS with the Fastify adapter
- Runner: TypeScript supervisor plus a pinned `pi --mode rpc` child process
- Internal protocol: versioned TypeBox schemas over an outbound WebSocket
- Browser event delivery: SSE with resumable sequence numbers
- Metadata and durable commands: PostgreSQL with Kysely
- Session/workspace artifacts: S3-compatible object storage, with MinIO used as
  the disposable compatibility fixture and a private file adapter for the demo
- Sandbox: gVisor `runsc`/KVM only, with Docker Engine used as the trusted
  lifecycle mechanism
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
- [Threat model](docs/THREAT_MODEL.md)
- [Sandbox Provider contract](docs/SANDBOX_PROVIDER.md)
- [Network matrix](docs/NETWORK_MATRIX.md)
- [Run lifecycle](docs/RUN_LIFECYCLE.md)
- [Production deployment runbook](docs/PRODUCTION_DEPLOYMENT.md)
- [Release evidence process](docs/RELEASE_PROCESS.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Long-term Cloud Agent Platform plan](docs/PLATFORM_PRODUCT_PLAN.md)
- [Initial backlog](docs/BACKLOG.md)
- [Vibe coding playbook](docs/VIBE_CODING_PLAYBOOK.md)
- [Implementation log](docs/IMPLEMENTATION_LOG.md)
- [Extension compatibility matrix](docs/EXTENSION_COMPATIBILITY.md)
- [Web UI direction](docs/WEB_UI_DIRECTION.md)
- [Agent cloud runtime landscape research](docs/research/2026-07-18-agent-cloud-runtime-landscape.md)
- [Strong Sandbox Provider selection](docs/research/2026-07-20-strong-sandbox-provider-selection.md)
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
- [ADR-0020: cross-replica session event notification](docs/adr/0020-cross-replica-session-event-notification.md)
- [ADR-0021: S3-compatible settled checkpoint storage](docs/adr/0021-s3-compatible-settled-checkpoint-storage.md)
- [ADR-0022: remote control-plane worker lifecycle](docs/adr/0022-remote-control-plane-worker-lifecycle.md)
- [ADR-0023: production Supervisor host and self-hosted topology](docs/adr/0023-production-supervisor-host-and-self-hosted-topology.md)
- [ADR-0024: permanent event rejection and spool quarantine](docs/adr/0024-permanent-event-rejection-and-spool-quarantine.md)
- [ADR-0025: private multi-tenant identity and fair scheduling](docs/adr/0025-private-multi-tenant-identity-and-fair-scheduling.md)
- [ADR-0026: opt-in self-service registration and conversation discovery](docs/adr/0026-opt-in-self-service-registration-and-conversation-discovery.md)
- [ADR-0027: tenant model credentials and brokered Pi execution](docs/adr/0027-tenant-model-credentials-and-brokered-pi-execution.md)
- [ADR-0028: controlled public GitHub workspace import](docs/adr/0028-controlled-github-workspace-import.md)
- [ADR-0029: trusted Pi runner and remote tool sandbox](docs/adr/0029-trusted-pi-runner-and-remote-tool-sandbox.md)
- [ADR-0030: pluggable sandbox provider boundary](docs/adr/0030-pluggable-sandbox-provider-boundary.md)
- [ADR-0031: durable Run Attempt protocol](docs/adr/0031-durable-run-attempt-protocol.md)
- [ADR-0032: versioned Workspaces and GitHub Gateway](docs/adr/0032-versioned-workspaces-and-github-gateway.md)
- [ADR-0033: context and model governance](docs/adr/0033-context-and-model-governance.md)
- [ADR-0034: observability and reproducible evaluation](docs/adr/0034-observability-and-reproducible-evaluation.md)
- [ADR-0035: superseded Docker Sandboxes microVM Provider](docs/adr/0035-docker-sandboxes-microvm-provider.md)
- [ADR-0036: product operations and release evidence](docs/adr/0036-product-operations-and-release-evidence.md)
- [ADR-0037: browser accounts and a platform-managed model](docs/adr/0037-browser-accounts-and-platform-managed-model.md)
- [ADR-0038: gVisor-only untrusted tool execution](docs/adr/0038-gvisor-only-tool-execution.md)

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
npm run dependencies:harden
npm run ci
```

Pi 0.80.10 publishes an internal `npm-shrinkwrap.json`, so npm root overrides
cannot update two vulnerable transitive packages even though compatible patch
releases exist. `dependencies:harden` replaces only those two installed package
directories from exact npm aliases, verifies their actual versions, and fails
closed on a different Pi version. Production images run the same replacement
and check; the security audit reconciles only the two exact stale shrinkwrap
paths and still blocks every other high/critical finding.

It checks Prettier formatting, the production frontend build, TypeScript types,
the complete unit/contract suite, authenticated-backup cryptography, the two
zero-token Pi spikes, and high-severity dependency advisories. The separate
Gitleaks job scans complete Git history with read-only repository permissions.
Six parallel supply-chain jobs generate image CycloneDX SBOMs, retain complete
HIGH/CRITICAL reports, and reject fixable HIGH/CRITICAL findings. The opt-in
live subscription probe is deliberately excluded from these commands.

The hardened Phase 0 runner topology, including its effective Docker
`HostConfig`, is exercised with:

```bash
npm run container:check
```

The authoritative execution-plane gate builds the Tool image and refuses any
runtime except `runsc` with the KVM platform. It verifies the live gVisor guest
kernel, resource enforcement, credential and host `/proc` isolation,
cross-tenant workspaces, network denial, path/symlink escape, bounded output,
cancellation, exact cleanup, checkpoint capture, and a real pinned-Pi
remote-tool repair loop:

```bash
npm run sandbox:check
```

Host installation and fail-closed prerequisites are documented in
[`deploy/host/README.md`](deploy/host/README.md). The latest measured result is
in [`docs/reports/gvisor-sandbox-latest.md`](docs/reports/gvisor-sandbox-latest.md).

Portable settled-checkpoint storage is verified against a digest-pinned,
loopback-only, disposable MinIO fixture. The test creates no volume, spends no
model tokens, conditionally publishes immutable objects, destroys the writer,
restores through a fresh S3 client, detects remote corruption, and removes the
container afterward:

```bash
npm run object-store:check
```

The fixture proves S3 API compatibility; it is not a production MinIO version
or deployment recommendation.

The one-command demo now uses the supported persistent production topology; the
old whole-Pi ordinary-Docker demo was removed so there is no lower-security
execution path. It serves the product at `http://127.0.0.1:8080`:

```bash
npm run demo
```

`npm run demo` is an alias for `npm run production:deploy`. Public registration
and the platform model are controlled by the persisted production runtime
configuration described below.

## Self-hosted production deployment

The supported single-host production topology is reproducible from a clean
checkout:

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run production:deploy
npm run production:token
```

For a fresh loopback deployment that should allow browser-created test tenants,
opt in before the first initialization so the bounded setting is persisted in
the private runtime configuration:

```bash
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true \
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32 \
npm run production:deploy
```

It starts persistent PostgreSQL and MinIO, an authenticated remote control
plane, one trusted non-root Pi Agent Runner, a separate authenticated Sandbox
Manager, the Web ingress, and ephemeral Tool Sandboxes. Only the Sandbox
Manager owns the Docker socket. Pi and the tenant model credential remain in the
trusted Runner; `read/write/edit/bash` cross a narrow RPC boundary into a
mount-free, credential-free Tool Sandbox with `network=none`. Only the Web
ingress publishes a loopback port. The Manager now separates capability and
identity enforcement from a provider-neutral `SandboxProvider`; its sole
implementation is `GvisorSandboxProvider`. Every untrusted worker is explicitly
created with Docker `HostConfig.Runtime=runsc`, while Docker config fixes runsc
to KVM. Manager readiness and per-activation inspection attest a real gVisor
guest and fail closed without it. See the
[production runbook](docs/PRODUCTION_DEPLOYMENT.md) for host setup, secrets,
health, backup, upgrade, recovery, and the disposable full-topology acceptance
command.

This is production-complete for the bounded private multi-tenant Java fixture
and controlled GitHub repositories pinned to an exact commit (public by
default, private through an explicitly configured GitHub App),
with either the deterministic fake or an owner-configured DeepSeek model.
Request identity, roles, encrypted per-tenant provider credentials,
resource/event/checkpoint isolation, quotas, fair global dispatch, token usage,
opt-in loopback self-registration, and tenant-scoped conversation discovery
share one bounded Supervisor pool. Cold conversations retain durable Pi and
workspace checkpoints but consume no Pi child process, Tool Sandbox, dedicated
thread, or timer. The Web Session inspector exposes immutable Workspace
history/files/compare, safe Artifact previews, Runs/Attempts, tests,
usage/context, workspace operations, owner activity, and optional GitHub PR
delivery. Cold encrypted backup/restore and checksummed release evidence are
executable operator paths. It is not an arbitrary Git host, untrusted extension
host, public Internet SaaS, Kubernetes release, or direct Internet ingress.

## Current status

Phase 0: the public event envelope, Pi UI adapter, bidirectional
supervisor/control-plane wire contract, and executable ACK/replay semantics are
implemented. The local Pi RPC extension compatibility spike passes end to end,
and the embedded rehydration spike proves that cold logical sessions do not need
dedicated Pi processes. The domain package now enforces explicit session, turn,
sandbox, approval, and agent-node transitions plus allowlisted model-profile
resolution. The database package now supplies a 21-table Kysely/PostgreSQL
schema with executable ownership, idempotency, ordering, connection generation,
fencing, ACK, and usage constraints. A hardened two-service Docker Compose topology, pinned runner
images, and executable container-configuration contracts are implemented. The
two images and probes pass on Docker Engine `29.4.2` with Compose `5.1.3`. Runtime
inspection confirms UID/GID `1000:1000`, a read-only root filesystem, no host
mounts or published ports, dropped capabilities, `no-new-privileges`, and
enforced CPU, memory, PID, and `/tmp` limits. Fake activations have no network;
real activations have only the internal model-gateway network. The deterministic fake model
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
query/subscribe gap. A transactional PostgreSQL high-water notification now
wakes SSE connections on other control-plane replicas; those replicas always
read event bodies from the durable table, coalesce duplicate hints, reconnect
their dedicated listener with bounded jitter, and use the SSE heartbeat as a
missed-notification recovery poll. Completion and post-ACK failure both release
lease and sandbox capacity transactionally.

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

The fifth Phase 1 slice originally replaced the local workspace with one
ephemeral Docker activation containing Pi and its tools. ADR-0029 supersedes
that production boundary: pinned Pi now stays in the trusted non-root Runner,
with extension discovery and built-in local tools disabled, while one fixed
image-owned extension routes `read/write/edit/bash` to a separate ephemeral
Tool Sandbox. The Sandbox is read-only outside bounded tmpfs, has no bind mount,
Docker socket, port, network, or inherited credential, and has CPU, memory, PID,
file-descriptor, `/tmp`, and workspace limits. The deterministic model still
drives a failing test, source edit, and passing verification; every tool
boundary is durably ACKed, `turn.completed` carries the bounded unified diff,
and completion/cancellation confirm Sandbox removal.

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

The Web demo and routine CI/production acceptance use the embedded deterministic
model, so they consume no provider token. Production additionally supports an
explicit owner-configured DeepSeek profile: AES-256-GCM ciphertext stays in
PostgreSQL, the master key stays at the trusted control-plane/Supervisor boundary,
Pi receives only a short-lived gateway capability, and provider-reported token
usage is written per tenant/turn. The demo deliberately retains the in-process
integration bridge. The production entry point composes authenticated provisioning, the
outbound Supervisor WebSocket, registration/heartbeat, execute/cancel,
command ACK/commit/result, durable event ACK, bounded dispatch workers,
retirement maintenance, and graceful drain. The client performs bounded
same-boot reconnect after transient transport loss. The default project source
is one trusted sample fixture; a project may instead name a normalized public
GitHub `owner/repository` plus an exact 40-hex commit. At each successful settled
boundary, trusted Pi JSONL and a bounded, hashed regular-file workspace manifest
captured through the private tool channel are stored before `turn.completed`;
the next turn restores both into a fresh Pi activation and a different
ephemeral Tool Sandbox. Production therefore supports a genuine same-session
follow-up without keeping an idle Pi process or Sandbox alive.

The ephemeral demo still uses a private host directory coupled to its temporary
database. The production storage boundary now also has an S3-compatible adapter:
PostgreSQL retains the fenced logical pointers and independent hashes, while the
bucket retains immutable Pi/workspace bytes. A test discards the writer and
restores through a fresh client against disposable MinIO, so this path no longer
depends on one Supervisor host directory. The production Compose topology now
uses that adapter against persistent MinIO and keeps credentials only in the
trusted Supervisor host. For a GitHub source, one expiring PostgreSQL lease
elects a disposable, credential-free importer through the Sandbox Manager. It
fetches only the pinned commit on a dedicated egress bridge, rejects unsupported
files, removes Git metadata, and publishes a content-addressed immutable seed to MinIO. Every activation
reverifies that seed; the first Pi turn creates its Git baseline from it, and
follow-ups overlay the settled checkpoint without cloning again. Private
repositories, arbitrary URLs, submodules, LFS, branch refresh, pull-request
write-back, and repositories above the current manifest limits remain outside
the supported boundary. Policy-approved extension loading, queued-turn
withdrawal, acknowledged-cancellation crash recovery, and Windows Job Object
containment are also deferred.

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
control-plane instance. The production entry point now wires a file-backed
single-host provisioner, per-boot hashed WebSocket credentials, and a fixed
authenticated HTTP owner/inventory adapter to the trusted Supervisor host.

The supervisor network contract is now executable through the
official Fastify WebSocket plugin and a sandbox-side `ws` client. Upgrade
authentication happens before the socket opens; tests retain a development
authorizer, while production validates an expiring provisioned credential ID
and constant-time secret digest from PostgreSQL. The first frame must register, frames are processed
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

`RemoteControlPlaneRuntime` now composes those mechanisms into one explicit
process lifecycle. REST, SSE, remote event ingestion, and PostgreSQL notification
share the same durable event store and process-local wake hub. One discovery loop
creates bounded execute and independent cancellation lanes from each live
Supervisor's provisioned capacity; one separate maintenance loop expires
connections and advances retirement work. Lane count scales with live capacity,
not stored sessions, and no session receives a process, thread, socket, or timer.
Shutdown first stops new claims, rejects Supervisor upgrades, detaches transports,
waits for ambiguous exchanges to settle through the existing failure policy, and
then closes Nest. Production `main.ts` enables this topology only after all
file-backed secrets, bootstrap rows, the fixed Supervisor management endpoint,
provisioner, owner-stop proof, and assignment inventory have passed fail-fast
configuration and readiness checks.

Cross-replica browser delivery also reuses PostgreSQL instead of adding a second
event broker. Event commit transactionally emits only a versioned
tenant/session/sequence high-water hint; every control-plane replica keeps one
dedicated `LISTEN` connection and wakes its process-local subscribers. The hub
stores one coalesced sequence hint per subscriber, never event bodies, and SSE
then reads the contiguous durable suffix. Duplicate hints are harmless, listener
reconnect wakes all local streams, and heartbeat polling bounds recovery if a
hint is missed. Production `main.ts` wires this transport from `DATABASE_URL`.

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

ADR-0006 fixed the first product slice as single-user and self-hosted. ADR-0025
now adds private multi-tenant credentials (`owner`, `member`, `viewer`),
request-scoped stores and SSE, transactional admission quotas, tenant-prefixed
checkpoints, and least-recently-served global dispatch. The running control
plane has no configured tenant and does not mount a tenant API token. ADR-0026
adds explicitly enabled, capacity-bounded registration for the loopback
deployment plus authenticated recent-conversation discovery. ADR-0037 adds
username/password browser accounts with revocable persistent cookies and makes
the platform operator's encrypted model the inherited backend default. The
product UI has no model picker or bearer-token prompt. It does not claim email
verification, password recovery, OIDC, billing, abuse controls, or a public-SaaS
threat model.

Phase 1 is complete: the persistent Web product accepts a turn, streams durable
events and remote tool calls, exposes the bounded Git patch, and confirms gVisor
Sandbox teardown after completion or cancellation. The disposable
`npm run production:check` reproduces this path with a deterministic model from
a clean checkout; `npm run demo` starts the same supported deployment for
interactive use.
The first Phase 2 slice now adds cold Pi/workspace rehydration: a follow-up runs
in another container, sees the previous assistant message, verifies the
previous Java edit, continues event sequence numbers, and replaces the settled
checkpoint. Each accepted prompt now receives an immutable per-session mailbox
position allocated under a PostgreSQL row lock. Prompts submitted while a turn
is active are explicit queued follow-ups—not steer—and the Web page displays
their durable positions. A five-input integration test concurrently accepts the
four followers, forces tied timestamps, and proves strict FIFO, no overlap, and
idempotent replay without position gaps.
The S3-compatible checkpoint adapter is now complete and MinIO-tested. Phase 2
now also has an explicit remote control-plane composition whose bounded workers
automatically execute and cancel real WebSocket Supervisor work while maintenance
continues independently. The production slice supplies the concrete trusted
Supervisor/Pi Runner, separate socket-owning Sandbox Manager, fresh boot
identity, exact owner-stop/inventory proof,
file-backed public/enrollment/management credentials, S3 checkpoint composition,
private networks, persistent volumes, pinned images, Web ingress, and executable
restart/scale/recovery acceptance. Permanently stale post-disconnect spool events
are explicitly rejected and checksummed in quarantine; an ambiguous committed
command is failed and never replayed.

The controlled GitHub workspace slice is also executable in production. The Web
new-workspace panel accepts either the sample or a normalized public GitHub
repository pinned to an exact commit SHA. An opt-in live command imports a tiny
repository, runs two real Pi/DeepSeek turns with tools, verifies a cumulative
patch and token ledger, proves the immutable seed is reused, and confirms that
no importer survives:

```bash
AGENT_DOCK_LIVE_GITHUB_CHECK=1 npm run production:github-check
```

Routine CI and `npm run production:check` remain deterministic and consume no
provider quota. See ADR-0028 and the production runbook for the source limits
and trust boundary.
