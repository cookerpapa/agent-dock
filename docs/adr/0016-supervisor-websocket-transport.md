# ADR-0016: Authenticated outbound supervisor WebSocket transport

- Status: Accepted
- Date: 2026-07-19

## Context

ADR-0015 implements the durable registration, connection-generation,
heartbeat, timeout, and retirement state machine, but its tests call the
manager directly. A cloud supervisor needs an outbound network connection so it
can run behind NAT and without exposing an inbound sandbox port.

The transport must not weaken the manager's semantics. In particular, an HTTP
Upgrade is not proof of sandbox identity, a WebSocket close is not proof that
Pi or its tools stopped, concurrent frame handlers can reorder heartbeats, and
an unbounded frame queue can turn one supervisor into a control-plane memory
attack. A same-boot reconnect must fence the old connection generation even
when the old TCP socket remains open on another control-plane replica.

The complete command/event transport also needs durable command ACK routing,
event backpressure, cumulative ACK correlation, and cancellation concurrency.
Those responsibilities should not be hidden inside the first connectivity
slice.

## Decision

1. The supervisor initiates an outbound WebSocket to a versioned internal route.
   The route is installed before other Fastify routes and uses the official
   Fastify WebSocket plugin with compression disabled and a bounded payload.
2. HTTP Upgrade authentication is represented by a closed
   `SupervisorUpgradeAuthorizer` interface. It returns only the authenticated
   supervisor/boot/sandbox identity. The gateway generates a fresh transport ID
   for every accepted socket and combines both values into the authority passed
   to `SupervisorConnectionManager`.
3. A development/test hashed-bearer authorizer stores only SHA-256 token bytes
   after construction and compares candidate hashes in constant time. It is not
   a multi-tenant credential issuer. Production may implement the same boundary
   with mTLS/SPIFFE or a provisioner-issued credential without changing wire
   message handling.
4. Authentication completes in Fastify's pre-validation phase, before the
   WebSocket is established. Failed authentication returns HTTP 401 and never
   reaches a frame handler. Authorization headers and token values are never
   copied into protocol messages, database rows, errors, or logs.
5. The first text frame must be `supervisor.register` within a bounded deadline.
   Binary frames, invalid JSON, invalid wire messages, heartbeat before
   registration, and unsupported message types close the socket with a bounded
   generic reason. Registration policy errors do not echo internal details.
6. Every socket processes frames through one promise chain. The number of
   retained pending frames is bounded; overload closes the socket rather than
   accumulating arbitrary buffers. Server sends await the WebSocket callback so
   message processing observes send failure.
7. After successful registration, the gateway accepts
   `supervisor.heartbeat`, routes it through the durable manager, and returns the
   exact heartbeat ACK. The connection ID and authenticated transport authority
   are revalidated transactionally by the manager.
8. A same-process reconnect closes the previous socket with a private
   superseded code after the new generation commits. Across replicas, the old
   socket is rejected on its next manager-routed frame because PostgreSQL—not
   the socket map—is authoritative.
9. Socket close only removes process-local routing state. It does not mark the
   sandbox failed, delete a lease, or invoke reconciliation. Same-boot reconnect
   remains possible until durable heartbeat expiry; the health worker owns
   timeout and retirement.
10. The sandbox-side client validates the registration response, uses one
    server-negotiated heartbeat timer for all active assignments, permits only
    one heartbeat in flight, applies exact lease renewals through the local
    supervisor, and surfaces close/failure without printing its authorization
    header.
11. This slice intentionally rejects `command.ack` and `event.publish` and does
    not send execution/cancellation commands. A later transport-router slice
    will add those messages with durable command correlation, bounded outbound
    queues, event ACK backpressure, and independent cancellation delivery.

## Consequences

- Registration and heartbeat now cross a real loopback WebSocket in tests rather
  than an in-process function call.
- The gateway can be mounted on a dedicated internal Fastify listener or before
  public routes in a shared listener.
- A supervisor can reconnect without keeping one server thread or process per
  cold conversation; one socket and heartbeat loop cover its active sessions.
- Command execution is not yet remote, so the production HTTP entry point still
  does not start a supervisor gateway with a fake owner or credential.

## Rejected alternatives

### Put supervisor identity in query parameters

IDs are assertions, not credentials, and URLs are commonly logged. The Upgrade
authorizer must establish identity before registration JSON is trusted.

### Run frame callbacks concurrently

Registration, reconnect, heartbeat, and close could be observed in different
orders. A per-socket serial queue is simpler and preserves wire order.

### Treat WebSocket close as process exit

A network partition can leave the old supervisor and tools running. Only the
owner boundary from ADR-0015 may prove that the exact boot stopped.

### Add command/event routing in the heartbeat handler

Execution delivery and event publication have different durability and
backpressure requirements. Folding them into a generic request/response loop
would hide ACK ordering and cancellation races instead of making them explicit.
