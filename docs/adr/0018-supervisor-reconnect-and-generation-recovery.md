# ADR-0018: Supervisor reconnect and connection-generation recovery

- Status: accepted
- Date: 2026-07-19

## Context

ADR-0016 and ADR-0017 provide an authenticated outbound WebSocket and a
two-phase remote command exchange. The sandbox-side client still represents one
connection generation: any transport loss revokes its local assignments and the
process must be restarted manually before the sandbox can accept later work.

The control-plane remote backend also captures the `SessionLeaseCoordinator`
created for one connection generation. A same-boot reconnect correctly
supersedes that generation in PostgreSQL, but a previously constructed backend
continues presenting the stale transport and connection identity.

Automatic reconnect must not be described as transparent execution resume. A
socket can disappear after a committed shell command has produced an external
side effect. Replaying that command on a fresh connection would weaken the
persist-before-run boundary and create an exactly-once claim that AgentDock
cannot make.

There is also a drain-state race. Registration currently stores
`accepting_assignments=true` before the first heartbeat. A supervisor that was
draining before reconnect could therefore receive work during the interval
between registration and its first heartbeat.

## Decision

1. `SupervisorWebSocketClient` remains a single-use, single-generation
   connection. It reports whether its terminal close is retryable and
   distinguishes rejected authentication from transient handshake failures.
2. A separate `ReconnectingSupervisorWebSocketClient` owns the process-lifetime
   loop. It creates a fresh single-generation client for each attempt and uses
   bounded exponential backoff with equal jitter. Backoff is reset only after a
   configured stable connection interval, limiting reconnect storms during a
   flapping outage.
3. The loop retries transient connection, heartbeat, overload, and server
   failures. It stops on authentication or protocol rejection, a normal close,
   and a superseded connection. Retrying a superseded identity could make two
   live supervisor processes continually steal ownership from each other.
4. Stopping the loop interrupts both an active connection and a pending backoff.
   It never creates another socket after stop begins.
5. Every transport close first invokes the existing fail-closed assignment
   revocation. Before opening another connection, the loop waits for the runtime
   to confirm that all revoked assignments have settled. That wait is bounded;
   timeout is terminal and requires the trusted owner/reconciliation path.
   This prevents a new same-session Pi runtime from overlapping an old process
   that is still terminating.
6. Reconnect restores only the supervisor's ability to receive future commands.
   It does not replay a committed command, adopt an old process, or change the
   durable failure/reconciliation result of an in-flight exchange.
7. `supervisor.register` now carries the supervisor's current
   `acceptingAssignments` value. Registration persists it in the same
   transaction that creates the connection generation. Later changes continue
   to flow through heartbeat. AgentDock is pre-1.0 and upgrades its closed
   internal protocol and both peers together.
8. A reconnect preserves the operator's current drain setting. The reconnect
   loop applies it before each registration, rather than resetting it when a new
   single-generation client is constructed.
9. `RemoteSupervisorExecutionBackend` resolves a connection-guarded
   `SessionLeaseCoordinator` at the beginning of each execute or cancel command.
   That coordinator is retained for the complete exchange. A disconnect during
   the exchange therefore fails against the old generation; a later command
   resolves the new generation.
10. The process-local command router still owns exchanges for its socket. This
    ADR does not move a pending pre-ACK or post-commit exchange between control
    plane instances. Cross-instance dispatch ownership remains a separate
    durable routing decision.

## Failure boundaries

| Failure | Reconnect behavior | Command behavior |
| --- | --- | --- |
| DNS/TCP/HTTP 5xx, abnormal close, heartbeat timeout | bounded retry | pre-ACK may retry through the mailbox; committed work fails ambiguous |
| HTTP 401/403 or protocol/policy close | terminal | no new command is accepted |
| connection superseded by another live process | terminal | old generation is fenced |
| revoked assignment does not settle before timeout | terminal | owner-stop and reconciliation must prove absence |
| clean operator stop | no retry | current assignments are revoked before completion |

## Consequences

- A short network interruption no longer requires restarting an otherwise
  healthy supervisor process.
- One process still owns one shared connection at a time; reconnect does not add
  a thread or process per session.
- A backend object may outlive several connection generations without carrying
  stale lease authority into a new command.
- The design deliberately favors fail-closed termination over seamless
  continuation of an ambiguous tool execution.
- Cross-instance command forwarding, durable live-event notification, and
  production provisioner/mTLS ownership remain later work.

## Rejected alternatives

### Reuse one mutable WebSocket client forever

Resetting all timers, pending promises, prepared commands, and close state in
place makes generation leakage easy. A fresh one-shot client keeps every pending
exchange scoped to exactly one socket.

### Reconnect immediately without waiting for runtime teardown

The database can issue a higher fencing token before the old local process has
exited. Fencing protects durable writes, but it does not stop two tool processes
from modifying the same workspace concurrently.

### Retry all close codes

Retrying invalid credentials or a superseded identity hides operator errors and
can create a permanent connection-ownership duel.

### Resume committed commands on the new connection

The old process may already have executed a shell command or external API call.
Without a command-specific idempotency contract, replay is unsafe.
