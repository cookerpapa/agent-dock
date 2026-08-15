# ADR-0078: Worker Control Channel and optional product modules

Status: accepted; product-module portion amended by ADR-0107

## Context

Run execution and cancellation are owned by the PostgreSQL ready queue and
shared Pi Worker pool. The Supervisor WebSocket previously retained unreachable
code for an older remote execution dispatcher. The default Control Plane also constructed
research services and exposed unfinished API/client workflows that the Web
product did not complete.

## Decision

1. The Supervisor WebSocket is the Worker Control Channel. It carries
   registration, heartbeat, durable event delivery and active Pi steer only.
2. PostgreSQL is the only Run queue and execution authority. The old remote
   Supervisor execution backend and its execute/cancel command handlers are
   deleted; the WebSocket cannot dispatch a Run.
3. Candidate Race, Rewind, Review Bundle and backend-only governance/insight
   experiments are removed by ADR-0107 rather than hidden behind a flag.
4. Observability and repository-import infrastructure use explicit Compose
   profiles.
5. Unfinished Preview, Diff, Artifact/test navigation, Fork/Rollback, GitHub PR
   and organization/RBAC/audit-search product routes and browser clients are
   deleted.

## Consequences

The default topology and public API are smaller, and there is one fewer Run
execution authority to reason about. Active steer still has a fenced two-phase
control exchange. Removed experiments remain available in Git history instead
of increasing the compiled or tested product surface.
