# ADR-0057: Capacity-one Pi Workers and global Tool Sandbox admission

- Status: accepted
- Date: 2026-07-25

## Context

The Temporal cutover makes trusted Pi Workers horizontally replaceable. A load
test also showed that eight capacity-one Workers can poll the common Task Queue
on the current 16 GiB development host. Increasing the Worker process count is
not equivalent to increasing safe Tool execution capacity, however:

- every embedded Pi SDK Worker is one JavaScript process and one failure domain;
- a poisoned SDK activation retires its owning process so that a clean Worker
  can restore the last committed checkpoint;
- a CubeSandbox Tool guest is provisioned with up to 2 vCPU and 2 GiB memory,
  so unconstrained simultaneous materialization can exhaust the host much
  faster than idle Pi Workers;
- pure-chat Runs never need a Tool guest and should not wait behind coding Runs.

Packing multiple tenant activations into one Pi SDK process would reduce idle
memory, but it would also let one process-level crash, out-of-memory failure or
failed SDK disposal terminate unrelated active Runs. The embedded runtime
therefore already rejects a configured capacity other than one.

## Decision

1. Production keeps one active Pi SDK `AgentSession` per trusted Worker
   process. Pi concurrency is increased by adding independent Worker replicas,
   not by placing multiple live tenants in one JavaScript heap.
2. Worker horizontal scaling does not require Kubernetes. Every replica is a
   stateless Temporal Activity poller with an independent identity, boot
   ledger, spool and checkpoint cache; PostgreSQL and MinIO hold the durable
   product state. The current supported single-host deployment runs Workers as
   Docker Compose services.
3. A future Kubernetes deployment may run the same trusted Worker image as a
   capacity-one Deployment and autoscale it from Temporal Task Queue pressure.
   Those Pods belong to the trusted application plane, not the CubeSandbox
   execution plane, and must retain model/database/object-store access while
   receiving no host runtime socket.
4. The singleton production `ToolSandboxManager` enforces a deployment-global,
   bounded FIFO admission limit before a logical Tool activation may
   materialize a CubeSandbox guest. The default production limit is two:

   ```text
   AGENT_DOCK_MAXIMUM_ACTIVE_TOOL_SANDBOXES=2
   ```

5. Logical Sandbox reservation remains cheap and does not consume admission.
   Pure-chat Runs therefore use any available Pi Worker without taking a Cube
   slot. Admission is acquired only on the first real Tool operation.
6. An admitted guest retains its permit for its complete physical lifecycle,
   including a supported warm state. Stop, destroy, expiry, failed
   materialization and successful orphan cleanup release the permit and wake
   the oldest live waiter.
7. Cancellation removes a queued waiter. A grant is followed by an ownership
   and abort recheck before provider creation so cancellation cannot race into
   a new guest.
8. Provider stop/cleanup failure is fail-closed: admission is not released
   until physical absence is confirmed. This can temporarily reduce capacity,
   but cannot oversubscribe the host on an unverified assumption.
9. The Manager exports current admitted, waiting and limit gauges. Operators
   scale Pi Workers and Cube admission independently:

   ```text
   agent_dock_sandbox_admission_active
   agent_dock_sandbox_admission_waiting
   agent_dock_sandbox_admission_limit
   ```

10. The in-memory admission queue is global only because the supported
    production profile has exactly one Sandbox Manager. A future
    multi-Manager deployment must move permits to a fenced distributed
    authority before it may claim a deployment-global limit.

## Consequences

- Eight Pi Workers can serve chat/model work while no more than two heavy Tool
  guests are live on the current host.
- Coding Runs above the Tool limit wait inside the authenticated Manager
  without creating partial Cube resources.
- Capacity-one Workers consume more baseline memory than packing multiple
  activations into a process, but preserve tenant failure isolation and simple
  replacement semantics.
- Kubernetes is an optional replica/lifecycle manager for trusted Workers; it
  is not the mechanism that makes checkpoint-restored horizontal scaling
  correct.
- A single Manager restart loses only the in-memory wait order. RunAttempt
  cancellation/retry and Cube reconciliation remain authoritative; durable
  admission ordering is required before a multi-node Manager profile.

## Required evidence

- unit tests prove FIFO wait, bounded create count, cancellation removal and no
  permit leak;
- production metrics prove admitted guests never exceed the configured limit;
- real-token concurrent coding Runs prove queued Runs proceed after earlier
  guests are removed;
- pure-chat Runs prove zero Tool admission;
- the full repository quality gate remains green.
