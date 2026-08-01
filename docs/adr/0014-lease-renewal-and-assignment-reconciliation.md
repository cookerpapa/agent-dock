# ADR-0014: Lease renewal and execution-assignment reconciliation

- Status: Accepted
- Date: 2026-07-19

## Context

AgentDock assigns every active turn an opaque lease ID and monotonically
increasing fencing token. The current lease has a fixed expiry. A turn longer
than that duration eventually loses the ability to publish events or commit a
checkpoint even when its supervisor is healthy. Conversely, an expired row
does not prove that Pi, a tool descendant, or an outer Docker container has
stopped. Deleting that row and immediately reassigning the session could run two
execution boundaries concurrently.

The versioned wire contract already contains supervisor heartbeats and
heartbeat acknowledgements with lease renewals, but the local integration does
not execute that protocol. Docker activations have a managed label and command
identity, but not enough lease/boot identity for a restart-time inventory to
make a safe decision.

An acknowledged turn may already have performed arbitrary shell or external
side effects. Reconciliation therefore cannot describe an unknown execution as
exactly once or silently replay it from the beginning.

## Decision

1. An active supervisor runs one shared heartbeat loop—not one timer per turn—
   and periodically sends the existing closed
   `supervisor.heartbeat` message. Every reported assignment includes its exact
   session, turn, lease, fence, runtime state, highest produced event sequence,
   and cumulative acknowledged sequence.
2. The control plane renews an assignment only when the heartbeat connection,
   supervisor boot, sandbox, session/turn/command lifecycle, current lease and
   fence, and event-sequence observations are mutually consistent. Renewal
   atomically advances `valid_until` and `renewed_at` and returns the same lease
   ID/fence in `supervisor.heartbeat.ack`.
3. An expired lease is never resurrected. An unknown, stale, expired, malformed,
   or omitted assignment receives no renewal. A supervisor treats a missing or
   mismatched renewal as lease loss and aborts the exact assignment with the
   internal `lease_revoked` reason.
4. Lease loss stops new event/checkpoint mutation immediately through the
   existing database fence. The execution boundary must still confirm Pi/tool/
   container teardown. A post-ACK lease-loss result is classified as ambiguous
   and leaves the session failed rather than returning it directly to `idle`.
5. Expiry alone never releases a lease or sandbox capacity. Reconciliation runs
   only after the assignment-producing supervisor boot can no longer create a
   new runtime for the observed command (for example, its owner process exited,
   or the supervisor manager fenced and drained it). The reconciler then
   inventories the execution runtime and terminates the exact matching boundary.
   Only confirmed absence authorizes a transaction that revalidates the stale
   lease, fails nonterminal execute/cancellation commands and their turn/session
   with `assignment_lost`, removes the lease, and repairs capacity. A command
   that never reached durable ACK may instead return to its original mailbox
   position after absence is confirmed; an acknowledged command is never
   silently replayed.
6. Docker activations carry closed labels for managed status, supervisor ID,
   supervisor boot ID, sandbox ID, command, session, turn, lease, and fencing
   token. Docker inventory is host-side trusted code. It lists only the
   configured sandbox scope, re-inspects identity immediately before removal,
   uses the container ID as the destructive target, and verifies absence after
   removal. The sandbox never receives the Docker socket.
7. A managed runtime with no matching durable assignment is an orphan and is
   terminated. All exact duplicate boundaries are removed; malformed,
   conflicting, or changed identities fail closed instead of being guessed. If
   termination/absence cannot be confirmed, the sandbox is
   quarantined as `failed`; the lease and capacity reservation remain for a
   later retry.
8. A restarted supervisor registers a new sandbox/boot identity. It does not
   adopt an old in-flight Pi process, open file descriptors, or tool stream. The
   old sandbox is reconciled and retired only after all of its managed runtime
   boundaries are absent. New assignments use the new sandbox row and therefore
   a new execution lease/fence.
9. Reconciliation is idempotent and identity-fenced. If renewal, settlement, or
   another reconciler changed the durable lease before the final transaction,
   the stale attempt changes no newer assignment.
10. The first implementation drives the real heartbeat contract through the
    existing in-process supervisor/control-plane bridge. A future outbound
    WebSocket transport must preserve the same connection, boot, omission,
    expiry, and teardown semantics; it must not replace them with a local timer
    that blindly extends rows.

## Consequences

- Healthy turns may outlive their initial lease without losing event or
  checkpoint authority.
- A stale supervisor cannot renew after expiry or under a new boot/connection.
- Database capacity is not made available while an old container may still be
  executing.
- Supervisor restart intentionally sacrifices an in-flight turn rather than
  pretending to restore process memory or exactly-once side effects. The last
  settled Pi/workspace checkpoint remains the recovery boundary.
- Failed sessions require an explicit recovery operation before queued
  follow-ups run. Automatic recovery policy and human review of ambiguous
  external mutations remain later product work.
- Heartbeats add bounded periodic database writes proportional to active
  assignments, not total cold sessions. One supervisor heartbeat covers all of
  its active assignments, avoiding per-turn heartbeat loops.

## Rejected alternatives

### Extend the lease from the execution promise in the control plane

That proves only that one JavaScript promise still exists. It does not prove a
remote supervisor boot owns the assignment and bypasses the heartbeat/fencing
contract already defined for production transport.

### Delete every expired lease and retry the command

The old Pi/tool/container may still run, and an acknowledged command may have
already changed files or an external system. Expiry revokes authority; it does
not establish runtime absence or safe replay.

### Adopt old containers after a supervisor restart

The new process lacks the authenticated stream, in-memory Pi SDK state,
checkpoint handshake, event publisher, and cancellation handle. Container
liveness is insufficient to reconstruct those responsibilities safely.

### Put reconciliation inside the sandbox

Untrusted execution code must not inspect siblings or access the Docker socket.
Inventory and termination stay in the trusted host-side supervisor boundary.
