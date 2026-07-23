# ADR-0049: Transactional semantic conversation projections

- Status: Accepted
- Date: 2026-07-23
- Extends: ADR-0008, ADR-0026, ADR-0040, ADR-0047

## Context

The durable `session_events` log is intentionally complete: it preserves
sequenced text deltas, Tool lifecycle, approvals, notifications and terminal
events for audit and resumable SSE. Before this decision, opening a completed
conversation returned only prompt metadata and made the browser replay that
complete event history from sequence zero to reconstruct the transcript.

That behavior was correct but scaled with every historical delta. Event
coalescing reduced writes during a live Run, but it did not remove the cost of
re-reading old deltas on every later conversation open.

The reviewed `maidangzhu/cloud-agent-platform` repository separates a durable
semantic message layer from its high-frequency streaming path. AgentDock should
adopt that useful read-model boundary without adopting its weaker runtime,
credential, event-durability or execution assumptions.

## Decision

AgentDock maintains a versioned `conversation_turn_projections` read model for
terminal Turns.

When a valid, current-fence `turn.completed`, `turn.failed` or
`turn.cancelled` event is inserted, the same PostgreSQL transaction reduces all
durable public events for that Turn into one semantic transcript:

```text
adjacent assistant text deltas -> one text block
Tool input/start/completion    -> one Tool item
approval request/resolution    -> one approval item
notification                   -> one notification item
terminal event                 -> terminal status/failure/cancellation/patch
```

The projection records its schema version, source event count and exact
per-session sequence watermark. The event insert, projection replacement,
durable cursor advance and cumulative ACK eligibility commit atomically.

`GET /v1/conversations/:sessionId` returns projections for completed Turns.
When every included Turn is projected, the browser starts SSE at the current
durable high-water mark and does not replay historical deltas. If a Turn is
still active, the API starts replay immediately before the earliest
unprojected event for that Turn, preserving exact live sequence validation.

Existing pre-migration conversations are repaired lazily. The first detail
read of a terminal Turn without a projection deterministically rebuilds it from
the tenant-scoped durable event log and persists the result. Deleting a
projection is therefore recoverable and does not delete conversation history.

## Authority and correctness

- `session_events` remains the immutable audit/replay authority.
- Pi JSONL/checkpoint state remains the model-conversation authority.
- The semantic projection is a rebuildable Web/API read model only.
- The ordinary SSE endpoint and `Last-Event-ID` contract are unchanged.
- Projection creation occurs only after event ownership, current lease and
  fencing checks pass.
- Projection rows are bound by the existing composite
  tenant/session/turn foreign key.
- Attempt rewind does not overwrite history: superseded and canonical Turns
  retain separate projections and their existing projection labels.
- An active Turn never uses a stale terminal projection. It continues from the
  durable event suffix until it reaches a new terminal boundary.

## Consequences

Completed conversations now load in work proportional to semantic Turn items,
not historical token-delta count. The Web keeps the same Pi-inspired text,
Tool, approval and terminal presentation, while live Runs retain strict
contiguous SSE handling.

Terminal event ingestion performs one bounded Turn-event reduction before ACK.
This moves work from every conversation open to the single terminal commit.
Projection corruption or loss can be repaired from the durable log; no
projection is allowed to become a second source of conversation truth.
