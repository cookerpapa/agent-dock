# ADR-0009: Durable turn cancellation and process-exit confirmation

- Status: Accepted
- Date: 2026-07-19

## Context

An HTTP client needs to stop a running Pi turn without calling an in-memory
`AbortController` directly. The request can race with natural completion, a
control-plane restart, a stale supervisor, a lost command ACK, and a Pi process
whose model request or descendant tool process does not stop cooperatively.

The existing wire protocol already has `command.turn.cancel`, but its
`commandId` is ambiguous: a cancellation is itself a durable command while the
supervisor also needs to identify the earlier execute command that owns the
running assignment. The current local runner supports only an internal turn
timeout and always maps Pi's `aborted` stop reason to failure. It therefore
cannot distinguish an expected user cancellation from an execution fault or
prove that the process tree has stopped.

HTTP acceptance, supervisor acceptance, logical agent abort, and operating
system process exit are different facts. Collapsing them into one `cancelled`
flag would let the UI report success while model/tool work is still consuming
resources.

## Decision

1. The public endpoint is
   `POST /v1/sessions/:sessionId/turns/:turnId/cancellations` with a required
   `Idempotency-Key`. In v0 it accepts an active `running` or
   `waiting_approval` turn only. Queued-command withdrawal and bulk/session
   cancellation remain separate future operations.
2. HTTP `202` is returned only after a `turn.cancel` command and its outbox
   record commit atomically. It means *cancellation intent is durable*, not that
   Pi has stopped. Reusing the same key and request replays the original
   acceptance; a changed request or another in-flight cancellation conflicts.
3. Cancellation has its own outbox topic and dispatcher, so it can progress
   while the execute dispatcher is blocked awaiting the running turn. The
   cancellation dispatcher may retry only before a supervisor ACK; after the
   durable ACK it never blindly redelivers a side-effectful cancellation.
4. `command.turn.cancel.commandId` identifies the cancellation command and a
   required `targetCommandId` identifies the acknowledged execute command.
   Tenant, project, workspace, session, turn, agent, lease ID, and fencing token
   must match the current assignment exactly.
5. Supervisor cancellation uses the same two-step boundary as execution. A
   side-effect-free `prepareCancellation` validates and ACKs the command. The
   control plane then revalidates the current unexpired lease and atomically
   changes the cancellation command to `acknowledged`, the turn/session to
   `cancelling`, and the outbox record to published. Only after that commit may
   the supervisor signal the runner.
6. That durable transition is the cancellation linearization point. Natural
   completion committed before it wins and the cancellation command fails as
   too late. Once it commits, cancellation wins; the execute dispatcher does
   not settle the same turn and instead observes the cancellation dispatcher's
   terminal settlement.
7. The supervisor first sends Pi's native JSONL `abort` RPC. The API may select
   a bounded grace period; after it expires, the runner escalates to the Pi
   operating-system process group. On POSIX it sends `SIGTERM`, then `SIGKILL`
   when required, and probes the process group until it no longer exists. The
   cancellation operation resolves only after root-process exit and process
   group teardown. Windows can confirm only the spawned process until a Job
   Object execution backend is added.
8. Pi's raw `aborted` value remains private to the sandbox adapter. An expected
   cancellation emits the public terminal `turn.cancelled` event with the
   requested reason and a `forced` flag. The event is durably ACKed using the
   still-acknowledged target execute command and current lease only after
   process teardown; it therefore remains ordered with all earlier turn
   events and is resumable through SSE.
9. After termination and terminal-event ACK are confirmed, the cancellation
   dispatcher atomically completes both durable commands, changes
   `turn: cancelling -> cancelled` and `session: cancelling -> idle`, and
   releases the exact lease and sandbox capacity. `turn.cancelled` is not
   inferred merely from an HTTP request or command ACK.
10. If cancellation fails after its durable ACK and process exit cannot be
    confirmed, the session/turn are failed and the lease reservation is not
    returned to the ready pool by that path. A later sandbox reconciler must
    quarantine or terminate the execution boundary before reclaiming it.
11. The first implementation keeps the same in-process transport used by turn
    execution. A future remote supervisor transport must preserve the prepare,
    durable ACK, terminal event, and termination-confirmation boundaries; it
    must not replace them with a best-effort HTTP callback.

## Consequences

- A browser can safely retry the cancellation request without sending repeated
  aborts or confusing acceptance with completion.
- Cancellation can reach a blocked model call because it has an independent
  durable dispatcher rather than waiting behind that call.
- Lease/fence checks prevent an old supervisor from cancelling a newer session
  assignment.
- Expected user cancellation is observable as a distinct terminal event and
  state, not a generic model failure.
- The per-turn Pi process remains a replaceable execution backend detail; the
  durable command and state semantics do not depend on direct process access
  from the HTTP handler.
- Queued withdrawal, restart recovery for an acknowledged in-flight
  cancellation, lease renewal, remote termination receipts, and Windows Job
  Objects remain explicit later work.

## Rejected alternatives

### Abort directly in the HTTP handler

The in-memory handle may live in another replica or disappear on restart, and
the response could be sent before any durable intent exists.

### Reuse the execute command ID as the cancellation command ID

It destroys command-level idempotency and audit history and makes ACK ownership
ambiguous. Cancellation and its target are two separate durable facts.

### Mark the turn cancelled when the supervisor ACKs

An ACK only transfers responsibility for cancellation. The model request,
tool descendants, or Pi process may still be running.

### Run cancellation through the execute outbox dispatcher

That dispatcher awaits the current execution promise, so a cancellation behind
it cannot reach the operation it needs to interrupt.

### Kill only the Pi root PID

Tool processes can survive their parent. POSIX cancellation targets and checks
the process group; other platforms need an equivalent containment primitive.
