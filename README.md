# AgentDock

AgentDock is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi
SDK. It keeps the Agent Loop and provider credentials in a trusted Worker pool,
while every model-generated file or shell operation runs in a CubeSandbox KVM
microVM.

The current architecture deliberately has three durable authorities:

- PostgreSQL owns product state, the Run queue, attempts/leases/fences,
  canonical conversations and Pi Session records;
- Kafka owns the retained high-frequency live event log; Valkey is its bounded,
  rebuildable SSE projection;
- a persistent Cube Volume owns each Workspace's bytes.

Temporal, execution Cells, MinIO/S3 conversation checkpoints, Kopia Workspace
copies and alternate container runtimes are not part of the current product
path.

## Product

- browser registration/login with tenant-isolated conversations and Workspaces;
- Chat-style multi-round Pi conversations and resumable streaming;
- Pi Session tree navigation with focused/full-tree views and conversation forks;
- pure chat without Sandbox activation;
- lazy Cube activation, warm reuse and optional persistent Sandbox retention;
- a Workspace directory/source browser and conversation deletion;
- administrator-only hot model credentials and Cube proxy configuration.

## One user message

```text
Browser
  │ REST + resumable SSE
  ▼
Control Plane ── transaction ──► PostgreSQL Run queue
                                      │ LISTEN/NOTIFY + poll
                                      ▼
                              shared Pi Worker pool
                              Pi SDK + model gateway
                                      │ fenced Tool RPC
                                      ▼
                                  Tool Broker
                                      │ Cube API
                                      ▼
                               CubeSandbox KVM
                               persistent /workspace

Worker events ── durable batch ──► Kafka ── projection ──► Valkey ──► SSE
terminal message/Run state ───────────────────────────────► PostgreSQL
```

The Control Plane authenticates and commits an idempotent command before
acknowledging it. Any healthy Worker may claim ready work, but the existing
Run/Attempt lease and monotonically increasing fence decide whether it may
produce effects. PostgreSQL `NOTIFY` only removes polling latency; losing a
notification cannot lose a Run.

Pi's native `SessionStorage` port stores entries, operation records and
compaction boundaries directly in PostgreSQL. The production Worker uses a
thin cloud runtime around Pi's public `Agent`, Session and compaction
primitives: it reads only the newest compaction plus the active suffix and
appends complete messages incrementally. It does not download a lifetime
`session.jsonl`, synthesize model context from the browser transcript or
reimplement Pi's unused generic Harness surface.

The browser projects the same native parent-linked entries as a human-readable
conversation tree. “从此对话开始” creates an idempotent child Session by copying
the selected PostgreSQL branch; it does not download JSONL or copy/rewind the
shared Workspace.

The same opaque execution authority fences both Session mutations and remote
Tool admission. Lease and fence representations stay out of model messages and
Tool arguments, while unfinished Tool effects are recorded as unknown instead
of being replayed blindly.

The first Tool call attaches the Workspace's stable Cube Volume to a fresh or
warm KVM. Stopping a Cube loses processes, sockets and memory, but not files.
The committed Workspace revision is a bounded file/hash/Git-baseline reference,
not another archive of the directory.

## Recovery and correctness

- multiple Workers compete safely through transactional claims;
- one Session remains serialized without a permanently assigned process;
- every Pi Session mutation and Tool effect checks opaque execution authority;
- stale/expired Workers cannot commit messages or advance Workspace state;
- arbitrary shell operations are not blindly replayed after an ambiguous loss;
- interruption and Sandbox reset facts survive Pi compaction and Worker changes;
- browser-visible live bytes cross Kafka durability before SSE exposure;
- terminal conversation state is compacted into canonical PostgreSQL messages.

## Security boundary

- Cube receives no model, database, Kafka, Valkey, Kubernetes or Cube control
  credential;
- the Worker never executes user Bash and never receives the Cube management
  credential;
- the Tool Broker validates tenant, Workspace, Session, Run, Attempt, lease,
  fence and Cloud Step identity;
- public egress crosses a deployment-owned proxy that blocks private,
  link-local, metadata and platform destinations;
- provider/runtime policy and mounts are deployment-owned, never model-owned.

See [Architecture](docs/ARCHITECTURE.md),
[Run lifecycle](docs/RUN_LIFECYCLE.md) and
[Threat model](docs/THREAT_MODEL.md).

## Technology

TypeScript, Node.js 24, React, Fastify/NestJS, PostgreSQL/Kysely, Pi SDK,
Kafka, Valkey, Kubernetes/KEDA and Tencent CubeSandbox/KVM. OpenTelemetry,
Prometheus, Grafana and Jaeger are optional.

## One-host deployment

On x86_64 Debian/Ubuntu or WSL2 with systemd and KVM:

```bash
./install.sh
```

Open `http://127.0.0.1:8080`, create the designated administrator account and
configure the model. Useful operations:

```bash
./install.sh --check-only
npm run production:ps
npm run production:logs
npm run production:check
npm run production:long-context-check
npm run production:backup
```

`production:check` consumes real model tokens and exercises Cube KVM. The
long-context gate additionally requires
`AGENT_DOCK_LIVE_LONG_CONTEXT_CHECK=1`; it runs sustained coding Turns until Pi
performs native compaction, then verifies post-compaction coding and
cross-Worker recovery.

## Kubernetes deployment

The chart in `deploy/helm/agent-dock-platform` expects external PostgreSQL
(plus a direct notification endpoint), Kafka, Valkey, ReadWriteMany persistent
Workspace storage and Cube authorities. KEDA scales the shared Worker pool from
the PostgreSQL ready-Run backlog.

```bash
cp deploy/helm/agent-dock-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

Kubernetes scales Pods; the target environment still needs a node autoscaler.
See [Distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

## Verification

```bash
npm ci
npm run ci
npm run cubesandbox:template-check
npm run production:check
```

Only the final command requires a running production topology and explicit
real-token acknowledgement. Claims should always reference evidence from the
exact tested revision.
