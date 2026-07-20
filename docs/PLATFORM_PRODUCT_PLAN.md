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

Status: complete for the supported Docker/private-host claim.

- trusted Pi Runner and model boundary;
- socket-owning Sandbox Manager;
- provider-neutral handles, policy, lifecycle, inspection, and cleanup;
- Docker Provider with offline Tool Sandbox;
- credential, namespace, cgroup, filesystem, network, cancellation, and Pi
  integration evidence;
- threat model, network matrix, Provider and Run lifecycle documentation.

gVisor and managed microVMs are intentionally deferred to Milestone 6; defining
an interface does not make them supported.

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

Status: complete for the optional GitHub App integration and Docker production topology under ADR-0032.

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
- per-run model/tool/token/cost/wall-clock limits;
- fallback/routing policy and complete usage ledger.

The trusted extension now supplies the execution-context and bounded
repository-instruction layers while Pi retains transcript and native compaction
authority. Compaction metadata, model reservations, immutable actual-rate/cost
attribution, one-policy fallback, per-Run/day/month budgets, wall-clock/tool
limits and full large-output Artifacts are tenant-scoped and exercised through
the product API. Seeded rates are deliberately zero until an owner configures
them; no external provider price is inferred.

### Milestone 5: observability and evaluation

- OpenTelemetry trace propagation across Control Plane, Runner, Gateway,
  Manager, and Provider;
- metrics and dashboards for queue, run, sandbox, model, tool, checkpoint,
  cancellation, resource, and usage behavior;
- fixed coding-agent task set with test/patch/cost/latency results;
- infrastructure fake-model suite, security evaluation, fault injection, and
  measured 10/50/100-session load reports.

Only reproduced measurements belong in the résumé.

### Milestone 6: second Sandbox Provider

Implement and test one stronger isolation path:

- `DockerGVisorSandboxProvider` for self-hosting; or
- a managed Firecracker/microVM Provider.

The Provider must pass the same security, lifecycle, checkpoint, real Pi, and
production acceptance suite. Provider-specific limitations and cost/startup
measurements must be published.

### Milestone 7: product completion and public demonstration

- file browser, structured diff, artifacts, tests, preview, fork/retry, and
  audit/admin pages;
- backup/restore drill, migrations, release images, SBOM and image scanning;
- documented one-command private deployment;
- separately threat-modelled public demo with identity, abuse controls, budget,
  and stronger sandbox isolation.

## Deliberate exclusions until justified

Do not add Temporal, Kafka, Flink, Redis, Kubernetes, MCP, subagents, arbitrary
extensions, or dozens of tools merely to make the architecture look larger.
Each addition needs a measured requirement and an end-to-end acceptance test.

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
