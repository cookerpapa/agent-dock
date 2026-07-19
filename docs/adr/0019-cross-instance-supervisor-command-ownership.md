# ADR-0019: Cross-instance supervisor command ownership by database affinity

- Status: accepted
- Date: 2026-07-19

## Context

ADR-0018 lets one Supervisor reconnect to a different control-plane replica and
rebuild future command authority. `SupervisorCommandRouter` deliberately stays
process-local because it owns promises and one physical WebSocket. A dispatcher
on another replica must not claim a command that only the socket-owning process
can deliver.

A generic cross-instance command broker is one possible solution, but it would
introduce another durable request/result protocol around the existing durable
outbox and two-phase Supervisor protocol. It would have to reproduce prepare,
ACK, commit, release, result, timeout, cancellation, and ambiguous-crash
semantics. Before adding that machinery, AgentDock should distinguish the two
actual routing cases:

- an execute command has no sandbox assignment before `SessionLeaseCoordinator`
  acquires one, so any replica with a healthy local Supervisor and capacity may
  claim it;
- a cancellation command targets an existing session lease, so it must follow
  that lease to the replica owning the matching Supervisor connection.

PostgreSQL already stores the active connection's `control_plane_instance_id`,
sandbox identity, expiry, assignment drain flag, capacity, and the target
session lease. The outbox claim transaction is already the exclusive work
selection boundary.

## Decision

1. Remote dispatchers may be configured with a closed
   `SupervisorDispatchAffinity` containing an exact sandbox ID and
   control-plane instance ID. Both are UUIDs established by trusted process
   configuration, not request payloads.
2. An affinity-bound execute dispatcher adds an eligibility predicate to its
   existing `FOR UPDATE SKIP LOCKED` claim. The fixed sandbox must be
   `ready/leased`, below capacity, and have an unexpired active connection owned
   by this control-plane instance with `accepting_assignments=true`.
3. That predicate is only an early claim guard. `SessionLeaseCoordinator.acquire`
   repeats the authoritative sandbox, capacity, connection-generation, expiry,
   drain, and fencing checks while creating the lease. A connection change
   between claim and acquire therefore fails before command ACK and follows the
   existing retry policy.
4. An affinity-bound cancellation dispatcher claims only when the target
   session has an exact unexpired lease for the configured sandbox and that
   sandbox's unexpired active connection is owned by this instance.
   `accepting_assignments` is deliberately ignored for cancellation: draining
   stops new work but must not prevent stopping existing work.
5. A failed affinity predicate returns `idle` without changing command, turn,
   outbox attempt, or retry deadline. Ownership contention is not an execution
   failure.
6. Socket ownership remains process-local. A process creates remote dispatcher
   workers only for Supervisor connections present in its local gateway. The
   database predicate is a second fence against stale workers; it is not a way
   for a socket-less process to send on another process's router.
7. Same-boot reconnect to another replica atomically changes the durable
   connection owner. From the next claim transaction onward, the old affinity
   is ineligible and the new affinity is eligible. Pending pre-ACK work remains
   in its original mailbox position.
8. No new table stores command payloads, prompts, credentials, ACKs, or results.
   PostgreSQL remains the durable command/outbox owner and the existing
   WebSocket remains the command transport.
9. The v0 implementation may run bounded async polling lanes per locally
   connected sandbox and configured tenant. These are capacity workers, not a
   process, OS thread, or timer per session. Production automatic worker
   lifecycle wiring remains part of the provisioner/owner adapter.
10. A broker remains an allowed future optimization if measured requirements
    demand a global scheduler, cross-region routing, or dispatch to a socket
    owner that cannot run a local claim worker. Its payload and failure protocol
    must then be separately specified and tested.

## Failure boundaries

| Race | Required outcome |
| --- | --- |
| old and new owner claim concurrently | PostgreSQL active-generation row and outbox lock allow only the eligible owner to mutate the claim |
| connection changes after execute claim | guarded lease acquire fails pre-ACK; mailbox retry remains safe |
| connection changes after cancellation claim | exact current-assignment/transport checks fail; cancellation intent remains durable |
| sandbox enters drain | no new execute claim; cancellation remains eligible |
| local socket disappears but DB has not switched/expired | backend fails before ACK or ambiguous after commit according to ADR-0017; another replica does not guess ownership |

## Consequences

- Multiple control-plane replicas can share one PostgreSQL outbox without
  sending commands through the wrong process-local router.
- Supervisor failover changes command ownership through one existing database
  transaction rather than a second broker protocol.
- Execute scheduling remains opportunistic across locally connected sandboxes;
  global fairness and tenant quotas remain Phase 4 work.
- A process must still start and stop bounded local dispatcher workers as
  Supervisor sockets attach and detach. The production `main.ts` does not yet
  fabricate this lifecycle without a real provisioner and owner boundary.

## Rejected alternatives

### Store a second cross-instance command queue immediately

It duplicates the current outbox and creates another prepare/commit/result
recovery problem without a measured need. The database already knows which
replica can safely claim each kind of work.

### Let any replica claim and fail until it finds the socket owner

Wrong-owner claims consume attempts and retry delay, can exhaust bounded retry
budgets during normal topology changes, and make ownership contention look like
an agent failure.

### Require `accepting_assignments=true` for cancellation

A draining Supervisor must remain able to stop work it already owns. Applying
the execute admission flag to cancellation could make shutdown impossible.

### Forward only cancellation between replicas

The target lease already supplies a database routing key. Owner-affined claim is
durable, simpler, and avoids adding a partially specified inter-process RPC.
