# ADR-0102: Executable durable Harness from Pi public primitives

## Status

Superseded by ADR-0103 on 2026-08-14.

## Context

Pi 0.84.1 publishes `AgentHarness` types plus public Agent, SessionStorage,
compaction, branch-summary and model primitives. The packaged `AgentHarness`
class still reserves its execution methods with `HarnessNotImplemented`, so it
cannot yet replace AgentDock's coding-agent adapter by itself.

Waiting for that class would retain whole-file JSONL restoration. Patching Pi
or copying private internals would create an unsupported fork. A cloud adapter
also has one requirement that a local storage writer claim cannot satisfy:
the same Run authority must be checked at both the conversation-write boundary
and the remote Cube Tool-effect boundary.

## Decision

1. Implement `DurableAgentHarness` inside `@agent-dock/pi-session-postgres`
   using only Pi's exported APIs. Do not patch `node_modules` or maintain a Pi
   fork.
2. Implement the complete Pi 0.84.1 public surface: Runs, skills/templates,
   queues, abort/resume, deferred responses, manual drive, configuration,
   multiple lanes, watches, compaction, navigation, Hooks, events and close.
3. Use Pi-native entries, operation records, usage records and compaction
   projection as conversation authority. The browser transcript is not model
   context.
4. Acquire one opaque operation authority and check it at durable Session
   mutation and immediately before/after remote Tool effects. Lease and fence
   representations remain outside model context and Tool arguments.
5. Persist Tool intent only after Hook argument transformation and validation.
   Replay only Tools explicitly marked `safe`; settle interrupted unsafe Tools
   with a synthetic error result that reports unknown side effects.
6. Compose transforming Hooks in registration order. `before_run` and
   `before_resume` require stable registration IDs so extension recovery data
   is scoped correctly after a Worker change.
7. Keep this adapter staged until terminal Workspace settlement and the
   production event stream have parity, followed by real model/Cube and
   cross-Worker acceptance. API completeness alone does not authorize cutover.

## Consequences

- active context restoration becomes one bounded PostgreSQL branch query
  instead of downloading and parsing a complete historical JSONL object;
- compaction, Tool uncertainty and deferred provider work have explicit durable
  restart semantics;
- remote Tool authority is centralized at the Harness boundary without leaking
  a lease ID or fencing token into Pi messages;
- AgentDock owns a modest adapter layer until upstream ships an executable
  implementation with equivalent cloud-effect boundaries;
- the production JSONL path remains temporarily, but it has a concrete parity
  and deletion gate rather than an open-ended compatibility promise.

## Rejected alternatives

- patching Pi's packaged `AgentHarness` would couple deployment to private
  implementation details;
- treating `SessionStorage` writer ownership as Cube Tool authority would leave
  already-routed external effects unfenced;
- switching production immediately would weaken the existing atomic
  conversation/Workspace completion and interruption/world-state behavior;
- re-running every interrupted Tool would duplicate arbitrary shell and file
  side effects.
