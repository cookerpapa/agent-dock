# AgentDock

AgentDock is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi SDK.
It separates the trusted Agent Loop from untrusted code execution and turns Pi
sessions, Workspace state, scheduling, streaming events and model access into a
durable cloud product.

The current production path is deliberately singular:

```text
Browser
  → NestJS Control Plane
  → Temporal Run Workflow
  → horizontally scalable trusted Pi Worker
  → authenticated Tool RPC
  → Sandbox Manager
  → CubeSandbox KVM microVM
```

There is no alternate container runtime or lower-security fallback.

## Product

An ordinary user sees:

- username/password login and optional public registration;
- a ChatGPT-style conversation surface;
- named conversations in the left sidebar;
- named Workspaces that can be created or selected for a new conversation;
- Pi-style streaming text, Tool calls, command output and code highlighting;
- a `/workspace` directory browser with committed files and previews;
- conversation deletion without deleting the shared Workspace.

A dedicated platform administrator lands on a separate settings page. The
administrator can rotate the deployment model credential/model and the
CubeSandbox outbound proxy configuration without restarting the cluster.
Tenant ownership does not grant platform administration.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ Browser                                                         │
│ login / conversations / Workspace directory / admin settings    │
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST + resumable SSE
┌───────────────────────────────▼─────────────────────────────────┐
│ Control Plane                                                   │
│ auth / tenants / sessions / Run admission / idempotency / CAS   │
│ PostgreSQL business state / MinIO immutable artifacts           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ one Workflow per accepted Run
┌───────────────────────────────▼─────────────────────────────────┐
│ Temporal                                                        │
│ durable timers / retries / cancellation / Worker matching       │
└───────────────────────────────┬─────────────────────────────────┘
                                │ capacity-aware soft affinity
┌───────────────────────────────▼─────────────────────────────────┐
│ Trusted Pi Worker pool                                          │
│ Pi SDK AgentSession / native JSONL restore / model gateway       │
│ bounded event spool / no untrusted local bash / no Cube key      │
└───────────────────────────────┬─────────────────────────────────┘
                                │ leased and fenced Tool RPC
┌───────────────────────────────▼─────────────────────────────────┐
│ Trusted Sandbox Manager                                         │
│ Cube lifecycle / assignment verification / checkpoint CAS       │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Cube API
┌───────────────────────────────▼─────────────────────────────────┐
│ Untrusted CubeSandbox microVM                                   │
│ /workspace / bash / edit / git / build / test                   │
│ no platform credentials / public-only proxy / bounded resources │
└─────────────────────────────────────────────────────────────────┘
```

Cold conversations do not retain a Pi process or microVM. A Run restores the
Pi-native checkpoint into any eligible Worker. Pure chat never provisions a
Sandbox. The first Tool call activates Cube; later Tool calls in the warm
Session reuse it while its idle lease remains valid. Eviction preserves the
Workspace through the trusted Volume/Data-Mover checkpoint path, not through
the Worker filesystem.

See [Architecture](docs/ARCHITECTURE.md) for the state and message flows.

## Durable state

PostgreSQL is authoritative for:

- tenants, users, roles and browser sessions;
- Projects, Workspaces, conversations, messages and Runs;
- RunAttempt leases, heartbeat, fencing tokens and terminal state;
- event sequence cursors, idempotency keys and Workspace head CAS;
- model/proxy configuration metadata and usage records.

MinIO/S3 stores immutable:

- Pi native JSONL segment manifests;
- Workspace/Kopia checkpoints;
- artifacts and Review Bundles.

The active Pi `messages[]` is reconstructed by the Pi SDK from its native
checkpoint. AgentDock does not rebuild model context from the rendered browser
transcript. Pi compaction therefore survives Worker movement and cold restore.

## Workspace model

A Workspace is the durable `/workspace` directory. It can be shared by
multiple conversations, while every conversation keeps an independent title
and Pi transcript:

```text
Workspace "order-service"
├── Conversation "fix flaky payment test"
├── Conversation "add idempotency key"
└── committed Workspace versions
```

The browser no longer has a special repository-import workflow. The Agent can
use normal `git`, package-manager and download commands inside the connected
Cube microVM. Public network access is routed through the deployment-owned
proxy and rejects private, link-local, metadata and platform destinations.

## Security invariants

1. Pi/model credentials remain in the trusted Worker and model gateway.
2. User commands execute only inside CubeSandbox KVM microVMs.
3. Tool requests are bound to tenant, Workspace, Session, RunAttempt, lease and
   monotonically increasing fencing token.
4. A stale Worker cannot execute a Tool or advance the Workspace head.
5. Cube receives no database, MinIO, model, platform or orchestration
   credential.
6. Public egress does not imply private-network or platform reachability.
7. One tenant cannot list, read or mutate another tenant's conversations or
   Workspaces.
8. Tool side effects are never blindly retried as exactly-once execution.

See [Threat model](docs/THREAT_MODEL.md) and
[Network matrix](docs/NETWORK_MATRIX.md).

## Technology

- TypeScript / Node.js 24
- NestJS with Fastify
- React
- PostgreSQL with Kysely
- MinIO/S3
- Temporal Server and TypeScript SDK
- Pi SDK and native Pi Session format
- Tencent CubeSandbox with KVM
- Kopia-backed trusted Workspace checkpointing
- OpenTelemetry, Prometheus, Grafana, Loki and Tempo
- Vitest plus live Cube/model acceptance scripts

## Local production deployment

Prerequisites are a Linux/WSL2 host with Docker, KVM, the local Cube cluster
installed by the repository scripts, and the private production environment
file initialized.

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run cubesandbox:cluster-install
npm run cubesandbox:init
npm run production:deploy
```

The Web product is served on:

```text
http://127.0.0.1:8080
```

Useful commands:

```bash
npm run production:ps
npm run production:logs
npm run production:check
npm run production:backup
```

`production:check` is the real CubeSandbox production acceptance path. It can
consume model tokens and must be run only with the required live-check
acknowledgement/configuration.

See [Production deployment](docs/PRODUCTION_DEPLOYMENT.md) for configuration,
backup, recovery and operator procedures.

## Verification

Zero-token checks:

```bash
npm run format:check
npm run build
npm run check
npm run security:audit
```

Targeted boundaries:

```bash
npm test --workspace @agent-dock/control-plane
npm test --workspace @agent-dock/sandbox-manager
npm test --workspace @agent-dock/web-ui
npm run cubesandbox:template-check
```

The live gate verifies the real Cube runtime, credential absence, network
policy, cross-tenant isolation, resource limits, cancellation, checkpoint
restore, multi-round Pi state and cleanup. Claims in the resume or project
documentation should be based on these reproducible measurements.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture decisions](docs/adr/)
- [Threat model](docs/THREAT_MODEL.md)
- [Sandbox Provider](docs/SANDBOX_PROVIDER.md)
- [CubeSandbox Provider](docs/CUBESANDBOX_PROVIDER.md)
- [Network matrix](docs/NETWORK_MATRIX.md)
- [Run lifecycle](docs/RUN_LIFECYCLE.md)
- [Production deployment](docs/PRODUCTION_DEPLOYMENT.md)
- [Implementation log](docs/IMPLEMENTATION_LOG.md)
- [Backlog](docs/BACKLOG.md)

## Current status

The repository implements the full vertical path from browser authentication
through durable Run orchestration, Pi SDK execution, Cube Tool execution,
streaming events, Pi/Workspace checkpoints and multi-tenant recovery. It also
contains horizontal Pi Worker manifests, Session-affinity scheduling,
administrator-owned hot configuration, fault/load evaluation and deployment
automation.

Historical ADRs, migration files and research reports remain as immutable
engineering history. They do not represent selectable runtimes in the current
product.
