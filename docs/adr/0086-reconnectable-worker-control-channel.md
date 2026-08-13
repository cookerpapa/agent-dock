# ADR-0086: Reconnectable Worker Control Channel

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0031, ADR-0078 and ADR-0101

## Context

The Worker WebSocket is a management channel, not the production Run transport.
A Worker claims a command and renews its Session Lease directly in PostgreSQL.
Nevertheless, the reconnecting client previously revoked every active
assignment as soon as its WebSocket to one Control Plane process closed. A
rolling restart or isolated Control Plane crash therefore sacrificed otherwise
healthy Agent Loops.

Keeping an assignment alive merely because a socket may reconnect would also be
unsafe if the Worker had lost its durable lease. Transport liveness and execution
ownership must remain separate.

## Decision

1. A retryable Control Channel close suspends only that transport. It does not
   revoke active assignments.
2. During the gap, an active Run may continue only while its direct PostgreSQL
   Lease heartbeat and Fencing checks remain valid. The change does not extend a
   Lease or mint a new fence.
3. The reconnecting client immediately registers the same Supervisor boot and
   Sandbox identity with a replacement Control Plane connection. The server may
   supersede the stale connection for that identity.
4. Active steer is unavailable while disconnected. A prepared steer remains
   fenced and cannot silently commit on another Attempt.
5. Explicit Worker shutdown, authentication/protocol rejection, a non-retryable
   close, or failure of the durable Session Lease still revokes assignments and
   waits for local teardown.
6. Kafka/Event Gateway ingestion remains independent of the management socket.
   A restarted browser/Control Plane resumes the committed stream using its
   durable sequence cursor and canonical PostgreSQL Turn state.
7. A process-level test kills a real Control Channel server with `SIGKILL`,
   starts a replacement on the same address and proves that the active runtime
   was not revoked during the retryable gap.

## Consequences

- A Control Plane process restart no longer unconditionally terminates healthy
  model or Tool work.
- PostgreSQL Lease availability is now the safety condition during a management
  transport outage. If PostgreSQL is unavailable long enough to lose ownership,
  the Run still fails closed.
- The Worker cannot accept new management commands while disconnected, but it
  can finish the exact PostgreSQL command it already owns.
- Reconnection improves availability without weakening Fencing or allowing two
  Workers to commit the same Workspace head.

## Rejected alternatives

### Revoke on every WebSocket close

This treats one stateless Control Plane replica as the Run owner and turns normal
rolling replacement into user-visible failure.

### Extend the Worker Lease during a Control Plane outage

The Worker already renews against PostgreSQL. Extending ownership based only on
local belief would allow a partitioned Worker to survive after a newer Attempt
has taken ownership.

### Move Run execution onto the WebSocket

That would reintroduce a second scheduler next to PostgreSQL and reverse
ADR-0078/ADR-0101.
