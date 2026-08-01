# ADR-0007: Execution handshake and immutable model snapshot

- Status: accepted, refined by ADR-0074
- Date: 2026-07-18

## Context

A Run must execute the model policy accepted with the user message, even if an
administrator rotates the platform model before the Activity starts. Model or
Tool side effects also must not begin until durable RunAttempt authority exists.

## Decision

1. The exact execute command carries the accepted model profile, provider,
   model, thinking level and opaque credential version. It never carries a
   provider key, refresh token, secret reference or caller-controlled base URL.
2. Temporal schedules that exact command ID. PostgreSQL transactionally checks
   Session/Workspace ordering and tenant capacity, creates the RunAttempt and
   grants a lease with a new fencing token.
3. The trusted Pi Worker validates command identity, current Attempt and local
   capacity before acknowledging execution authority. Only then may the embedded
   Pi SDK receive the prompt.
4. Events and terminal/checkpoint commits carry the exact Run, Attempt, lease
   and fence. Stale authority cannot advance canonical conversation or
   Workspace state.
5. A failure before side effects may follow Temporal's bounded retry policy. An
   ambiguous Tool side effect is not replayed as though execution were exactly
   once.
6. Default tests use the deterministic loopback model. Real-provider checks are
   explicit and bounded.

## Consequences

- Model rotation does not mutate in-flight work.
- Temporal schedules work but does not replace durable authorization/fencing.
- A Worker cannot infer mutable policy from deployment defaults.
- Arbitrary shell side effects retain honest at-most-once-start semantics.
