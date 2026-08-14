# ADR-0103: Thin PostgreSQL-native Pi cloud runtime

## Status

Accepted and released on 2026-08-14. Supersedes ADR-0102's decision to
implement the full Pi `AgentHarness` surface. Real model/Cube, native
Compaction and cross-Worker acceptance completed before the production JSONL
path was retired.

## Context

Pi 0.84.1 exposes useful public primitives: `Agent`, `Session`,
`SessionStorage`, context projection and compaction. Its packaged
`AgentHarness` still reserves the execution methods, so ADR-0102 implemented
the complete public Harness contract inside AgentDock.

That implementation proved that Pi-native entries can live in PostgreSQL, but
it also reproduced lanes, navigation, templates, skills, manual drive,
deferred responses and generic Hook machinery that AgentDock does not expose.
More importantly, production still restored a complete `session.jsonl` object
for every cold Run. API completeness therefore added code without shortening
the real cloud execution path.

AgentDock needs a smaller contract:

- restore the active context from the newest compaction and its suffix;
- execute Pi's native Agent Loop with remote Cube Tools;
- append complete user, assistant and Tool-result messages incrementally;
- preserve automatic compaction, steering, interruption facts, world-state
  changes and terminal Workspace settlement;
- enforce one opaque Run authority at PostgreSQL writes and external Tool
  effect boundaries.

## Decision

1. Replace the staged full `DurableAgentHarness` with a product-owned thin
   `CloudAgentRuntime` composed only from Pi public APIs.
2. Make PostgreSQL `SessionStorage` the production model-context authority.
   A Worker reads the active branch with one bounded recursive query and does
   not download or rewrite the complete historical JSONL transcript.
3. Persist the accepted user message before model execution. Persist complete
   assistant, steering and Tool-result messages from Pi `message_end` events.
   Token deltas remain live-event data and are not reconstructed into model
   context.
4. Keep a minimal durable operation ledger only for crash ambiguity. A Tool
   intent is recorded before the remote effect; an unresolved Tool is never
   replayed blindly and is settled as having unknown side effects on recovery.
5. Bind Tools and Session mutations to one opaque `ExecutionAuthority`.
   Lease IDs and fencing-token representations remain outside prompts and Tool
   arguments. Product Run terminal commit keeps its existing fenced/CAS check.
6. Perform automatic compaction from Pi's public compaction primitives and
   append the resulting native compaction entry to the same Session.
7. Keep AgentDock's cloud-specific world state, interruption markers,
   settlement gate, event mapping and model-request governance as small
   adapters around the native Agent Loop; do not recreate generic Harness
   Hooks or unused product surfaces.
8. Retire the production JSONL conversation checkpoint only after parity tests
   prove multi-turn, compaction, steer, interruption, cross-Worker restoration
   and real Cube Tool execution. This gate passed on 2026-08-14; Workspace
   checkpoints remain independent.

## Consequences

- cold Run context restoration is proportional to the active context after the
  latest compaction, not to the lifetime conversation history;
- each complete model-visible message is stored once as a native Pi entry;
- Worker replacement does not require session affinity or a resident Pi
  process;
- authority remains explicit at shared effects without leaking cloud
  orchestration concepts into the model;
- the maintained runtime surface becomes much smaller than Pi's generic
  Harness contract;
- SessionStorage and Workspace settlement are separate durable resources, so a
  failed Run may leave durable partial conversation plus an interruption fact
  while the Workspace head remains at its last committed revision.

## Rejected alternatives

- retaining the full in-repo Harness would preserve unused behavior and leave
  production on JSONL snapshots;
- patching or forking Pi's unimplemented Harness would bind AgentDock to private
  upstream details;
- storing only final browser messages would lose Tool context, compaction and
  model-visible recovery facts;
- treating arbitrary Tool execution as exactly-once would invite duplicate
  shell and file side effects after ambiguous failures;
- moving lease/fence fields into messages or Tool arguments would expose cloud
  control metadata to the model without strengthening the real effect boundary.
