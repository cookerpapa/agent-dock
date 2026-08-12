# Implementation roadmap

This file describes the current dependency order. Completed historical work is
preserved in [BACKLOG.md](BACKLOG.md), ADRs and the implementation log.

## Completed foundation

- Pi SDK Agent Loop with native Session/compaction restore;
- PostgreSQL durable Run/Attempt state and canonical conversation Turns;
- resumable SSE;
- multi-tenant authentication and quotas;
- Temporal as the sole Run scheduler;
- horizontally scalable, capacity-aware Pi Worker pool;
- CubeSandbox KVM as the sole Tool runtime;
- leased/fenced Tool RPC;
- public-only proxy egress with hot administrator configuration;
- Cube Volume/POSIX/Kopia Workspace persistence;
- immutable Pi and Workspace checkpoints;
- live fault, load and token-consuming acceptance;
- conversation/product UI and dedicated administrator settings.

## Current product milestone

- [x] Remove executable alternate Sandbox runtimes and deployment compatibility.
- [x] Make Workspace a named, first-class user directory.
- [x] Select or create a Workspace when starting a conversation.
- [x] Store conversation titles independently from Workspace names.
- [x] Add conversation deletion without deleting the shared Workspace.
- [x] Replace the operational inspector with a committed directory/file view.
- [x] Separate platform administrator identity from tenant ownership.
- [x] Remove the browser repository-import workflow.
- [x] Preserve Pi-native failed/cancelled conversation branches without
  promoting unsuccessful Workspace state.
- [x] Make catchable interruption, hard Worker loss and confirmed Cube reset
  model-visible with minimal factual boundaries that survive cold restore.
- [x] Commit public terminal events atomically with Run/checkpoint state and
  recover hard-crash durable semantics without inventing a second transcript.
- [x] Keep Temporal Activity deadlines above bounded Pi/Sandbox settlement and
  cleanup time.
- [x] Move trusted Volume generation metadata outside the guest-visible
  `/workspace` while preserving one Kopia checkpoint envelope.
- [x] Move AgentDock's synthetic Git baseline and Patch calculation into the
  trusted Volume envelope so `/workspace` contains only user data.
- [x] Preserve one useful Bash preview plus a recoverable full-output Artifact.
- [x] Extract shared execution primitives into `@agent-dock/runtime-core`.
- [x] Narrow the Supervisor WebSocket to the Worker Control Channel; Temporal
  Activities now own Run execution and cancellation.
- [x] Add bounded large-file ranged reads and optimistic-digest, atomic-replace
  edits.
- [x] Keep research APIs behind an explicit optional module and remove the
  unfinished product routes/client workflows.
- [x] Freeze a credential-free logical Turn contract, rotate a separate
  Worker/lease/fence Attempt contract and bind Sandbox reservation,
  environment, Workspace revision and Tool policy to both digests.
- [x] Recapture a per-sampling Cloud Step through Pi's public `context` hook,
  bind remote Tools to its monotonic sequence/digest and persist only material
  model-visible WorldState deltas.
- [x] Correlate every model request and Tool boundary with its Cloud Step, while
  representing transient provider retries as separately budgeted attempts
  beneath the same Step.
- [x] Adopt Pi's bounded agent-level retry for transient model failures while
  disabling invisible provider retries and preserving no-replay Tool semantics.
- [x] Add a default-off project settlement gate with one bounded Pi follow-up
  and no trusted-side execution of repository code.
- [x] Reattach short Tool transport disconnects to one execution identity,
  preserve ordered stdout/stderr and expose irrecoverable ambiguity as
  `UNKNOWN` without replay.
- [x] Require the Worker event spool to cross an acknowledged durable barrier
  before the Control Plane may commit terminal state.
- [x] Persist typed runtime world state while keeping only material Sandbox
  resets model-visible.
- [x] Add a distributed Kubernetes application profile with multi-replica Web
  and Control Plane, version-aware Temporal/KEDA Pi Worker scaling, direct
  headless-DNS Worker management and a shared Sandbox Domain.
- [x] Replace global Workspace hashing with an immutable execution Cell
      directory and Cell-specific Temporal routing; raise the default Pi Worker Pod
      to four bounded runtime slots.
- [x] Split long-lived resumable SSE delivery into an independently scalable
      Event Gateway.
- [x] Cross the measured PostgreSQL event-capacity gate and add the enterprise
      Kafka-first -> Valkey live projection path, including an authenticated
      Worker ingest gateway, terminal canonical projection barrier and Strimzi
      deployment baseline without a PostgreSQL raw-payload copy.
- [x] Add a Session-level automatic/persistent Cube retention choice with lazy
      activation, dedicated-Workspace ownership and archive-driven cleanup.
- [x] Move large Pi Sessions to compressed bounded object segments; keep live
      deltas in Kafka/Valkey and only terminal canonical Turns in PostgreSQL.
- [x] Separate execution Cells from Sandbox Domains, narrow the Manager into a
      Tool Broker and scale Workspace Data Movers independently.
- [x] Bound persistent Cube occupancy per tenant and add explicit Data Mover
      concurrency, queue, timeout and pressure metrics.
- [ ] Complete full CI, production migration and live browser/API acceptance.

## Next reliability milestone

- tenant/session hard deletion and object garbage collection policy;
- multi-node failure injection for Worker/node loss;
- validate multi-replica Tool Broker owner-loss and Data Mover failover on a
  real multi-node Domain;
- design an activation/Attempt-scoped expiring Cube data-plane grant before
  considering direct Worker-to-CubeProxy Tool payloads;
- multi-node deployment acceptance for HPA/KEDA and external authorities;
- object/checkpoint orphan garbage collection dashboards;
- measured Cell queue delay and Pi Worker slot-density tuning;
- sustained load evidence at the target Worker/Cube capacity.

## Release quality

Every new claim requires:

1. source-level tests;
2. a deterministic failure test;
3. real deployment evidence where the boundary is infrastructural;
4. documentation and threat-model update;
5. measured values rather than guessed performance numbers.

Features are not added by retaining a dormant implementation. A new execution
backend must re-enter through an ADR, the Provider contract and the complete
shared acceptance suite.
