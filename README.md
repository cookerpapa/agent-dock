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

Every accepted Run freezes a credential-free logical Turn contract covering
the model, environment, Workspace base revision and Tool/network policy. Each
physical Attempt separately binds its Worker, lease and fence, while every
logical sampling boundary captures a Step and transient provider attempts stay
beneath it. Tool operations are bound to all three contexts. A short transport
disconnect reattaches to the same execution; loss
of the execution ledger or VM is shown as `UNKNOWN` and never causes an
automatic shell replay.

Transient 429/5xx model failures use Pi's bounded native retry inside the same
frozen Cloud Step. Every sampling attempt is separately budgeted and audited;
provider-level hidden retries remain disabled, cancellation interrupts
backoff, and Tool executions are never replayed by this mechanism.

An environment recipe may opt into a single project verification follow-up by
naming one offline command `settlement-gate`. The gate is default-off, runs
repository code only through the Cube Tool Sandbox, and can never loop beyond
one additional Pi continuation.

Pi preserves model order for sibling remote Tools because one Cube activation
admits one cancellable operation at a time. Cross-Session Runs and isolated
candidate activations remain parallel; shared Workspace/process effects do not.

See [Architecture](docs/ARCHITECTURE.md) for the state and message flows.

The distributed Kubernetes profile keeps Web and Control Plane stateless,
binds each Workspace to an immutable execution Cell, scales that Cell's
compatible Pi Workers from its Temporal Activity backlog with KEDA, and routes
exact Worker management over StatefulSet headless DNS. The default Worker Pod
hosts four bounded Pi runtime slots. PostgreSQL, Temporal, S3/Kopia, the shared
RWX Workspace volume and Cube remain external authorities. See
[Distributed Kubernetes deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

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

The Workspace row owns the committed directory head. A new conversation on an
existing Workspace immediately sees that head but starts with an empty Pi
transcript. Ordinary Runs sharing one Workspace are serialized and advance the
head with compare-and-set; explicit Fork/Candidate-Race Sessions remain
isolated branches until promotion.

The browser no longer has a special repository-import workflow. The Agent can
use normal `git`, package-manager and download commands inside the connected
Cube microVM. Public network access is routed through the deployment-owned
proxy and rejects private, link-local, metadata and platform destinations.
Cube mounts only the user-data child of the trusted POSIX Volume. Checkpoint
generation state and AgentDock's synthetic Git baseline both remain in the
trusted envelope, so a fresh `/workspace` contains only user files. A
repository explicitly created or cloned by the user remains ordinary
Workspace data.

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
9. Terminal Run settlement cannot overtake events that have not crossed the
   Worker's cumulative durable ACK barrier.

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
- optional OpenTelemetry, Prometheus, Grafana and Jaeger observability profile
- Vitest plus live Cube/model acceptance scripts

## Local production deployment

On a Debian/Ubuntu x86_64 Linux host or WSL2 distribution with systemd and KVM
enabled, run the idempotent installer:

```bash
./install.sh
```

It prepares the pinned host toolchain, Docker/K3s, Cube execution plane,
AgentDock services and Kubernetes Pi Worker Pool. It does not accept a model
key or account password; configure those from the administrator page after the
deployment is healthy. Use `./install.sh --check-only` for a read-only host
diagnosis and see [Production deployment](docs/PRODUCTION_DEPLOYMENT.md) for
options and the manual prepared-host path.

The underlying prepared-host commands remain available:

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run cubesandbox:init
npm run cubesandbox:cluster-install
npm run production:deploy
```

`production:deploy` starts the 15-service core product topology. Start the
optional five-service metrics and tracing stack with:

```bash
npm run production:up:observability
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
- [Architecture decisions](docs/adr/README.md)
- [Optimization boundary](docs/OPTIMIZATION_BOUNDARY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Sandbox Provider](docs/SANDBOX_PROVIDER.md)
- [CubeSandbox Provider](docs/CUBESANDBOX_PROVIDER.md)
- [Network matrix](docs/NETWORK_MATRIX.md)
- [Run lifecycle](docs/RUN_LIFECYCLE.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Production deployment](docs/PRODUCTION_DEPLOYMENT.md)
- [Distributed Kubernetes deployment](docs/DISTRIBUTED_DEPLOYMENT.md)
- [Implementation log](docs/IMPLEMENTATION_LOG.md)
- [Backlog](docs/BACKLOG.md)

## Current status

The repository implements the full vertical path from browser authentication
through durable Run orchestration, Pi SDK execution, Cube Tool execution,
streaming events, Pi/Workspace checkpoints and multi-tenant recovery. It also
contains horizontal Pi Worker manifests, Session-affinity scheduling,
administrator-owned hot configuration, fault/load evaluation and deployment
automation.

The active ADR set is intentionally pruned to decisions that still constrain
the current product or maintained optional modules. Retired designs remain
available through Git history and the implementation log; they are not
selectable runtimes.
