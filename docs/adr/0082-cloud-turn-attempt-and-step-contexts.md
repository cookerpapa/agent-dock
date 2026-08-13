# ADR-0082: Separate Cloud Turn, Attempt and Step contexts

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0031, ADR-0080 and ADR-0081
- Refined by: ADR-0083

## Context

ADR-0080 introduced one immutable credential-free execution snapshot for a
RunAttempt. ADR-0081 then added a fresh sampling Step before every Pi provider
request. The RunAttempt snapshot currently mixes two kinds of state:

- logical Turn state that must remain stable when a replacement Worker claims
  another Attempt for the same accepted Run, such as model, environment,
  Workspace base revision, Tool policy and budgets;
- physical ownership state that must change when another Worker takes over,
  such as Attempt, command, Worker boot, lease and fencing identities.

Using one digest for both is safe, but it cannot independently prove that a
replacement Attempt preserved the accepted Turn contract while rotating its
execution authority. It also makes the relationship between a Pi sampling
Step and the two parent lifetimes implicit.

## Decision

1. Capture one immutable `CloudTurnContext` for the logical accepted Run. It is
   credential-free and contains tenant/Project/Workspace/Session/Run/Turn/Agent
   identity plus the frozen model, environment, Workspace base revision, Tool
   and network policy and budgets. Its digest remains stable when only the
   Attempt, command, Worker, lease or fencing identity changes.
2. Capture one immutable `CloudAttemptContext` for each physical execution
   ownership period. It contains the parent Turn digest, command/idempotency
   identity, Attempt, lease, fence and exact Worker runtime identity.
3. Capture `CloudStepContext` at every logical sampling boundary as required
   by ADR-0081. Every Step names both its parent Turn and Attempt digests, its
   monotonic sequence, active Tool registry and typed world state. ADR-0083
   distinguishes bounded provider attempts within that Step.
4. Sandbox reservation and every Tool operation carry both Turn and Attempt
   digests. The Sandbox Manager validates both before admitting the Step.
   Attempt rotation therefore invalidates old Tool authority without changing
   the logical Turn contract.
5. Pi Session JSONL remains the conversation authority. These contexts are
   trusted execution contracts and hashes; they are not added to model-visible
   messages. Only the semantic world-state deltas defined by ADR-0081 enter
   model context.
6. The synchronized trusted Worker/Manager protocol moves directly to the
   three-context shape. No compatibility fields or dual validation path are
   retained during current product development.

## Consequences

- A retry can prove that model, environment, Workspace base revision, Tool
  policy and budgets did not drift while still rotating Worker ownership.
- Lease and fencing changes are no longer misrepresented as changes to the
  logical user Turn.
- A Tool request is attributable to one accepted Turn, one current Attempt and
  one exact provider-request Step.
- Future per-Turn model, permission, Extension and collaboration settings have
  a stable home without entering the physical Attempt identity.

## Rejected alternatives

### Keep one CloudExecutionContext and infer the two lifetimes

This remains safe but cannot compare logical Turn stability independently from
Attempt ownership. The distinction is important once a Run is recovered on a
different Worker.

### Bind Tools only to the Attempt digest

That proves current ownership but does not prove which frozen model,
environment, Workspace and Tool policy the Attempt is executing.

### Put lease or fencing identity in CloudTurnContext

Those values deliberately rotate on takeover. Including them would make the
logical Turn digest unstable across retries and defeat the split.
