# Run lifecycle

## Admission

`POST /sessions/{id}/messages` authenticates tenant ownership and writes the
user message, Turn, Run, command and Run-queue Outbox row in one PostgreSQL
transaction. The idempotency key prevents a retry from creating another Run.
Same-Session mutating Runs remain serialized and tenant quota is checked while
holding the relevant database lock.

## Claim and execution

All Pi Workers scan the same ready Outbox. PostgreSQL sends a notification to
reduce idle latency, but a one-second poll is the recovery path. Candidate rows
are ordered by tenant scheduling time, availability and creation time.

`RunCommandExecutor` transactionally rechecks:

- the command and Run are still eligible;
- this is the Session's next runnable message;
- tenant and Workspace concurrency allow execution;
- cancellation has not won;
- no current Attempt already owns the Run.

It creates a RunAttempt with a bounded claim lease. The Worker heartbeats that
claim and obtains an opaque execution authority containing the current Attempt
and fence. The raw authority is not placed in model context or Cube.

## Pi and Tools

The Worker opens Pi's native Session state and appends the accepted user
message. Pi may perform multiple model sampling steps. Pure chat never contacts
Cube.

For a Tool call, the Worker sends the Tool Broker a server-generated capability
bound to tenant, Workspace, Session, Run, Attempt, fence and Step. The Broker
checks current authority, lazily creates/rebinds Cube, attaches the stable
Workspace Volume and executes exactly one admitted operation.

A Tool transport retry may reattach to the same operation identity. It must not
start a second arbitrary shell operation. If start/result cannot be proven, the
result is `UNKNOWN`.

## Events and terminal commit

Pi text fragments are coalesced for 100 ms or 4 KiB, then independent Sessions
share one bounded Host Kafka append. Raw events are Session-keyed; a projector
rechecks Attempt/Lease/Fence and publishes only valid records to Accepted
Kafka. Tool arguments and Tool results enter this stream only as complete
Items. Accepted broker acknowledgement is the visibility boundary.

Pi `message_end` publishes a complete Session mutation. The PostgreSQL
projector applies it idempotently and the Worker waits at a read-your-writes
barrier before the next model Step. On successful settlement, the Worker
prepares the bounded Workspace Volume revision. The terminal transaction
validates the current Attempt/fence, advances the Workspace revision if
applicable, writes a terminal Kafka Outbox record and settles the Run. Kafka
time/byte retention eventually removes hot fragments while canonical Pi
messages remain in PostgreSQL.

## Cancellation and failure

Cancellation revokes authority before trying to interrupt model/Tool work.
Expired or superseded Workers cannot mutate Pi SessionStorage, execute another
Tool or commit terminal state. A caught interruption writes Pi's minimal
abort/reset boundary. A hard Worker loss is reconciled from the Accepted Kafka
prefix plus a factual interruption marker; no Tool result is invented. A
normal failure/cancellation also fetches that trusted prefix from the Control
Plane instead of trusting a possibly-behind Worker-local buffer.

Cube loss discards processes, memory, sockets and PTYs. The persistent Workspace
Volume survives and can attach to a fresh KVM. The next Pi step is told only
when the execution world materially changed.

If a Worker dies during lazy Cube creation, Tool Broker also reconciles the
Activation against the authoritative Run/Attempt. A late-created runtime for a
terminal or superseded Attempt is destroyed and cannot retain scarce admission
capacity.

## Delivery semantics

```text
Run queue              at-least-once wakeup + transactional claim
Pi Session mutation    Kafka + idempotent fenced PostgreSQL projection
Tool start              no blind retry; UNKNOWN if ambiguous
Workspace revision      fence + expected revision
terminal Run commit     idempotent current-Attempt transaction
Cube create/delete      idempotent reconcile
live event batch        Raw/Accepted Kafka + sequence/event-id dedupe
```
