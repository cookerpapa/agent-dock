# AgentDock

AgentDock is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi
SDK. It separates the trusted Agent Loop from untrusted code execution and
makes conversations, Workspaces, streaming output and recovery durable across
replaceable Workers.

The production runtime is intentionally singular: Pi runs in a trusted Worker
and `read/write/edit/bash` execute only inside a CubeSandbox KVM microVM. There
is no container-runtime fallback.

## What users get

- browser login, optional public registration and tenant-isolated data;
- a conversation UI with resumable streaming text and Tool results;
- named Workspaces that can be selected when a conversation is created;
- automatic or persistent per-conversation Sandbox retention;
- a committed `/workspace` directory and source-file browser;
- conversation deletion without deleting a shared Workspace;
- a separate administrator page for hot model credentials and Cube proxy
  settings.

Pure chat does not create a Sandbox. The first Tool call activates Cube, and
later Runs may reuse the same exact-Session process world while it remains
healthy. Cold conversations retain neither a dedicated Pi process nor a
microVM.

## Architecture

```text
Browser
  │ REST + resumable SSE
  ▼
Web / Control Plane / Event Gateway
  │ durable Run admission
  ▼
Temporal
  │ one Workflow per accepted Run
  ▼
Trusted Pi Worker pool
  │ Pi SDK + native Session restore + model gateway
  │ leased and fenced Tool RPC
  ▼
Sandbox Domain Tool Broker
  │ fenced Tool authority + Cube lifecycle + Workspace checkpoint CAS
  ▼
CubeSandbox KVM microVM
    /workspace + bash/edit/git/build/test
    no platform credentials
```

The single-host profile packages this chain for one Linux/WSL2 host. The
distributed Helm profile keeps Web, Control Plane, Event Gateway, Pi Workers
and Tool Broker replicas replaceable. Lightweight execution Cells scale Pi
Workers from Temporal backlog; one Sandbox Domain can serve several Cells and
scale Cube compute and Workspace movement independently.

### One message through the system

1. The Control Plane authenticates the user, serializes ordinary Runs sharing
   one Session/Workspace and commits the accepted command to PostgreSQL.
2. The Outbox relay starts or adopts a deterministic Temporal Workflow and
   records that handoff separately from Worker acknowledgement. Temporal then
   durably schedules the Run to an eligible Worker. A retry creates a new
   Attempt with new ownership; it does not blindly replay a Tool.
3. The Worker restores the latest Pi-native checkpoint from S3 and opens it
   with the Pi SDK, so Pi—not the browser transcript—reconstructs model
   context and compaction state.
4. Model text and Tool events enter the Worker WAL, cross the Kafka durability
   boundary in ordered batches, and are projected into a bounded Valkey replay
   view before SSE can expose them.
5. If Pi calls a Tool, the Worker presents a short-lived lease/fence-bound
   capability to the Tool Broker. The Broker lazily creates or reuses the
   Session's Cube microVM and executes the operation there.
6. On settlement, the canonical conversation Turn, terminal event, Pi
   checkpoint pointer, Workspace head and Run state commit together. A later
   Worker can then resume from that boundary.

See [Architecture](docs/ARCHITECTURE.md) and
[Run lifecycle](docs/RUN_LIFECYCLE.md) for the detailed protocols.

## Durable state and recovery

| Authority | Data |
| --- | --- |
| PostgreSQL | accounts, Sessions, Runs/Attempts, leases/fences, canonical completed Turns, sequence cursors and Workspace head CAS |
| Temporal | durable Run Workflow, retries, cancellation and timers |
| Kafka | accepted high-frequency Worker event batches |
| Valkey | bounded, rebuildable live SSE replay view |
| S3/MinIO | immutable Pi-native Session segments and object artifacts |
| Cube Volume + Kopia | durable `/workspace` checkpoints and cold restore |

Anything shown through SSE has first crossed a shared durable boundary. Raw
token deltas do not grow PostgreSQL forever: the terminal transcript is stored
as one canonical Turn, the live Valkey suffix is trimmed after its replay
window, and Kafka retention remains long enough to rebuild that suffix.

Pi Session JSONL is the model-context authority. Compaction, interrupted-turn
markers and execution-world reset facts survive cold restore without AgentDock
inventing a second `messages[]` implementation.

Timeouts, leases and retention are checked as ordered recovery budgets. For
example, a Tool's execution limit is shorter than its RPC timeout, model
Capabilities outlive a Pi Turn, Worker termination grace covers settlement,
and Kafka retention outlives the Valkey replay window. See
[Configuration](docs/CONFIGURATION.md) and
[ADR-0094](docs/adr/0094-cross-component-time-and-retention-budgets.md).

## Security boundary

- Pi, provider authentication and model credentials stay in trusted Workers.
- User and repository commands run only in CubeSandbox KVM microVMs.
- Cube receives no database, S3, Temporal, Kubernetes, model or Cube-management
  credential.
- Tool authority binds tenant, Workspace, Session, Run, Attempt, lease and a
  monotonically increasing fencing token.
- Stale Workers cannot execute another Tool or advance the Workspace head.
- Public egress passes through a deployment-owned proxy that rejects private,
  link-local, metadata and platform destinations.
- Ambiguous shell outcomes become `UNKNOWN`; arbitrary side effects are never
  advertised or retried as exactly-once execution.

See [Threat model](docs/THREAT_MODEL.md) and
[Network matrix](docs/NETWORK_MATRIX.md).

## Technology

TypeScript, Node.js 24, NestJS/Fastify, React, PostgreSQL/Kysely, Temporal,
Kafka, Valkey, Pi SDK, MinIO/S3, Kopia, Kubernetes/KEDA and Tencent
CubeSandbox/KVM. Metrics and tracing are available through an optional
OpenTelemetry, Prometheus, Grafana and Jaeger profile.

## Deploy on one host

Requirements are an x86_64 Debian/Ubuntu Linux host or WSL2 distribution with
systemd and KVM enabled. The idempotent installer prepares the pinned host
toolchain, Cube execution plane and AgentDock services:

```bash
./install.sh
```

The installer does not ask for a provider key or account password. After the
deployment is healthy, open `http://127.0.0.1:8080`, create the designated
administrator account and configure the model from the administrator page.

Useful operations:

```bash
./install.sh --check-only
npm run production:ps
npm run production:logs
npm run production:check
npm run production:backup
```

`production:check` is the real Cube/model acceptance path and may consume
tokens. See [Production deployment](docs/PRODUCTION_DEPLOYMENT.md) for host
preparation, secrets, backup and recovery.

## Deploy on Kubernetes

The strict distributed chart is under `deploy/helm/agent-dock-platform`. It
expects external PostgreSQL/PgBouncer, Temporal, S3/Kopia, Kafka, Valkey, RWX
Workspace storage and Cube authorities. Start from the example values and run
the preflight before rollout:

```bash
cp deploy/helm/agent-dock-platform/values.distributed.example.yaml values.yaml
npm run distributed:preflight -- --values values.yaml
npm run distributed:deploy -- --values values.yaml
```

Kubernetes HPA/KEDA scales Pods; a provider-specific node autoscaler is still
required to add machines. Multi-node deployment and failure gates are in
[Distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

## Configuration

Configuration has three layers:

- administrator hot settings in PostgreSQL: model/key and Cube public proxy;
- restart-bound operator settings in the generated single-host `.env` or Helm
  values;
- installer-owned identities and secret files that must not be hand-edited.

Run `npm run production:config` after changing the single-host configuration.
Helm values are schema-validated. The complete supported surface and the
cross-component time/retention constraints are documented in
[Configuration](docs/CONFIGURATION.md).

## Verify a change

The zero-token repository gate is:

```bash
npm ci
npm run ci
```

Infrastructure-specific checks include:

```bash
npm run object-store:check
npm run cubesandbox:template-check
npm run production:check
```

Only the last command requires a running production topology and explicit live
model/Cube acknowledgement. Performance and reliability claims should be tied
to reproducible reports from the exact tested revision.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture decisions](docs/adr/README.md)
- [Configuration](docs/CONFIGURATION.md)
- [Production deployment](docs/PRODUCTION_DEPLOYMENT.md)
- [Distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Sandbox Provider](docs/SANDBOX_PROVIDER.md)
- [Roadmap](docs/ROADMAP.md) and [backlog](docs/BACKLOG.md)

The default product path is the one described above. Research capabilities
that are disabled by default are listed separately in
[Optional modules](docs/OPTIONAL_MODULES.md); retired runtimes remain only in
Git history and the implementation log.
