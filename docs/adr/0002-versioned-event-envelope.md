# ADR-0002: Versioned AgentDock event envelope

- Status: Accepted
- Date: 2026-07-18

## Context

The Pi SDK emits useful runtime events, responses, and extension UI requests,
but those messages are an upstream runtime contract. They do not carry all of the
tenant/session/turn/agent identity, durable ordering, replay, and compatibility
metadata required by AgentDock's control plane and browser clients.

Persisting or publishing raw Pi messages would couple the database, API, and
frontend to one Pi release. It would also risk exposing upstream request IDs or
new fields before AgentDock has reviewed their security and tenancy semantics.

## Decision

1. AgentDock publishes a closed, discriminated union of versioned event schemas.
2. Every event contains `schemaVersion`, `eventId`, `sessionId`, `turnId`,
   `agentId`, `seq`, `occurredAt`, `type`, and a type-specific `payload`.
3. `turnId` is explicitly nullable for session-level events; turn-scoped events
   must supply it.
4. `seq` is monotonically increasing within a session event stream. Durable
   allocation, leases, fencing, and ACK semantics are deferred to ADR-0004.
5. Event and payload objects reject additional properties. New public data
   requires a deliberate schema change rather than accidental passthrough.
6. Only the sandbox-supervisor Pi adapter may inspect raw Pi SDK event shapes. It maps
   reviewed fields into AgentDock events and keeps the Pi UI request ID private.
7. Unknown or malformed Pi events are ignored or reported as adapter outcomes;
   they are never published as an untyped raw-event escape hatch.
8. Schema version 1 covers turn start/completion/failure, session state, text
   deltas, tool lifecycle, approval lifecycle, and UI notifications.

## Consequences

Positive:

- Pi upgrades are isolated behind one adapter;
- persistence and SSE replay receive stable identity and ordering fields;
- clients can exhaustively handle known event types;
- raw upstream fields cannot silently cross the public boundary;
- schema fixtures become executable compatibility documentation.

Negative:

- each useful Pi event needs an explicit mapping;
- some upstream details will be intentionally dropped;
- schema evolution and compatibility tests become ongoing work.

## Revisit criteria

Add a new envelope version only for a breaking semantic or structural change.
Additive event types may remain in version 1 when old consumers can safely
ignore unknown discriminators at the transport boundary.
