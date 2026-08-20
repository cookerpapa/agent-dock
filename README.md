# PiCloud

PiCloud is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi
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

### Current scheduling invariant

PiCloud has no user-, Session- or Workspace-to-Worker affinity. All healthy Pi
Workers compete for one PostgreSQL ready-Run queue, and any later Run may be
claimed by a different Worker. A `worker_id`/Supervisor identity recorded on a
RunAttempt means only “this Worker currently owns this leased Attempt”; it is
cleared or superseded with that Attempt and is not a routing preference.

Ordered migration files still contain retired table names so a new database can
replay the pre-production schema history. They do not describe the migrated
schema or maintained deployment. The current sources of truth are this README,
`docs/ARCHITECTURE.md`, `docs/RUN_LIFECYCLE.md` and the indexed current ADRs.

## Product

- browser registration/login with tenant-isolated conversations and Workspaces;
- Chat-style multi-round Pi conversations and resumable streaming;
- Pi Session tree navigation with focused/full-tree views, conversation forks,
  recursive subtree deletion and settled-message tail pruning;
- the pinned community `pi-subagents` workflow contract, with durable Child
  Sessions/Runs, deployment-bounded recursive Agent trees, focused/full tree
  navigation, cross-Worker supervisor messaging, and shared or isolated Cube
  execution;
- pure chat without Sandbox activation;
- lazy Cube activation, warm reuse and optional persistent Sandbox retention;
- a Workspace directory/source browser, isolated Web Terminal, and safe deletion;
- user-owned exclusive Cube development environments with reconnectable
  terminals and explicit pause/resume/release;
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

The tenant-scoped PostgreSQL adapter implements Pi's public `SessionRepo` and
`SessionStorage` ports. CI runs Pi 0.84.1's unmodified backend conformance suite
against it; PiCloud then adds separate transaction-scoped authority and
tenant-isolation contracts required by the cloud Worker path.

The browser projects the same native parent-linked entries as a human-readable
conversation tree. “从此对话开始” creates an idempotent child Session by copying
the selected PostgreSQL branch; it does not download JSONL or copy/rewind the
shared Workspace.

The same opaque execution authority fences both Session mutations and remote
Tool admission. Lease and fence representations stay out of model messages and
Tool arguments, while unfinished Tool effects are recorded as unknown instead
of being replayed blindly.

Built-in Tool visibility is also Run-scoped. A Session grant is frozen into the
accepted Run, the Agent Host registers only those Pi Tool proxies, and Tool
Broker independently verifies both the granted Tool name and its low-level
operation. Concurrent Agent runtimes in one Host never share a global Tool set.

Pi subagents use the maintained `pi-subagents` workflow and agent-profile
contract rather than a PiCloud-specific orchestration language. The package's
local child-process boundary is replaced by a PostgreSQL-backed Child Session
and Child Run on the same Worker pool. Eligible Child Runs may delegate again;
the resulting tree shares one root Run budget (depth 4, 32 nodes and 3 active
descendants by default), and every edge remains a durable fenced execution.
Tool-free reviewers consume no Cube;
`shared_serialized` children temporarily receive the parent's Cube authority;
`worktree:true` creates a trusted persistent-Volume fork and an independent
Cube while preserving the selected agent's independent `fresh`/`fork` context
policy, then returns the settled patch to the parent. Child Session entries and
compaction remain native Pi PostgreSQL records. The UI exposes each Child as a
typed, read-only branch and labels context inheritance separately from
Workspace sharing. `contact_supervisor` requests use a durable PostgreSQL
channel rather than Worker-local files, so parent and Child may coordinate on
different Worker replicas without replaying the Child task. Parent cancellation is relayed
to admitted children, and Worker capacity reserves a child lane so a pool of
waiting parents cannot starve every delegated Run.

The first Tool call attaches the Workspace's stable Cube Volume to a fresh or
warm KVM. Stopping a Cube loses processes, sockets and memory, but not files.
The committed Workspace revision is a bounded file/hash/Git-baseline reference,
not another archive of the directory.

The Workspace panel can also open an interactive Web Terminal. The Control
Plane derives tenant, Session and Workspace identity from the authenticated
browser request, then proxies a separate short-lived human terminal authority
through the Tool Broker to a fenced PTY inside Cube. A human terminal and an Agent Run
cannot write the same Workspace concurrently. Closing the terminal destroys its
Cube while retaining the persistent Workspace Volume; no public SSH port or
platform credential is exposed.

Ordinary users may also request an exclusive development environment for one
Workspace. PostgreSQL binds the allocation to the authenticated user while Tool
Broker creates one never-timeout Cube KVM. Reconnecting a terminal opens a new
PTY in the same VM; disconnecting does not stop background processes. Pause and
resume use Cube's native memory/filesystem lifecycle, while release destroys
the VM and preserves the persistent Workspace Volume. The allocation is a
Workspace writer, so ordinary Agent Runs remain queued until it is released.
Cube's cluster WebUI remains an operator console and is never the tenant
authorization boundary.

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
  fence, Cloud Step identity and the immutable Run Tool snapshot;
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
npm run production:product-surface-check
npm run production:subagents-check
npm run production:development-environment-check
npm run production:long-context-check
npm run production:backup
```

`production:check` consumes real model tokens and exercises Cube KVM. The
product-surface gate drives the same cookie-authenticated REST, SSE and
WebSocket APIs used by the browser, including tree/fork/prune, source browsing,
Terminal, Steer, Cancel, recovery and deletion. It also consumes real model
tokens and Cube capacity. The long-context gate additionally requires
`PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1`; it runs sustained coding Turns until Pi
performs native compaction, then verifies post-compaction coding and
cross-Worker recovery.

## Kubernetes deployment

The chart in `deploy/helm/pi-cloud-platform` expects external PostgreSQL
(plus a direct notification endpoint), Kafka, Valkey, ReadWriteMany persistent
Workspace storage and Cube authorities. KEDA scales the shared Worker pool from
the PostgreSQL ready-Run backlog.

```bash
cp deploy/helm/pi-cloud-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

Kubernetes scales Pods; the target environment still needs a node autoscaler.
See [Distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

## Verification

```bash
npm ci
npm run ci
npm run test --workspace @pi-cloud/pi-session-postgres
npm run cubesandbox:template-check
npm run production:check
```

Only the final command requires a running production topology and explicit
real-token acknowledgement. Claims should always reference evidence from the
exact tested revision.
