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
abort, malformed SSE, and mid-stream disconnect without provider tokens.

## Local verification and CI

The same quality command used by GitHub Actions is reproducible from a clean
checkout:

```bash
npm ci --ignore-scripts
npm run ci
```

It checks Prettier formatting, TypeScript types, 112 unit/contract tests, the two
zero-token Pi spikes, and high-severity dependency advisories. The separate
Gitleaks job scans complete Git history with read-only repository permissions.
The opt-in live subscription probe is deliberately excluded from both commands.

The hardened Phase 0 runner topology, including its effective Docker
`HostConfig`, is exercised with:

```bash
npm run container:check
```

## Current status

Phase 0: the public event envelope, Pi UI adapter, bidirectional
supervisor/control-plane wire contract, and executable ACK/replay semantics are
implemented. The local Pi RPC extension compatibility spike passes end to end,
and the embedded rehydration spike proves that cold logical sessions do not need
dedicated Pi processes. The domain package now enforces explicit session, turn,
sandbox, approval, and agent-node transitions plus allowlisted model-profile
resolution. The database package now supplies an 18-table Kysely/PostgreSQL
migration with executable ownership, idempotency, ordering, fencing, ACK, and
usage constraints. A hardened two-service Docker Compose topology, pinned runner
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

The full database-to-Pi path is covered with the loopback fake model, so it uses
no subscription token. The in-process supervisor transport and local workspace
are integration scaffolding and are not started by the production HTTP entry
point. The event table and SSE API are production entry-point capabilities, but
live fan-out is currently process-local and the supervisor spool is memory-only.
Cancellation, a real isolated workspace transport, durable Pi/workspace
snapshots, lease renewal/reconciliation, and the React page are not connected
yet.

ADR-0006 fixes the first product slice as single-user and self-hosted with one
operator-configured default model profile. The durable model schema remains
selection-ready, while a frontend model picker and multi-tenant credential
flows are deliberately deferred.

The future React session page follows the compact Pi `/export` HTML visual
language—resizable tree sidebar, narrow transcript, monospace theme, and
collapsible tool/thinking blocks—while using AgentDock REST/SSE rather than
letting the browser manage Pi processes or JSONL directly.
