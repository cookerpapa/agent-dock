# ADR-0080: Frozen cloud steps and recoverable Tool execution

- Status: Accepted
- Date: 2026-08-04
- Refines: ADR-0029, ADR-0031, ADR-0070 and ADR-0079
- Refined by: ADR-0081 and ADR-0082

## Context

An accepted Run already carries an immutable model, environment, budget, lease
and fencing snapshot. Those values were consumed at several call sites rather
than represented as one frozen execution view. A later refactor could therefore
let the model observe one tool/environment policy while a Tool request used
another.

Tool operations also used a single request/response connection. If either the
trusted Worker-to-Manager connection or the Manager-to-Cube connection was
briefly lost after a command started, PiCloud correctly refused to replay the
command, but immediately classified the result as unknown and destroyed the
Cube. This is safe but unnecessarily turns a recoverable transport interruption
into an execution failure.

Finally, terminal delivery and sandbox continuity were correct but implicit:
the Supervisor drained its event publisher before returning, and Pi stored an
untyped hidden sandbox marker. These invariants should be explicit contracts.

## Decision

1. Every accepted execution freezes one immutable credential-free view of its
   identity, model, environment, budgets, Workspace base revision and
   Tool/network policy. A canonical SHA-256 digest binds the Sandbox reservation
   and every Tool operation to that exact accepted view. ADR-0081 adds a
   per-provider-request `CloudStepContext`; ADR-0082 separates the original
   execution view into stable logical Turn and rotating Attempt contracts. The
   contexts contain references and hashes, never model or platform credentials.
2. A Tool `operationId` names one execution, not one HTTP request. The Sandbox
   Manager and Cube Tool service retain a bounded operation ledger. Reattaching
   with the same operation ID and identical request returns the existing running
   promise or retained result; a different request with the same ID is rejected.
3. A disconnected HTTP response does not cancel the operation. Explicit Run
   cancellation, lease revocation and Sandbox stop remain the cancellation
   authority. The trusted client retries only by reattaching to the same
   operation ID; it never starts a second arbitrary shell command.
4. Bash output is represented as one monotonically sequenced stream of stdout
   and stderr chunks. A digest covers the reconstructed bytes. Reattachment
   returns the same ordered result.
5. Reattachment is deliberately short-lived and process-local. If the Cube Tool
   service, Cube VM or Sandbox Manager loses the operation ledger, the result is
   `UNKNOWN`; the VM is destroyed and the command is not replayed.
6. A Supervisor may resolve a Run only after its durable event publisher has
   drained and the event spool reports `acknowledgedThroughSeq ==
   highestProducedSeq`. The Control Plane remains the sole writer of the public
   terminal event and commits that event with the Run and checkpoint heads in
   one PostgreSQL transaction.
7. Pi stores a versioned, typed `pi-cloud.runtime_world_state` custom entry.
   Its initial world model tracks Sandbox availability, continuity identity,
   environment fingerprint, Workspace revision and Tool policy fingerprint.
   The entry is hidden from the model. Only a material loss of an active process
   environment renders the existing minimal `<sandbox_reset>` message.
8. A public Tool projection distinguishes `unknown` from `failed`. Failed or
   cancelled terminal Runs also mark any still-running Tool as unknown. The UI
   does not offer automatic retry for that state.

## Consequences

- A short control-plane disconnect can recover the original Tool result without
  duplicating side effects.
- A process or VM crash still cannot be presented as recovered execution state;
  Workspace checkpoints and model-visible interruption semantics remain the
  durable recovery boundary.
- The frozen step digest makes policy drift fail closed at Tool admission.
- Ordered output is auditable even though the product UI may continue to show
  only the final bounded output.
- Operation results occupy bounded memory until their retention deadline or
  activation teardown.

## Rejected alternatives

### Retry Bash with a new operation ID

This can duplicate arbitrary side effects and conflicts with the existing
at-most-once-start Tool contract.

### Keep the HTTP connection as execution ownership

Transport liveness is not execution liveness. A transient proxy or Worker
connection failure must not itself kill a healthy command.

### Persist process memory as durable execution

Cube Workspace checkpoints preserve committed files, not arbitrary process
memory, sockets or external side effects. Claiming otherwise would weaken the
failure model.

### Put the whole step snapshot into model context

Internal IDs, policy hashes and orchestration data do not help model reasoning.
Only a minimal semantic change such as loss of the prior process environment is
model-visible.
