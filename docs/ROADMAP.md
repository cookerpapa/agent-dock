# Implementation roadmap

This file preserves the original aspirational phase roadmap, including optional
subagents and a future multi-node release. The single-node Kubernetes +
gVisor execution plane and demand-activated warm-Sandbox/event-batching upgrade
are now implemented under ADR-0039 and ADR-0040. The
dependency-ordered Cloud Platform Milestones 1–7 implemented for the current
private single-host product are tracked in
[`PLATFORM_PRODUCT_PLAN.md`](PLATFORM_PRODUCT_PLAN.md) and now include the
closed, versioned single-node Helm execution-plane chart under ADR-0048 and
transactional semantic conversation projections under ADR-0049. Do not
interpret completion of that product plan as a claim that the optional Phase 5
subagent tree or a validated multi-node release exists.

The dependency-ordered long-term product direction is maintained in
[`PLATFORM_PRODUCT_PLAN.md`](PLATFORM_PRODUCT_PLAN.md). This file preserves the
original phase history and current implementation status.

Assumption: one developer using AI-assisted implementation for roughly 15 hours
per week. Time ranges include verification, documentation, debugging, and the
work needed to understand and explain the generated system.

## Phase 0: compatibility spike and foundations (1 week)

Deliverables:

- a containerized Pi RPC compatibility spike that loads an unchanged extension;
- a sample extension command that performs a round-trip `ctx.ui.confirm()`;
- assertions for command discovery, UI request/response, notification, and clean shutdown;
- an initial extension capability matrix;
- repository conventions and architecture decision records;
- public event envelope and TypeBox command/event schemas;
- a source-backed execution/recovery capability model and no-token Pi SDK
  rehydration spike;
- a fixed v0 product/model/credential boundary and optional real-provider
  rehydration probe that cannot run from the default test path;
- database model and migration strategy;
- Docker Compose development environment;
- deterministic OpenAI-compatible fake model server;
- one scripted text stream, tool call, 429 response, timeout, and broken stream.

Exit criteria: a real Pi RPC child process loads an extension and completes a
web-style UI round trip without model tokens; provider failures can also be
reproduced deterministically.

## Phase 1: single-user vertical slice (2 weeks)

Deliverables:

- NestJS project/session/turn API;
- TypeScript supervisor using a pinned Pi RPC process behind an AgentDock adapter;
- one sandboxed Git workspace;
- prompt, streaming text, tool events, cancellation, and final diff;
- fenced PostgreSQL event ingestion and resumable session SSE;
- minimal Pi-export-inspired React session page using SSE;
- one operator-configured model profile; the domain remains model-selection
  ready without requiring a frontend picker.

Exit criteria: from a clean checkout, a user can ask Pi to fix a test in a
sample Java repository and observe the complete event flow.

Current status: complete. `npm run sandbox:check` proves the zero-token backend
path through runsc/KVM, and `npm run demo` starts the persistent Web product
using the same supported production topology. The page can submit, stream,
reconnect without duplicate events, cancel, and inspect the final diff. The
one-turn limitation was removed by the first Phase 2 settled-checkpoint slice
described below.

## Phase 2: durable sessions and mailbox (2 weeks)

Deliverables:

- PostgreSQL command queue and transactional outbox;
- session and turn state machines;
- idempotency keys;
- prompt, steer, and follow-up semantics;
- durable supervisor-side event replay and cross-replica live notification;
- Pi JSONL and artifact upload to S3-compatible storage, verified with MinIO;
- leases, fencing tokens, cold load, and settled-turn recovery.

Exit criteria: duplicate requests do not duplicate turns; five inputs to the
same session remain ordered; browser and runner reconnects do not lose events.

Current status: in progress. Durable intake, idempotency, session/turn state,
leases/fencing, PostgreSQL event replay, cross-replica live notification, and
sequential follow-up acceptance already exist. The first Phase 2 slice adds settled Pi JSONL plus bounded
workspace checkpoint upload/validation, PostgreSQL artifact pointers, cold
restore into a fresh Kubernetes gVisor Pod, and a Web follow-up on the same session.
Two-Pod tests prove that the second model request sees the prior Pi
conversation and that its tool sees the prior Java edit. A crash-safe local
supervisor spool now persists event publications before transport and proves
exact PostgreSQL redelivery after an ACK-loss restart. Prompt acceptance now
allocates a durable per-session mailbox position, including while another turn
is running. A five-input test concurrently accepts four followers and forces
tied timestamps, proving strict FIFO, no overlap, and idempotent replay without
a counter gap; the Web page exposes queue positions and labels active-session
submission as queued follow-up. Steer is specified as a separate future
operation rather than an implicit prompt mode.
Long-turn leases now renew through one shared supervisor heartbeat, while a
host-side identity-fenced reconciler removes orphan/expired Provider assignments,
fails acknowledged ambiguous work, safely requeues pre-ACK work, repairs
capacity, and retires an old sandbox only after runtime absence is confirmed.
A durable authenticated registration/health manager now owns connection
generations, exact same-boot reconnect, new-boot fencing, timeout quarantine,
and a retryable cross-replica retirement claim that requires owner-stop proof
before reconciliation. Settled checkpoint bytes can now use an immutable
S3-compatible adapter without changing the PostgreSQL pointer/CAS protocol. A
disposable MinIO test discards the writer, restores with a fresh client, and
detects collision, corruption, and oversize failures. A controlled public GitHub
path now imports an exact commit through a disposable network-limited gVisor Pod,
publishes one immutable S3 seed under an expiring PostgreSQL lease, and
reverifies it before each activation. Explicit steer and arbitrary/private Git
sources remain.
Registration and heartbeat now also pass through an authenticated, bounded,
ordered outbound WebSocket gateway/client, including cross-replica stale-socket
rejection. Capability-gated remote execute/cancel now preserves the local
prepare-before-run invariant through command ACK, durable lifecycle commit,
explicit commit/release, bounded results, and durable event ACK backpressure.
The sandbox client now reconnects transient same-boot failures with bounded
backoff, waits for revoked assignments to settle before opening a new
generation, preserves its drain state in registration, and resolves guarded
remote lease authority per command. It deliberately does not resume an
ambiguous committed tool execution. Execute claims are now eligible only on a
replica with a healthy local Supervisor and capacity; cancellation claims follow
the target session lease to that sandbox's current socket owner. PostgreSQL
owner affinity makes a separate cross-instance command broker unnecessary for
the current topology. An explicit remote control-plane composition now discovers
locally owned live connections, caps asynchronous execute/cancel lanes by
provisioned capacity, runs maintenance independently, shares one event authority
with REST/SSE, and drains sockets and in-flight dispatchers in order. The
production entry point now uses provisioned per-boot credentials, exact
owner-stop and Kubernetes assignment inventory, a trusted Supervisor host, and
S3-backed checkpoints rather than no-op adapters. Event ingestion emits a transactional
PostgreSQL high-water hint. Every production replica reconnects one dedicated
listener, coalesces wakes without copying event bodies, and makes SSE read the
durable suffix; heartbeat polling and `Last-Event-ID` retain correctness across
lost notifications and browser reconnects.

The bounded private multi-tenant production slice is deployable with pinned images,
private secret files/networks, persistent PostgreSQL/MinIO/boot/spool volumes,
explicit migration/bootstrap jobs, authenticated Web ingress, and a full
disposable restart/scale/recovery acceptance command. A permanently stale event
after an ambiguous control-plane interruption is now rejected without killing
the healthy Supervisor boot and is retained in checksummed quarantine. The
interrupted committed command remains failed and is never replayed. Phase 2
remains open for the explicit steer operation and broader product surfaces; the
production claim remains limited to the deterministic Java fixture and bounded
public GitHub repositories pinned to exact commits.

## Phase 3: sandbox and approval boundary (2-3 weeks)

Deliverables:

- trusted sandbox manager outside the Agent Runner;
- non-root image, resource limits, process-tree cancellation, and egress policy;
- Pi tool-policy extension and asynchronous approval flow;
- workspace snapshot and restoration;
- secret redaction and security-focused integration tests.

Exit criteria: cross-tenant filesystem access, host credential access, runaway
processes, and unapproved dangerous actions are blocked in repeatable tests.

Current status: the tool-execution boundary is complete for the supported
single-host slice. ADR-0029 splits the trusted Pi Runner from the Sandbox
Manager; Pi's built-ins are disabled and replaced through public operation
APIs. ADR-0039 moves lifecycle ownership behind a least-privilege Kubernetes
client, with no application-held Docker or containerd socket. ADR-0040 adds a
logical reservation so pure chat receives no Pod; the first Tool Call activates
a credential-free, networkless, non-root gVisor Pod that is warm-reused only by
the exact Session under newer fencing authority. Production
acceptance proves remote `bash/edit`, checkpoint/diff capture, cancellation,
exact cleanup, scoped Kubernetes authority, and secret absence. The old
whole-Pi ordinary-Docker runner and its demo/test protocol have been removed.
ADR-0045 can satisfy that first Tool activation from a small pool of
never-assigned, empty, default-deny gVisor Pods. Claim is single-consumption and
UID/resourceVersion fenced; a Pod that has seen tenant code can only remain
warm for that exact Session or be destroyed, never re-enter the clean pool.
User/project extensions, interactive approvals, and mutually hostile public
tenants are still outside the claim. The owner explicitly deferred extension
and approval work, so those items are not represented as silently complete.

ADR-0030 adds the long-term Provider seam: one provider-neutral Manager owns
capabilities and identity while the concrete Provider owns runtime operations.
ADR-0039 supersedes the direct-Docker lifecycle with
`KubernetesGvisorSandboxProvider`: K3s/containerd maps a fixed RuntimeClass to
`runsc`/KVM, while namespace RBAC and immutable Pod templates constrain the
Manager. The gate proves guest identity, resources, default-deny networking,
`/proc` and credential isolation, cross-tenant workspaces, bounded output,
cancellation, cleanup and the real Pi repair path.

ADR-0040 removes eager per-Run Pod creation and per-event remote ACK blocking.
It separates conversation and Workspace checkpoints, uses exact Session-scoped
warm reuse with revision/fence/UID verification, and publishes coalesced events
through a bounded asynchronous batch pipeline with cumulative ACK.

ADR-0049 keeps that full durable stream for audit/reconnect while materializing
terminal Turn transcripts transactionally. Completed conversation discovery is
now proportional to semantic text/Tool items; only active unprojected events
remain on the initial SSE replay path.

ADR-0042 makes the Project development environment durable and auditable. Runs
snapshot an append-only environment version; Manager policy and in-gVisor
toolchain preflight fail closed on drift; successful Tool checkpoints persist
concrete runtime evidence; and warm reuse now also requires exact environment
identity. Arbitrary user Dockerfiles remain intentionally outside this slice
until a separate trusted image-build and provenance plane exists.

This bounded tool-sandbox slice is resume-ready.

## Phase 4: multi-tenant scheduling (2-3 weeks)

Deliverables:

- authentication and tenant ownership checks;
- per-session, per-tree, per-sandbox, and per-tenant quotas;
- fair turn and sandbox scheduling;
- backpressure and overload responses;
- warm sandbox pool and safe LRU eviction;
- token/cost accounting.

Exit criteria: one noisy tenant cannot starve another, stale workers cannot
write after lease loss, and cold sessions consume no live runner resources.

Current status: the private single-host subset is complete. SHA-256-only API
credentials resolve exact tenant-local users and `owner`/`member`/`viewer`
roles; REST, cancellation, SSE wake/replay, events, and checkpoints are scoped
by authenticated tenant. Project/session/unsettled-turn admission and
concurrent-turn limits are transactional. One tenant-neutral worker pool uses a
least-recently-served cursor while preserving per-session mailbox order, and
cancellation bypasses normal fairness as safety work. Dual-tenant integration
and production tests cover known foreign UUID probes, quota isolation, role
denial, restart/scale, and tenant-prefixed S3 restore. An opt-in loopback
registration route now atomically creates a bounded tenant/owner/profile/policy
and returns an indexed token once; real-PostgreSQL acceptance proves concurrent
requests cannot exceed the total-tenant cap. Tenant-scoped recent-conversation
list/detail APIs and Web history switching make that isolation inspectable.
Per-Run request/tool/cost/wall-clock governance, tenant-period token/cost
governance and durable usage now exist under ADR-0033/ADR-0041; operational
metrics exist under ADR-0034. Warm-pool eviction, public identity
federation/recovery, and a
mutually hostile/public SaaS threat model remain open.

## Phase 5: cloud-aware subagents (3 weeks)

Deliverables:

- spawn/send/wait/cancel/list collaboration tools;
- persisted agent tree and child-session lifecycle;
- context inheritance modes;
- depth, fan-out, concurrency, token, and time budgets;
- read-only workspace sharing;
- Git worktree/branch isolation for writers;
- parent result aggregation and cancellation propagation.

Exit criteria: a root agent runs scout, worker, and reviewer agents concurrently;
the writer changes an isolated worktree and the parent receives a reviewed patch.

This is the standout portfolio release.

## Phase 6: observability and failure engineering (2 weeks)

Deliverables:

- OpenTelemetry traces and structured logs;
- Prometheus metrics and Grafana dashboards;
- k6 load tests and Toxiproxy failure tests;
- runner-kill, database interruption, slow consumer, duplicate delivery, model
  disconnect, and ambiguous tool-side-effect scenarios;
- a written recovery-semantics and benchmark report.

Exit criteria: important runtime guarantees are backed by published tests and
measured results rather than architecture claims.

## Phase 7: deployable demonstration (2 weeks)

Deliverables:

- a versioned single-node Kubernetes/gVisor Helm execution plane and a future
  validated multi-node profile;
- NetworkPolicy and storage configuration;
- CI, image scanning, SBOM, and reproducible releases;
- one-command local demo;
- architecture document, threat model, benchmark report, and demo video.

Exit criteria: another developer can deploy the system and reproduce the main
demo and failure tests from the documentation.

Current status: the single-node deployment and evidence subset is complete.
The host installer provisions K3s, containerd, `runsc`/KVM, RuntimeClass, scoped
RBAC and NetworkPolicy; production deployment imports the pinned Tool image and
runs the normal browser flow through Kubernetes Pods. The execution resources
are packaged in a closed Helm chart with fixed runtime/RBAC/network identities,
two proxy replicas and a PDB. CI, SBOM/image scanning, encrypted backup/restore,
architecture/threat-model documentation and reproducible security/production
gates exist. A multi-node cluster, external CSI/CNI operating profile and demo
video remain future work and are not implied by the single-host release.

## Expected calendar time

- First working vertical slice: 2-3 weeks
- Resume-ready release through Phase 3: 7-10 weeks
- Standout release through subagents: 12-16 weeks
- Full roadmap including Kubernetes and evidence: 16-20 weeks

AI assistance can reduce typing and routine implementation time substantially.
It does not eliminate integration debugging, security validation, failure
testing, architecture decisions, or the need to understand the result.
