# ADR-0081: Per-sampling Cloud Step and model-visible world-state deltas

- Status: Accepted
- Date: 2026-08-07
- Refines: ADR-0079 and ADR-0080
- Refined by: ADR-0082

## Context

ADR-0080 freezes one accepted execution view for an entire RunAttempt. ADR-0082
later separates its stable logical Turn fields from rotating lease, fence and
Worker ownership. Both lifetimes are wider than one model sampling step. Pi can
make several provider requests in one Run: an assistant response may request
Tools, their results are appended, and Pi then samples again.

The trusted Pi Worker and the Cube Tool executor are separate failure domains.
A later sampling request may therefore run after a Worker handoff, a cold Cube
restore or another material execution-world change. The model must be told the
semantic fact that matters, while Tool calls must remain bound to the exact
sampling step that advertised them. Internal activation, lease, attempt and
fencing identities must not become model-visible prompt material.

Pi exposes a public `context` extension event immediately before every LLM
call. This provides the required safe point without modifying Pi's Agent Loop.

## Decision

1. Keep the parent execution contract immutable and credential-free. ADR-0082
   subsequently separates it into a stable logical `CloudTurnContext` and a
   rotating physical `CloudAttemptContext`; both digests bind Sandbox
   reservation and every Tool call.
2. Capture a new immutable `CloudStepContext` from Pi's public `context` hook
   before every provider request. It contains a monotonic step sequence, the
   parent Turn and Attempt digests, the exact active remote Tool registry and a
   typed runtime world-state snapshot.
3. All Tool calls emitted by one assistant response use the most recently
   captured step sequence and digest. Tool execution is rejected before RPC if
   no Step has been captured. The Sandbox Manager accepts monotonically
   advancing Step bindings and rejects a stale or conflicting binding.
4. Persist only changed typed world-state baselines in Pi's native Session
   JSONL. The internal baseline may contain continuity identities and hashes;
   those fields never enter model context.
5. Render only material semantic deltas as hidden Pi custom messages:
   - loss or replacement of an active Sandbox renders `<sandbox_reset>`;
   - a changed execution image/profile renders `<environment_changed>`;
   - a changed Tool registry or network policy renders
     `<tool_policy_changed>`.
   Workspace revisions and ordinary inactive-to-active transitions remain
   internal because normal Tool results already explain Agent-authored file
   changes.
6. A warm Cube reused by a different Pi Worker is continuous execution state
   and does not produce a model message. A cold Cube restore is a reset even if
   committed Workspace files are restored successfully.
7. If the Manager reports `cubesandbox_tool_result_unknown`, the current world
   becomes unavailable before Pi's next provider request; that request receives
   the same minimal reset fact rather than a claim that the old process world
   survived.
8. Pi Compaction and cross-Worker restore continue to use Pi-native JSONL. No
   `messages[]` reconstruction from browser events is introduced.

## Consequences

- The model sees execution-world changes at the same boundary at which Pi
  selects the context and Tools for its next provider request.
- Tool requests cannot silently use a Step older than the latest Step admitted
  by the Sandbox Manager.
- Worker migration alone is invisible when the Cube and Tool world are
  unchanged; only facts that can affect model reasoning consume context.
- The logical Turn contract remains stable, so dynamic administration cannot
  mutate policy mid-Run; Attempt ownership can still rotate safely.
- Session JSONL grows only when semantic world state changes, not once per
  token or once per model request.

## Rejected alternatives

### Put every orchestration field in the prompt

Worker IDs, activation IDs, fencing tokens and policy hashes are trusted-plane
implementation details. They add prompt noise and can encourage the model to
reason about authorities it cannot control.

### Capture only once per Run

That cannot prove that a later Pi provider request and its Tool calls use the
same post-Tool execution view.

### Patch Pi's Agent Loop

Pi's public `context` event already runs before each provider request. Keeping
the implementation in an inline extension preserves upstream compatibility.

### Persist every Step snapshot in Session JSONL

Most consecutive Steps are semantically identical. Persisting every snapshot
would add storage and compaction pressure without improving recovery.
