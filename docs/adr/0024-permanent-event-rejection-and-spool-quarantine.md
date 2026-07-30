# ADR-0024: Permanent event rejection and spool quarantine

- Status: accepted
- Date: 2026-07-19

## Context

ADR-0018 deliberately treats loss of a committed remote command transport as
ambiguous. The control-plane worker fails the durable command and turn, releases
its lease, and does not replay a command that may already have caused an
external side effect. The Supervisor independently revokes the local execution.
That revocation can produce one final event after its socket has closed, so the
crash-safe spool may contain an event for the now-released lease.

On same-boot reconnect, the control plane correctly rejects that publication as
`stale_fence`. The original WebSocket protocol expressed every event rejection
by closing the connection. The Supervisor therefore could not distinguish an
expected permanently stale delivery copy from corrupted protocol, invalid
credentials, or a transient service failure. It retried recovery through a new
connection and eventually treated the permanent close as a process-terminal
failure. A routine control-plane restart could consequently force a new
Supervisor boot even though the trusted host and all revoked workers had
settled.

Silently deleting the stale event would weaken ADR-0012's audit boundary.
Persisting it as a current session event would be worse: the lease has been
released and the control plane has already chosen the durable ambiguous-failure
outcome. Transparent continuation of the old command would contradict ADR-0018.

## Decision

1. Add a closed control-to-supervisor `event.rejected` message. It identifies
   the exact session, lease, fencing token, and rejected sequence. Version 1
   initially permits only the permanent `stale_fence` code and always carries
   `retryable=false`. It is a negative delivery result, never an ACK.
2. The WebSocket gateway sends `event.rejected` only when the socket connection
   itself is current and the event's lease authority is permanently stale. It
   keeps that current socket open. Authentication, connection-generation,
   malformed-message, event-conflict, sequence-gap, and service failures retain
   their existing fail-closed behavior.
3. The single-generation Supervisor client correlates the rejection with its
   one pending publication. A mismatched or unsolicited rejection is a protocol
   failure. A matched rejection raises a typed permanent delivery error to the
   spool recovery boundary without failing the current socket.
4. `WalEventSpoolStore` moves an assignment WAL rejected as `stale_fence`
   atomically from the active recovery root to a separate private quarantine
   root. It writes a fsynced, checksummed rejection record containing only the
   assignment identity, sequence, safe reason code, and rejection time. It does
   not delete or rewrite the original event and manifest.
5. Recovery reports scanned, replayed, and quarantined spool/event counts.
   Corruption, unsupported entries, I/O failure, a non-permanent rejection, or
   failure to durably quarantine remains terminal and leaves the Supervisor
   drained.
6. Active and quarantined roots are separate per Supervisor boot. A fresh boot
   never presents an old boot's delivery copies under its new authority.
   Quarantined data is operator/audit evidence and is not automatically replayed
   or garbage-collected by this slice.
7. After recovery finishes, same-boot reconnect may accept future commands. The
   ambiguous old turn remains failed, its command is never replayed, and its
   stale terminal event is not added to the authoritative event stream. A new
   user request must use a new command; if the session is durably failed, the
   current v0 API requires a new session.

## Consequences

- A planned or unplanned control-plane interruption cannot turn an expected
  stale delivery suffix into a Supervisor process restart.
- PostgreSQL remains the event authority: no ACK is fabricated and no event is
  accepted after lease release.
- Operators retain exact local evidence for post-incident inspection, at the
  cost of a bounded-by-volume quarantine that needs an explicit future retention
  policy.
- Production acceptance must prove same-process/same-boot reconnect, permanent
  spool quarantine, durable ambiguous failure of the interrupted command, and
  successful execution of a distinct later command. It must not expect the
  interrupted committed command to continue.

## Rejected alternatives

### Continue the old worker across transport loss

Fencing durable writes does not undo a shell command or external API call. A
new connection cannot prove which side effects happened while the result was
ambiguous.

### ACK and delete the stale event

An ACK means the exact event is durable in PostgreSQL. Returning one for a
rejected event would cross the persist-before-ACK boundary.

### Accept a terminal event without an active lease

That would let a stale writer mutate the authoritative event stream and could
contradict the already-settled turn outcome.

### Close and reconnect forever

The event's fence cannot become current again. Retrying consumes resources,
hides the durable outcome, and prevents the host from serving unrelated work.
