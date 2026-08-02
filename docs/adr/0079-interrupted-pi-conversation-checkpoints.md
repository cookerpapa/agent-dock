# ADR-0079: Interrupted Pi conversation checkpoints

- Status: Accepted
- Date: 2026-07-28
- Refines: ADR-0011

## Context

ADR-0011 deliberately advanced Pi and Workspace recovery only after a
successful settled Turn. That kept an uncommitted Workspace from becoming
authoritative, but it also treated conversation state and Workspace state as
one atomic unit.

The browser persists streamed events before displaying them. Pi independently
persists the native user, assistant, Tool-result and compaction entries in its
Session JSONL. If a started Run is cancelled or fails after producing output,
discarding that native branch makes the next model see only the previous
successful Turn plus the next user prompt. The user can still see the
interrupted Turn in the browser, so browser history and model-visible history
diverge.

Reconstructing Pi context from browser token deltas is not safe. Deltas are a
delivery projection, may end mid-block, and do not preserve Pi's Session tree,
compaction entries, provider metadata or Tool-result structure.

## Decision

1. Pi conversation state and Workspace state have separate commit rules.
   Workspace versions still advance only after a successful settled Run.
2. A started Run that fails or is cancelled commits an
   `pi_interrupted_session_snapshot` artifact when a valid native Pi Session
   file can be materialized.
3. Before committing that artifact, the trusted Pi Worker appends a hidden,
   model-visible `agent-dock.run_interrupted` custom message. The marker states
   that the previous Run did not commit successfully, that commands may have
   partially executed or remain active in the background, and that a later
   prompt which depends on the interrupted work must first inspect current
   Workspace/process state. It also forbids blindly replaying a side effect
   whose completion is uncertain.
4. If Pi failed before it appended the accepted user prompt, the Worker appends
   that prompt to the native Session tree before the interruption marker. It
   never reconstructs an assistant message from streamed text deltas.
5. The interrupted snapshot is written under the current Session lease and
   fencing token. Cancellation is allowed to write it while the durable
   Session/Turn are in their cancelling states.
6. A terminal failed or cancelled Run promotes only its explicitly typed
   interrupted Pi artifact. A staged successful Pi artifact from a failed
   Workspace checkpoint is not promoted.
7. A dispatch failure that occurs before execution starts does not produce an
   interrupted checkpoint. Such an Attempt may be retried without changing the
   canonical conversation head.
8. Cold restore accepts completed Pi snapshots and interrupted Pi snapshots.
   Pi's own SessionManager remains responsible for building compaction-aware
   model context.

## Consequences

- The next model sees the accepted prompt, any native partial/error assistant
  message and an explicit interruption boundary after a failed or cancelled
  started Run.
- Browser transcript and model-visible conversation no longer silently diverge
  at interruption boundaries.
- Workspace bytes, processes and external side effects are not claimed to have
  rolled back. The marker makes that uncertainty model-visible and requires the
  next Agent to inspect reality before continuing dependent work.
- Interrupted snapshots add object-storage writes to terminal failure and
  cancellation handling.
- ADR-0011 remains unchanged for successful Workspace commit ordering and cold
  process recovery; only its "failed and cancelled turns do not advance the
  last settled checkpoint" rule is refined for Pi conversation state.

## Rejected alternatives

### Rebuild messages from durable SSE events

Event rows are a UI/audit projection rather than Pi's native conversation
format. Rebuilding from them loses compaction and can turn incomplete deltas
into a false final answer.

### Discard every interrupted Turn

This is simple but leaves the model unaware of a Turn that the user can see and
may have caused Tool side effects.

### Promote the ordinary Pi artifact from any failed Run

A failure after Workspace checkpoint staging could retain an assistant claim
while rolling back the corresponding Workspace version. A distinct artifact
kind makes the intended interruption commit explicit.
