# ADR-0009: Durable Turn cancellation and execution-stop confirmation

- Status: accepted, amended for the PostgreSQL Worker pool and Pi SDK
- Date: 2026-07-19

## Context

Cancellation intent, Worker receipt, Pi abort and absence of a Tool process are
different facts. An HTTP response must not claim a Run is cancelled while a
model request or Cube command may still be consuming resources or mutating the
Workspace.

## Decision

1. The public cancellation endpoint requires an idempotency key. HTTP `202`
   means intent is durable, not that execution has stopped.
2. A cancellation targets the exact execute command, RunAttempt, lease and
   fence. PostgreSQL durably changes the command intent; the Worker observes
   cancellation while renewing the same authority. A stale or already-settled
   target is rejected.
3. The Worker aborts the Pi SDK model loop and cancels the active Tool RPC. The
   Tool boundary terminates the process group; if absence cannot be proven, the
   exact Cube activation is destroyed.
4. Cancellation first revokes old Tool authority. A late Worker or Tool result
   with the old fence cannot checkpoint, complete the Run or publish canonical
   events.
5. Natural completion committed before cancellation wins. Once the durable
   cancellation transition wins, normal completion cannot overwrite it.
6. `turn.cancelled` becomes canonical only after the terminal event and
   execution-stop/checkpoint policy commit atomically under the current fence.
7. Ambiguous termination fails closed for reconciliation rather than returning
   the Workspace to service optimistically.

## Consequences

- Browser retries do not send duplicate cancellation intent.
- Cancellation can interrupt a blocked model or Tool execution without adding
  another scheduler.
- Lease/fence checks prevent an old Worker from cancelling or settling newer
  work.
- Process absence remains an execution-plane fact, not an HTTP inference.
