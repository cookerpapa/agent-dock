# ADR-0022: Remote control-plane worker lifecycle

Implementation update: the historical `DockerSandboxTurnRunner` named below
was removed by ADR-0038. The supported worker now composes
`RemoteToolSandboxTurnRunner` through the gVisor-only Sandbox Manager.

- Status: accepted
- Date: 2026-07-19

## Context

AgentDock already has independently executable pieces for durable HTTP intake,
transactional execute/cancel outboxes, authenticated Supervisor WebSockets,
two-phase remote commands, connection generations, lease/fence authority,
cross-replica claim affinity, event persistence, and retirement reconciliation.
The network tests manually construct a dispatcher after a Supervisor registers.
Production `main.ts` still starts only REST/SSE, so an accepted command remains
queued unless some external integration code repeatedly calls
`dispatchNext()`.

A naive composition can break properties that the individual pieces already
prove. One global execute loop underuses multiple sandboxes; one combined loop
cannot deliver cancellation while an execute call is waiting for a model; a
timer that starts another callback before the previous one finishes creates
unbounded overlapping claims. Conversely, one thread/process/timer per stored
session would violate the cold-session density invariant.

The composition root also has a circular dependency: the WebSocket command
router must persist events through the exact `DurableEventStore` used by REST,
SSE, and PostgreSQL notification, while the WebSocket gateway must be installed
before Fastify begins listening. Creating a second event store or hub would
split live delivery from durable authority.

Settled checkpoint bytes do not belong in this control-plane process. The
private checkpoint publish/ACK exchange terminates at the trusted Supervisor
host running `DockerSandboxTurnRunner`; that host composes
`PostgresSandboxCheckpointStore` with the S3 adapter. Passing S3 credentials or
checkpoint bytes through the command router would violate ADR-0011 and
ADR-0021.

## Decision

1. Add an explicit `RemoteControlPlaneRuntime` composition root. It constructs
   one shared `SessionEventHub` and `DurableEventStore`, injects that pair into
   the Nest module, and gives the same event store to
   `SupervisorCommandRouter`. REST, remote event ACK, SSE replay, local wakeup,
   and PostgreSQL notification therefore share one durable authority.
2. Add a `RemoteSupervisorWorkerRuntime` with one binding-discovery loop and
   one maintenance loop per control-plane process. A binding is an active,
   registered Supervisor connection owned by this replica and contains its
   sandbox, connection generation, provisioned capacity, guarded lease
   coordinator, backend, and PostgreSQL dispatch affinity.
3. For each active binding, start bounded asynchronous lanes based on
   `min(provisioned capacity, configured lane cap)`. Every slot has one
   sequential execute lane and one independent sequential cancellation lane.
   These are promises, not OS threads or child processes, and their count scales
   with live Supervisor capacity—not stored sessions.
4. Each lane awaits one `dispatchNext()` before polling again. `idle` waits use
   an abortable bounded delay; successful/non-idle work may immediately look
   for the next claim; unexpected database/dependency failure waits a longer
   bounded delay. No `setInterval` callback can overlap itself.
5. Binding discovery is process-local and periodic. A disconnect removes and
   drains its lanes; a new connection generation creates fresh lanes. Database
   affinity and the guarded lease coordinator remain the claim authority, so a
   stale snapshot cannot execute work merely because it existed in memory.
   No Redis/Kafka command broker or in-memory command queue is introduced.
6. Supervisor connection expiry and retirement run in a separate sequential
   maintenance loop. A long model/tool call cannot prevent heartbeat-expiry
   scanning or retirement claims. Owner-stop proof remains mandatory before
   assignment reconciliation; the runtime never substitutes socket close for
   process absence.
7. Runtime observations contain only component/status, connection/sandbox IDs,
   counts, and a closed safe error code/retryable flag. Raw exceptions, prompt,
   model output, tool arguments, bearer tokens, database URLs, object keys, and
   credentials are not logged by the worker.
8. Startup order is: construct shared dependencies, initialize Nest and the
   notification listener, bind Fastify, then start worker loops. Shutdown order
   is: stop new claims, make the gateway reject new upgrades and detach all
   command transports, await in-flight lanes to settle through existing
   ambiguous-failure rules, then close Nest/listeners. Shutdown is idempotent.
9. The composition root requires an injected `SupervisorUpgradeAuthorizer`,
   `SupervisorOwnerBoundary`, and assignment-inventory factory. The CLI does not
   invent a no-op owner or silently enable the single-token development
   authorizer. Concrete provisioner/mTLS and Docker/Kubernetes owner adapters
   remain a separate security-boundary slice.
10. This lifecycle improves availability and makes accepted work run
    automatically. It does not resume an ambiguous committed tool call and does
    not claim exactly-once execution of external effects.

## Failure boundaries

| Failure | Required outcome |
| --- | --- |
| binding discovery/database fails | existing lanes remain bounded; discovery retries after the failure delay |
| one execute lane waits on a model | cancellation and maintenance lanes continue independently |
| connection closes before command ACK | router rejects the exchange; dispatcher applies its pre-ACK retry policy |
| connection closes after durable start | router marks the result ambiguous; dispatcher fails/quarantines according to existing rules |
| connection generation changes | old lanes stop; new guarded binding owns future claims |
| maintenance cycle fails | safe failure is observed; dispatch lanes continue; maintenance retries later |
| observer callback throws | runtime ignores the observer failure; correctness loops continue |
| process receives shutdown | no new claims; sockets detach; active exchanges settle/fail before database/application close |
| owner absence cannot be proven | retirement is retried or blocked; capacity is never returned optimistically |

## Consequences

- A deployed composition can accept and automatically execute remote work
  without integration code manually calling each dispatcher.
- Idle cost is bounded by live Supervisor capacity. A million cold sessions
  still create zero worker lanes, Pi processes, or sandboxes.
- Execute/cancel concurrency is explicit and testable. Provisioned capacity
  above the configured cap is safe but temporarily underused.
- Polling adds bounded database traffic. Measurements may later justify
  notification-driven discovery, but correctness does not depend on wakeups.
- The trusted Supervisor executable and concrete provisioner/owner security
  adapters are still required before calling the CLI topology production-ready.

## Rejected alternatives

### Start one dispatcher loop per session

It makes cold-session cost grow with durable history and recreates the exact
process/thread-per-conversation model AgentDock is designed to avoid.

### Run execute and cancel in one loop

`dispatchNext()` covers the complete remote execution duration. A cancellation
behind that await cannot stop the active model/tool call.

### Use overlapping interval callbacks

Slow database or network operations accumulate callbacks and make concurrency
an accidental function of latency. Sequential async lanes keep the bound
explicit.

### Let every replica claim every Supervisor

It sends commands through the wrong socket owner. The existing durable
control-plane-instance/sandbox affinity is retained instead of adding a broker.

### Construct a second event store for WebSocket events

It can persist correctly while failing to wake the SSE hub used by the Nest
application. One injected event runtime removes that split-brain boundary.

### Put S3 checkpoint handling in the command router

It would expose private snapshot bytes and storage credentials to the wrong
process and duplicate the fenced checkpoint protocol. S3 composition stays on
the trusted Supervisor host.

### Enable a no-op owner boundary in `main.ts`

Socket loss does not prove a Supervisor boot or its child runtimes are gone.
Optimistically releasing leases/capacity would permit overlapping writers.
