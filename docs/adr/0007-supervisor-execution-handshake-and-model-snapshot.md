# ADR-0007: Supervisor execution handshake and model snapshot

- Status: Accepted
- Date: 2026-07-18

## Context

The durable turn-intake path stores an immutable provider, model, thinking
level, and credential-binding version on every turn. The existing
`command.turn.execute` wire message does not carry that snapshot, so a
supervisor cannot reproduce the accepted turn without consulting control-plane
state or guessing from deployment defaults.

Command delivery also needs a precise side-effect boundary. Pi accepting a
prompt can immediately call a model or tool. If the supervisor starts Pi before
the control plane durably records the command ACK, a crash can make the same
outbox command look safe to retry after its side effects have already begun.

The outbox attempt number protects one control-plane claimant from another, but
it does not fence an old supervisor after a session is reassigned. The durable
session lease and its monotonically increasing fencing token remain a separate
required boundary.

## Decision

1. `command.turn.execute` carries the immutable model execution snapshot stored
   on the turn: model profile ID, provider, model ID, thinking level, opaque
   credential-binding ID, and binding version. It never carries an access token,
   refresh token, API key, secret reference, or arbitrary base URL.
2. The control plane acquires one durable session lease before delivery. Lease
   acquisition locks the session and selected sandbox, increments the session's
   `last_fencing_token`, and reserves one sandbox capacity slot.
3. A supervisor first performs a side-effect-free `prepare` step. It validates
   the closed wire command, lease ID, fencing token, session state, duplicate
   command ID, and local capacity, then returns an accepted, duplicate, or
   rejected `command.ack`.
4. For an accepted ACK, the control plane validates the exact command, session,
   turn, lease, and fence and durably changes the command/turn/session to their
   running states in the same transaction that revalidates the current lease.
5. Only after that transaction succeeds may the supervisor's `run` step submit
   the prompt to Pi. A failure before durable ACK can release the reservation
   and be retried; a failure after durable ACK is terminal or reconciled and is
   never blindly redelivered.
6. Every public event produced by that run is wrapped in the versioned
   `event.publish` message with the same command ID, lease ID, and fencing token.
   Raw Pi RPC values remain inside the sandbox-supervisor adapter.
7. Successful completion or terminal post-ACK failure releases the current
   lease and sandbox capacity in the same control-plane settlement transaction.
   A release with a different lease or fence is stale and changes nothing.
8. The first integration uses an in-process transport only to exercise the
   boundary deterministically. Pi process ownership stays in
   `@agent-dock/sandbox-supervisor`, the production control-plane entry point
   does not auto-start it, and this does not claim a production network
   transport or per-workspace sandbox.
9. Default tests use the loopback deterministic fake model. Real subscription
   credentials are neither required nor read by this path.

## Consequences

- A delivered command is self-contained enough for a supervisor to reproduce
  the accepted model policy without reading control-plane tables.
- The durable ACK is the last safe point before model/tool side effects begin.
- Outbox claimant attempts and session fencing tokens have distinct, testable
  responsibilities.
- A stale supervisor cannot publish events or settle a newly reassigned
  session, even if its old Pi process is still alive.
- Event persistence, cumulative event ACK, reconnect, lease renewal, and the
  production supervisor transport remain later vertical slices; the wire
  envelope already preserves the information they require.

## Rejected alternatives

### Let the supervisor read model profiles from PostgreSQL

This couples the execution plane to control-plane storage and makes retries
depend on mutable profile data instead of the snapshot accepted with the turn.

### Start Pi and persist the command ACK afterwards

The prompt may already have caused external side effects when ACK persistence
fails, so retrying the apparently unpublished outbox command would be unsafe.

### Treat the outbox attempt as the session fencing token

Attempts are local to one outbox record. They cannot fence an older supervisor
across another command, process reconnect, sandbox replacement, or session
reassignment.

### Put provider credentials in the execute command

Wire messages, logs, replay buffers, and error reports are broader exposure
surfaces than a request-scoped credential broker. Only an opaque binding and
version belong in the durable command contract.
