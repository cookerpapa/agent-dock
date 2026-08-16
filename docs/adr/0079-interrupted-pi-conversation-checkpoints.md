# ADR-0079: PostgreSQL-native interrupted conversation semantics

- Status: Accepted
- Date: 2026-07-28
- Refines: ADR-0011

## Context

The browser persists streamed events before displaying them. Pi independently
persists native user, assistant, Tool-result and Compaction entries through the
PostgreSQL SessionStorage backend. If a started Run is interrupted, the next
model must see a minimal interruption boundary without reconstructing context
from UI deltas.

## Decision

1. Pi conversation state and Workspace state have separate settlement rules.
2. A failed or cancelled started Run appends a hidden, model-visible
   `pi-cloud.run_interrupted` custom entry.
3. If a Worker disappears with an open operation, the next Worker recovers the
   accepted user entry and unresolved Tool results from the durable operation
   ledger before appending the interruption marker.
4. Browser token deltas are never used to manufacture a Pi message.
5. Session entries and operation records are written under the current execution
   authority; a stale Worker cannot continue appending.
6. A failed Run never advances the successful Workspace head.
7. Cold restore opens the current PostgreSQL Session branch and lets Pi build
   Compaction-aware model context.
8. Runtime World State separately emits a minimal `<sandbox_reset>` boundary
   when committed files survive but the prior process environment does not.

## Consequences

- The next model can distinguish an interrupted Turn from an ordinary completed
  Turn and can inspect uncertain Tool effects.
- Workspace bytes, processes and external effects are not falsely claimed to
  have rolled back.
- Conversation recovery does not write or read object-store JSONL snapshots.

## Rejected alternatives

Rebuilding messages from SSE loses Pi's Session tree, Compaction and structured
Tool results. Keeping a second JSONL checkpoint path duplicates SessionStorage
and adds an object-store failure mode that the active runtime does not need.
