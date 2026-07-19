# ADR-0017: Two-phase remote command delivery

- Status: accepted
- Date: 2026-07-19

## Context

ADR-0016 carries authenticated registration and lease heartbeats over a real
outbound WebSocket. Execute and cancellation commands still use the in-process
`LocalSupervisorExecutionBackend`.

The existing local boundary deliberately separates `prepare` from `run`:
preparation returns a side-effect-free command ACK, the dispatcher persists the
acknowledged command lifecycle, and only then may Pi or a tool start. Sending an
execute command and starting it as soon as the ACK is written to a socket would
destroy that ordering. The control-plane process can fail after receiving the
ACK but before committing its database transaction.

Remote delivery also needs a bounded way to return runner completion or failure.
Terminal public events remain the durable user-visible history, but failures can
occur before Pi produces a terminal event. Therefore event publication alone is
not a complete command-response channel.

## Decision

1. Remote command delivery is capability gated by `command.two_phase.v1`.
   Supervisors that only support registration and heartbeat may still register,
   but they are never selected by the remote command transport.
2. `command.turn.execute` and `command.turn.cancel` remain preparation messages.
   The Supervisor calls the existing side-effect-free `prepare` boundary and
   returns `command.ack`. It MUST NOT call `run` in this phase.
3. An accepted ACK is correlated by command, session, turn, lease, and fencing
   token. The control plane calls the dispatcher's durable `lifecycle.started`
   transaction before sending `command.commit`.
4. `command.commit` repeats that identity and references the exact accepted ACK
   message ID. Only a matching commit may invoke `run`. Repeated matching commits
   reuse the Supervisor's existing execution promise and do not start another
   runner.
5. If the durable lifecycle transaction fails before commit, the control plane
   best-effort sends `command.release`. A matching release discards only an
   uncommitted preparation. It never stops committed work; cancellation remains
   an explicit fenced command.
6. The Supervisor returns one `command.result` for each accepted commit. The
   result references the commit message ID and is one of:
   - completed execute with a stop reason;
   - completed cancellation with reason and forced flag;
   - cancelled execute with reason and forced flag;
   - bounded safe failure metadata.
7. Public events continue to use the existing durable spool. The gateway writes
   `event.publish` through `DurableEventStore` before returning the cumulative
   `event.ack`. Exact redelivery is accepted by that store; a conflicting event
   closes the transport.
8. Command ACKs, results, and event ACKs are validated against the authenticated
   connection and their pending identity. Unsolicited, duplicated-at-the-wrong-
   stage, or mismatched replies close the connection rather than being guessed.
9. A socket close is still not proof of process death. Nevertheless, the client
   releases all uncommitted preparations and revokes all locally committed
   assignments when it loses the lease-renewal channel. The durable heartbeat
   timeout and owner-process retirement remain the authoritative external fence.
10. The gateway rejects all pending exchanges when a connection is superseded or
    closes. Before durable start this is retryable. After durable start it is an
    ambiguous remote execution failure and the session is quarantined until
    reconciliation proves runtime absence.
11. Command exchange is local to the control-plane instance that owns the socket.
    PostgreSQL still fences stale sockets across replicas, but this ADR does not
    add a cross-instance command broker. A Supervisor reconnect or owner failover
    rebuilds the guarded backend on the new connection generation.

The message additions remain inside protocol version 1 because an explicit
capability gates their use. A peer that has not advertised the capability never
receives them.

## Crash boundaries

| Boundary | Durable state | Required behavior |
| --- | --- | --- |
| Before command ACK | command is dispatched, not acknowledged | retry after claim/lease recovery |
| After ACK, before durable lifecycle | command is not acknowledged | release preparation; retry or fail normally |
| After durable lifecycle, before commit | command is acknowledged, no tool was intentionally started | fail safe and reconcile; never replay blindly |
| After commit, before result | side effects may have started | treat as ambiguous, revoke/fence, then reconcile |
| After event persistence, before event ACK | event is durable | exact spool redelivery receives the same cumulative prefix ACK |

This phase guarantees at-most-one local `run` invocation per Supervisor command
identity and persist-before-side-effect ordering. It does not claim distributed
exactly-once execution.

## Consequences

- The remote backend can use the same outbox and cancellation dispatchers as the
  local backend without weakening their lifecycle invariants.
- One WebSocket multiplexes heartbeats, multiple session commands, results, and
  event publications; no thread or process is created per cold session.
- Result and ACK timeout limits are bounded and configurable, while long-running
  progress is kept alive by the shared heartbeat and lease path.
- ADR-0018 adds automatic same-boot reconnect and per-command guarded backend
  resolution. ADR-0019 adds cross-instance database claim ownership without a
  second broker. Durable recovery of the narrow acknowledged-before-commit crash
  window remains separate work.

## Rejected alternatives

### Start immediately after writing `command.ack`

The ACK may not have been persisted by the control plane. A retry can then run
the same tool action twice.

### Treat public terminal events as the only command result

Runtime startup, protocol, checkpoint, or spool-open failures can happen before a
terminal event exists. The dispatcher would wait without a bounded outcome.

### Use WebSocket close as cancellation

A close is ambiguous and may be caused by a proxy or control-plane restart. It is
not a user cancellation command and cannot replace lease fencing plus owner
retirement.

### Add a process or thread per command

The Supervisor runtime already multiplexes logical session assignments. Per-turn
OS execution ownership would recreate the scaling problem this project is meant
to avoid.
