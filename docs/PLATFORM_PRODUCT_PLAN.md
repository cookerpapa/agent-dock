# Cloud Agent Platform product plan

## Positioning

AgentDock is intended to become a self-hosted, multi-tenant, recoverable and
sandboxed Cloud Coding Agent platform built around Pi Agent Core. The portfolio
value comes from a complete product loop, durable execution, isolation,
observability, and reproducible evaluation—not from accumulating tool names or
framework integrations.

The target product supports repository import, multi-turn development,
asynchronous scheduling, isolated execution, replayable live events, versioned
workspaces, code-review delivery, usage tracking, and automated evaluation.

## Dependency-ordered milestones

### Milestone 1: trusted Runner and Sandbox Provider

Status: complete for the supported single-node CubeSandbox/KVM private-host
claim under ADR-0053, with demand activation, split checkpoints, and batched
event delivery under ADR-0040.

- trusted Pi Runner and model boundary;
- authenticated Sandbox Manager with no runtime socket;
- provider-neutral handles, policy, lifecycle, inspection, and cleanup;
- primary `CubeSandboxProvider` with full-public/private-denied KVM Tool guests,
  fixed Cube relays, and fail-closed current-commit template attestation;
- retained Kubernetes/gVisor implementation only for importer/regression use;
- credential, namespace, cgroup, filesystem, network, cancellation, and Pi
  integration evidence;
- threat model, network matrix, Provider and Run lifecycle documentation.

The original ordinary-Docker implementation was removed under ADR-0038, and
ADR-0039 then removed direct-Docker lifecycle ownership. The Provider interface
alone is not treated as runtime evidence.

ADR-0040 removes physical provisioning from pure-chat Runs and materializes an
execution environment on the first Tool Call. ADR-0060 adds exact-Session warm
retention through a sealed Cube pause/connect handoff: every old Tool process is
removed, the next Run must present a higher fence and rotated secret, and any
ambiguity falls back to cold checkpoint restore. Pi and Workspace checkpoints
remain separate, and Pi event production is decoupled from PostgreSQL through
a bounded asynchronous batch publisher with cumulative ACK.

### Milestone 2: durable Run protocol

Status: complete.

Build on the existing command/outbox/lease/fence implementation and make the
product vocabulary explicit:

- public `Run` and durable `RunAttempt` resources;
- attempt history and operator-readable failure classification;
- lease/heartbeat/fence observability;
- atomic terminal settlement and checkpoint revision CAS evidence;
- fault injection for duplicate delivery, old-worker completion, database/object
  store interruption, and cancel/complete races.

Implemented as ADR-0031. Public tenant-scoped Run APIs expose bounded Attempt
history; the supervisor wire and Provider assignment carry independent Run and
Attempt UUIDs; lease acquisition/heartbeat, trusted Runner phases, checkpoint
revision, cancellation, reconciliation, terminal settlement, and stale-claim
tests all use the same current-attempt fence.

At-least-once scheduling plus fenced/idempotent commits remains the claim. The
system must not claim exactly-once arbitrary shell execution.

### Milestone 3: versioned Workspace and GitHub-native delivery

Status: complete for the optional GitHub App integration and Cube primary
production topology under ADR-0032/ADR-0053.

- checkpoint history, compare, fork, rollback, archive, and patch download;
- structured files/diff/test/artifact surfaces;
- GitHub App installation and repository allowlist;
- private repository read through a trusted GitHub Gateway;
- trusted branch/commit/PR write-back without putting GitHub tokens in a Tool
  Sandbox;
- webhook and Check Run/status integration.

Implemented with immutable staged/settled/abandoned Workspace versions,
CAS/idempotent fork/rollback/archive, trusted artifact transport, structured
file/diff/test/artifact APIs, a separate credential-owning GitHub Gateway,
installation/repository allowlists, exact private snapshots, reconciled
branch/commit/PR/Check delivery, and HMAC-verified webhook ingestion. The
default deployment is fail-closed until an operator supplies a real GitHub App;
automated GitHub API contract tests are not described as a live installation.

### Milestone 4: context and model governance

Status: complete under ADR-0033.

- explicit context budget and layered context construction;
- measured Pi compaction records and summary versions;
- large tool output moved to artifacts with bounded summaries;
- per-run model-request/tool/cost/wall-clock limits and tenant-period token limits;
- fallback/routing policy and complete usage ledger.

The trusted extension now supplies the execution-context and bounded
repository-instruction layers while Pi retains transcript and native compaction
authority. Compaction metadata, model reservations, immutable actual-rate/cost
attribution, one-policy fallback, per-Run request/cost plus tenant day/month
budgets, wall-clock/tool limits and full large-output Artifacts are tenant-scoped
and exercised through the product API. ADR-0041 removes the cumulative per-Run
token cap because repeated Agent Loop calls re-report cached context. Seeded
rates are deliberately zero until an owner configures them; no external provider
price is inferred.

### Milestone 5: observability and evaluation

Status: complete under ADR-0034 for the private single-host topology.

- OpenTelemetry trace propagation across Control Plane, Runner, Gateway,
  Manager, and Provider;
- metrics and dashboards for queue, run, sandbox, model, tool, checkpoint,
  cancellation, resource, and usage behavior;
- fixed coding-agent task set with test/patch/cost/latency results;
- infrastructure fake-model suite, security evaluation, fault injection, and
  measured 10/50/100-session load reports.

Implemented with durable Run trace identities, W3C propagation across every
trusted HTTP/process boundary, bearer-protected low-cardinality Prometheus
metrics, redacted JSON logs, a tenant-scoped owner operations API, persisted
Jaeger, and a provisioned Grafana dashboard. Reproducible reports cover ten
full-loop coding repairs, ten fault invariants, the gVisor importer/regression
gate, the Cube KVM Tool gate, and 10/50/100 simultaneous Session/API load.
Reports explicitly separate
infrastructure correctness from model intelligence and active-Run capacity.

Only reproduced measurements belong in the résumé.

### Milestone 6: stronger Sandbox boundary

Status: complete for the single-node KVM claim under ADR-0053; ADR-0038 and
ADR-0039 remain evidence for the retained gVisor importer boundary.

- `CubeSandboxProvider` is the sole ordinary production Tool implementation;
- CubeAPI/CubeMaster/Cubelet/CubeShim create an independent KVM guest per
  materialized RunAttempt;
- a digest-pinned READY template binds the exact AgentDock Git revision and
  closed Tool policy;
- the Manager has no Docker/containerd socket and reaches Cube only through
  credential-free fixed-target relays;
- Tool guests have public egress with explicit private/link-local/metadata
  denial, no platform credential or host mount, and bounded
  CPU/memory/process/disk/time/output;
- real KVM evidence covers guest/host kernel distinction, two-tenant Workspace
  isolation, cancellation and zero-orphan cleanup;
- gVisor remains the fixed-purpose exact-commit importer and deterministic
  regression backend, never an ordinary Tool fallback;
- direct-Docker, Docker Desktop/LinuxKit and legacy whole-Pi container
  execution were deleted.

Full public-SaaS, dedicated multi-node Cube, node-loss/upgrade and arbitrary
dependency-egress claims remain excluded.

### Milestone 7: product completion and public demonstration

Status: complete under ADR-0036 for the requested private/loopback product
boundary. Public Internet exposure remains deliberately excluded.

- file browser, structured diff, artifacts, tests, preview, fork/retry, and
  audit/admin pages;
- backup/restore drill, migrations, release images, SBOM and image scanning;
- documented one-command private deployment;
- separately threat-modelled public demo with identity, abuse controls, budget,
  and stronger sandbox isolation.

The authenticated Session inspector now exposes Workspace versions and safe
file/Artifact text previews, structured comparisons, Run/Attempt history,
tests, usage/context, fork/rollback/archive, retry-as-new-Run, owner operational
activity, GitHub App repository selection, and explicit PR delivery. Preview
does not execute repository content. The owner-only activity feed is derived
from immutable execution rows and is explicitly not represented as a complete
human-actor audit.

ADR-0037 completes the normal browser entry: optional public registration now
creates a password account and persistent HttpOnly session, the default shell
is conversation-list plus chat, the first message starts from an empty
Workspace, and model selection/credentials are platform-managed rather than
presented to the user. Existing bearer APIs remain an operator surface.

The cold recovery command authenticates and encrypts the runtime plus all seven
durable volumes, binds a manifest to exact image IDs/revision/hashes, and
restores only into a new empty project. Production acceptance now executes that
backup/restore round trip and proves a post-restore turn. Revision-labelled
images, root/image CycloneDX SBOMs, full HIGH/CRITICAL reports, a zero-fixable-
HIGH/CRITICAL release gate, and immutable-pinned CI Actions close the release
evidence loop.

The plan originally named a separately threat-modelled public demo. The owner
subsequently constrained deployment to private/loopback use, so bounded
self-registration is used only to demonstrate multi-tenant isolation. OIDC,
account recovery, abuse prevention, billing, public ingress, arbitrary
dependency egress, and a hostile anonymous SaaS review were not silently added
or claimed.

## Deliberate exclusions until justified

Do not add Temporal, Kafka, Flink, Redis, MCP, subagents, arbitrary extensions,
or dozens of tools merely to make the architecture look larger. Do not broaden
the validated, versioned single-node Helm/Kubernetes execution plane into an
untested multi-node claim. Each addition needs a measured requirement and an
end-to-end acceptance test.

Subagents can become a later product capability after the single-agent Run,
Workspace, security, observability, and evaluation foundations are complete.

## Final evidence standard

A capability is complete only when:

1. a user can exercise it through the actual product flow;
2. state, failure, cancellation, retry, and cleanup semantics are explicit;
3. tenant and credential boundaries are tested;
4. relevant metrics and logs identify the Run/Attempt without exposing content
   or secrets;
5. a clean checkout can reproduce the acceptance command;
6. documentation distinguishes implemented, planned, and unsupported behavior.
