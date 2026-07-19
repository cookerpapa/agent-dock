# ADR-0015: Authenticated supervisor registration and durable health management

- Status: Accepted
- Date: 2026-07-19

## Context

ADR-0014 made long-running assignment renewal and old-sandbox reconciliation
executable through the local in-process bridge. The wire contract already has
`supervisor.register`, `supervisor.registered`, and connection-scoped
heartbeats, but no production-shaped component owns those messages.

Keeping connection state only in a NestJS process is insufficient. A control
plane replica may crash after accepting a supervisor, a registration ACK may be
retransmitted, and two replicas may briefly observe the old and replacement
connections. A heartbeat timeout revokes liveness, but it does not prove that
Pi, a tool descendant, or the outer runtime has stopped. Conversely, allowing a
new heartbeat to revive an expired connection would bypass the lease and
fencing boundary.

The registration payload is also not an authentication credential. A sandbox
must not be able to choose another supervisor, boot, or sandbox identity merely
by putting those values in JSON.

## Decision

1. A trusted provisioner creates the sandbox row before registration. The
   transport passes a closed registration authority containing the authenticated
   supervisor ID, boot ID, sandbox ID, and a fresh transport ID. Registration
   requires an exact match between that authority, the wire payload, and the
   pre-provisioned row. The payload never creates an arbitrary sandbox or grants
   tenant authority.
2. Registration enforces protocol version 1, the configured AgentDock
   supervisor version, the pinned Pi package/version, required capabilities,
   and the pre-provisioned capacity. Only a `provisioning` sandbox can become
   `ready`; reconnect may preserve an existing `ready` or `leased` sandbox.
3. Every accepted transport receives a random connection ID. PostgreSQL stores
   the transport ID, registration and response message IDs, normalized payload
   fingerprint, owning control-plane instance, runtime versions, capabilities,
   heartbeat policy, last heartbeat, expiry, and close state. One sandbox has at
   most one active connection.
4. Repeating the exact registration message on the same transport returns the
   original response while that connection remains current and unexpired. A
   changed payload, cross-transport replay, or retry after supersession/expiry is
   rejected. A new transport must use a new registration message ID.
5. A same-boot reconnect before expiry supersedes the prior connection and may
   continue the same supervisor-owned runtimes and durable event spool. It does
   not create a second sandbox. The old connection can no longer renew leases.
   An expired connection is never revived, even if the boot ID is unchanged.
6. A different boot for the same logical supervisor must use a different,
   pre-provisioned sandbox row. Registration atomically fences every older
   connection, quarantines the old sandbox, and enqueues durable retirement. It
   never adopts the old Pi process, descriptors, tool stream, or in-memory
   extension state.
7. Heartbeat liveness validation, expiry extension, sandbox identity validation,
   and assignment lease renewal share one database transaction and lock order.
   The exact connection, transport, control-plane owner, supervisor, boot,
   sandbox, capacity, and unexpired state must match. Registration therefore
   cannot race an already-started old heartbeat past the connection fence: one
   transaction is ordered before the other.
8. `acceptingAssignments` is durable connection health, not a sandbox lifecycle
   transition. A registered lease coordinator refuses new assignments while it
   is false, while the existing assignments may still renew and settle.
9. A health sweep atomically changes expired active connections to fenced,
   quarantines their sandboxes, and enqueues retirement. Expiry stops renewal
   authority but retains session leases and capacity until runtime absence is
   proven.
10. Sandbox retirement is a separate durable work queue. A control-plane worker
    claims a row with a bounded claim, first asks a trusted owner boundary to
    stop and confirm the exact supervisor boot, and only then calls
    `AssignmentReconciler.retireSandbox()`. Retryable failures return with a
    delay; non-retryable identity or invariant failures become `blocked` for
    operator inspection. A crashed claimant can be replaced after claim expiry.
11. The owner-boundary contract is deliberately stronger than a WebSocket close
    or missed heartbeat: successful return means that exact boot can no longer
    create an execution runtime. Docker/Kubernetes process ownership implements
    that contract outside the untrusted sandbox.
12. This slice is transport-neutral. A future outbound WebSocket endpoint must
    create the authenticated transport authority, route heartbeats through this
    manager, reject post-registration traffic from a non-current connection,
    and close superseded sockets. The production HTTP entry point does not
    silently start a fake supervisor or Docker owner.

## Consequences

- Control-plane restart and multi-replica timeout scanning use PostgreSQL rather
  than process memory as the connection-generation authority.
- Network reconnect for the same live boot is distinct from process restart.
- Old capacity is not released merely because a connection disappeared.
- Registration and heartbeat add small bounded writes per live supervisor, not
  per cold session.
- Retirement can be retried safely, but an acknowledged in-flight turn still
  becomes ambiguous `assignment_lost`; AgentDock does not claim exactly-once
  tool side effects.
- A remote WebSocket transport, authenticated provisioner, and concrete
  Docker/Kubernetes owner-boundary adapter remain separate deployment slices.

## Rejected alternatives

### Trust the IDs advertised by `supervisor.register`

The message comes from the execution side and is not an authorization grant.
Doing so would let one sandbox claim another sandbox's capacity or boot.

### Keep connection generation only in a control-plane map

A crashed replica could not fence its old generation, and a replacement replica
could race lease renewal without a shared compare-and-set boundary.

### Release leases immediately on heartbeat timeout

The old tool or container may still be running. Reassignment before confirmed
absence can create concurrent writers and duplicate external effects.

### Kill and reconcile synchronously inside registration

Container or pod teardown may be slow or temporarily unavailable. Holding the
registration transaction across that external operation would increase lock
time and still would not survive a control-plane crash midway through cleanup.
