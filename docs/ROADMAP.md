# Implementation roadmap

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

Current status: complete. `npm run sandbox:check` proves the backend path, and
`npm run demo` exposes the same zero-token Java repair through the minimal React
session page. The page can submit, stream, reconnect without duplicate events,
cancel, and inspect the final diff. The one-turn limitation was removed by the
first Phase 2 settled-checkpoint slice described below.

## Phase 2: durable sessions and mailbox (2 weeks)

Deliverables:

- PostgreSQL command queue and transactional outbox;
- session and turn state machines;
- idempotency keys;
- prompt, steer, and follow-up semantics;
- durable supervisor-side event replay and cross-replica live notification;
- Pi JSONL and artifact upload to MinIO;
- leases, fencing tokens, cold load, and settled-turn recovery.

Exit criteria: duplicate requests do not duplicate turns; five inputs to the
same session remain ordered; browser and runner reconnects do not lose events.

Current status: in progress. Durable intake, idempotency, session/turn state,
leases/fencing, PostgreSQL event replay, and sequential follow-up acceptance
already exist. The first Phase 2 slice adds settled Pi JSONL plus bounded
workspace checkpoint upload/validation, PostgreSQL artifact pointers, cold
restore into a fresh Docker container, and a Web follow-up on the same session.
Two-container tests prove that the second model request sees the prior Pi
conversation and that its tool sees the prior Java edit. A crash-safe local
supervisor spool now persists event publications before transport and proves
exact PostgreSQL redelivery after an ACK-loss restart. Prompt acceptance now
allocates a durable per-session mailbox position, including while another turn
is running. A five-input test concurrently accepts four followers and forces
tied timestamps, proving strict FIFO, no overlap, and idempotent replay without
a counter gap; the Web page exposes queue positions and labels active-session
submission as queued follow-up. Steer is
specified as a separate future operation rather than an implicit prompt mode.
Long-turn leases now renew through one shared supervisor heartbeat, while a
host-side identity-fenced reconciler removes orphan/expired Docker assignments,
fails acknowledged ambiguous work, safely requeues pre-ACK work, repairs
capacity, and retires an old sandbox only after runtime absence is confirmed.
MinIO/S3, explicit steer implementation, cross-replica notification, and
production remote-supervisor registration/health orchestration remain.

## Phase 3: sandbox and approval boundary (2-3 weeks)

Deliverables:

- trusted Docker sandbox manager outside the agent container;
- non-root image, resource limits, process-tree cancellation, and egress policy;
- Pi tool-policy extension and asynchronous approval flow;
- workspace snapshot and restoration;
- secret redaction and security-focused integration tests.

Exit criteria: cross-tenant filesystem access, host credential access, runaway
processes, and unapproved dangerous actions are blocked in repeatable tests.

This is the first resume-ready release.

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

- Helm chart and Kubernetes runner lifecycle;
- NetworkPolicy and storage configuration;
- CI, image scanning, SBOM, and reproducible releases;
- one-command local demo;
- architecture document, threat model, benchmark report, and demo video.

Exit criteria: another developer can deploy the system and reproduce the main
demo and failure tests from the documentation.

## Expected calendar time

- First working vertical slice: 2-3 weeks
- Resume-ready release through Phase 3: 7-10 weeks
- Standout release through subagents: 12-16 weeks
- Full roadmap including Kubernetes and evidence: 16-20 weeks

AI assistance can reduce typing and routine implementation time substantially.
It does not eliminate integration debugging, security validation, failure
testing, architecture decisions, or the need to understand the result.
