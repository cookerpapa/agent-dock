# Run lifecycle

## Durable acceptance

The public request returns `202` only after PostgreSQL commits the prompt Turn,
execute Command, mailbox position, idempotency fingerprint, immutable Project
environment snapshot, immutable Workspace source-set snapshot, and outbox
record. The source-set snapshot is the only repository input used by the
Runner; later Project metadata cannot redirect an accepted Run to another
repository or commit.
An HTTP retry with the same key and body returns the same Turn. The same key with
a different body is rejected.

```text
Run: queued -> claimed -> provisioning -> restoring? -> running
     -> checkpointing -> completed
                      \-> cancel_requested -> cancelled
     \-> queued (a failed pre-ACK Attempt only)

Attempt terminal alternatives: failed | timed_out | superseded
```

AgentDock does not claim exactly-once execution for shell commands or external
side effects.

## Attempt identity and claim

The Control Plane's outbox relay starts one deterministic Temporal Workflow per
accepted Run. Temporal assigns its Activity to one capacity-bounded Pi Worker;
the Activity then claims only the named PostgreSQL command, creates an
immutable-numbered `RunAttempt`, and obtains:

```text
runId / attemptId / attemptNumber
commandId / turnId
leaseId
fencingToken
lease expiry
Supervisor boot and Temporal Worker identity
```

`attemptId` is independent from `leaseId`. Lease acquisition binds the exact
current Attempt to sandbox, lease, and fence in PostgreSQL before execution ACK.
A retry before durable acknowledgement terminates the old Attempt and creates a
new one. Once execution is acknowledged, a crash is ambiguous and the Run fails
instead of blindly replaying commands.

## Durable Workflow start

1. The relay starts `agent-dock-run-v1-{runId}` with only tenant, Session, Run
   and command UUIDs. `USE_EXISTING` makes outbox redelivery idempotent.
2. Temporal matches `executeRunCommand` to the common
   `agent-dock-pi-runs-v1` Task Queue.
3. The Activity's exact PostgreSQL claim rechecks Session FIFO, tenant
   concurrency, Run state and command identity. Ineligible work returns
   `deferred`; the Workflow waits on a durable timer.
4. The selected Supervisor acquires the lease/fence and commits
   `ACKNOWLEDGED/RUNNING` before starting Pi.
5. Trusted Runner durably advances the Attempt through restore/run/checkpoint
   phases while resolving model and workspace state.
6. `ToolSandboxManager` reserves one logical activation and rotating capability;
   it does not create a microVM.
7. Trusted Runner creates a pinned embedded Pi SDK session with only the fixed
   remote-tool implementation.
8. The first actual Tool operation makes the Provider create/restore/attest the
   Cube KVM microVM. Before the first repository command, the worker verifies the
   accepted image revision and expected Node.js/Java/Python/Git toolchain, then
   executes the accepted environment version's bounded setup and verification
   recipe. A chat-only Run skips this step entirely.

Cold or queued sessions own no Pi process, Tool Sandbox, socket, thread, or
per-session timer.

## Environment candidate lifecycle

Environment mutation never edits an active version in place:

```text
owner creates recipe -> pending/inactive
pending -> fresh gVisor validation Run -> validated/inactive
validated + expected-active CAS -> active
failed -> inert history (create a new candidate)
older validated + expected-active CAS -> rollback target becomes active
```

Every create, validation request, activation and rollback appends an actor-bound
operation. The validation Run snapshots the candidate rather than the active
version, so Manager policy, physical image evidence, automatic recipe commands,
Pi Tool routing and Workspace checkpointing are tested together. An environment
identity mismatch or recipe failure is terminal and cannot be hidden by silently
falling back to the active version.

## Active execution

Pi's Agent Loop and conversation state remain trusted. `read/write/edit/bash`
cross Tool RPC. The Manager validates the activation capability and unique
operation ID before the Provider sends a closed worker request. Tool output is
bounded before returning to Pi. If a read/bash result crosses the context
allowance, its full Provider-bounded bytes are persisted as a fenced Tool
Artifact before the `tool.completed` event exposes the Artifact ID.

Before every provider call, the trusted Model Gateway locks the tenant policy,
verifies the current RunAttempt and reserves request/token/cost capacity across
the Run plus tenant day/month windows. Budget denial happens before provider
egress. A selected fallback reuses that reservation; completion snapshots the
actual provider/model/rates/tokens/cost. The Pi process is also bounded by the
Turn's wall-clock and remaining Tool-call snapshot.

Temporal Activity heartbeats prove that the Worker is still polling and allow
timely cancellation delivery. A separate shared Supervisor heartbeat renews
only the exact current PostgreSQL lease/fence, current RunAttempt, boot,
command lifecycle and event cursor. Losing either authority aborts execution;
Temporal retry still cannot bypass the newer PostgreSQL fence.

Pi's first text delta is emitted immediately. Later adjacent text deltas for the
same content block are coalesced for at most 50 ms or 2 KiB. Every public event
is fsynced to the bounded local spool before an asynchronous publisher sends up
to 64 contiguous events in one envelope. The Control Plane commits a batch in
one PostgreSQL transaction and returns one cumulative ACK. Pi therefore does
not wait for a database transaction after every provider token, while terminal
Run completion still waits for the durable ACK cursor to reach its final
sequence.

## Checkpoint commit

At `agent_settled`:

1. If a Tool was used, the Cube Provider closes the current Tool Worker,
   briefly freezes the remaining UID 1000 processes, flushes the
   Volume-Plugin-backed POSIX Workspace, and captures a content-hashed file
   index plus cumulative Git patch. The trusted Data Mover creates an immutable
   encrypted Kopia snapshot and returns only a bounded
   Session/volume/environment/fence-bound reference. The guest supervisor then
   resumes the exact PID/start-time identities. Cube-native references are not
   accepted. Otherwise no Workspace capture/version or physical environment
   validation is created.
2. Trusted Runner captures stable Pi JSONL.
3. Content hashes and bounded manifests are validated.
4. Pi bytes and the bounded Workspace reference are conditionally written to
   the checkpoint bucket. Workspace file bytes are already in Kopia's
   content-addressed object repository under a separate least-privilege
   credential.
5. PostgreSQL always stages the new Pi conversation pointer. A Tool-using Run
   additionally stages an immutable Workspace version and append-only
   environment validation bound to the current Run/Attempt, parent version,
   artifact hashes, lease, and fence.
6. The terminal settlement transaction advances the checkpoint and current
   Workspace-version pointers with session-version/Run/Attempt/lease/fence CAS,
   settles the staged version, and records the Attempt revision. A failure
   abandons the staged version and restores the previous settled pointers.
7. `turn.completed` is durably published as the commit marker.
8. Manager revokes the Run capability. A successful exact-Session warm release
   retains the running guest for the bounded idle TTL, but no Tool Worker or
   prior Run authority remains. A later Run must present a higher fence and
   rotates the handoff secret before a fresh Tool Worker starts. Failure,
   cancellation, timeout, identity mismatch or ambiguous checkpoint/rebind
   destroys the activation. Every terminal path confirms either an idle
   Session-bound runtime or runtime absence.

If failure occurs before the terminal marker, the next activation restores the
previous settled Pi/workspace pair. Uploaded but uncommitted objects are not
treated as current state.

The successful terminal transaction also creates one immutable Review Bundle
for the current Attempt. Its canonical manifest links the final assistant text,
Workspace/patch identities, changed paths, tests, bounded Artifact metadata,
environment/source snapshots, Attempt history and usage. The database rejects
update/delete and every read verifies the stored SHA-256. Object-store keys and
active HTML are not part of the public manifest.

Rollback never edits a historical version. An idle Session moves its current
pointer to an existing settled version under an expected-current-version CAS;
the next activation restores that version. A fork creates a new cold Session
from an immutable version. Both write tenant-scoped operation audit records.

## Attempt-aware rewind

An explicit rewind is not an automatic shell retry. It is allowed only for the
latest terminal Run and exact current Attempt while the Session is idle. The
source Run recorded its conversation sequence, Workspace version and Pi
snapshot before execution. One actor-bound transaction restores those bases and
appends a replacement Turn/Command/Run with the same immutable prompt, model,
environment and repository set.

The source events and Attempts remain durable but project as `superseded`; the
replacement Run projects as `canonical` with a link to the rewind boundary.
Browser reconnect reconstructs that projection from PostgreSQL. A Sandbox warm
cache whose committed Workspace revision differs from the restored base cannot
be reused. Older non-latest work must use the separate Workspace fork operation
rather than pretending process state can be rewound.

## Cancellation

Cancellation is its own durable command. The outbox relay requests cancellation
of the exact Temporal Workflow. Temporal delivers Activity cancellation to the
Worker that owns the live Pi SDK session; that Worker invokes the exact local
cancellation dispatcher, aborts Pi's model request and the active Tool RPC.
Bash receives process-group termination; Provider cleanup then removes and
confirms absence of the entire Tool Sandbox. Only after that proof may
`turn.cancelled` settle the Turn and release capacity.

Natural completion wins if it commits before cancellation's linearization
point. A cleanup failure fails closed and retains/quarantines capacity for
reconciliation.

## Crash and restart behavior

| Failure | Behavior |
| --- | --- |
| Browser disconnect | reconnect with `Last-Event-ID`; replay durable suffix |
| Control Plane replica loss | another relay adopts the deterministic existing Workflow ID |
| Temporal service loss | accepted Runs remain in PostgreSQL; persisted Workflow history resumes after service recovery |
| Supervisor management socket loss | same boot reconnects for liveness; it is not the Run-matching channel |
| Pi Worker loss before durable start | Temporal schedules an infrastructure retry and PostgreSQL creates only an eligible fenced Attempt |
| Runner loss after ACK | fenced as ambiguous; no arbitrary tool replay |
| Manager/Provider loss | host retirement inventories exact labels and confirms absence |
| Source Cube VM or local POSIX copy destroyed after checkpoint | Data Mover restores the committed Kopia snapshot, then the next higher-fence Attempt creates a fresh base-template VM |
| Cube execution node/disk loss | recover on a node that mounts the shared POSIX path; the Kopia repository, not the node copy, is authoritative |
| Kopia repository/object-store loss | fail closed on the previous Workspace head; recover the coordinated MinIO/Kopia backup before admitting work |
| Tool Sandbox exit | active operation fails; capability is revoked; runtime is removed |
| Event ACK loss | Supervisor file spool redelivers the identical event/batch; cumulative sequence ACK deduplicates it |
| Checkpoint upload interruption | previous settled revision remains authoritative |
| Old Attempt resumes late | current-attempt/lease/fence checks reject its phase, checkpoint, and terminal writes |

## Terminal invariant

Every terminal path revokes the per-Attempt capability and proves exact
Provider absence. Orphan cleanup matches Supervisor, boot, sandbox, command,
session, turn, lease, fence and Cube runtime identity before destruction.
Temporal completion is not the application commit marker: the fenced
PostgreSQL terminal state, committed checkpoint head and durable terminal event
remain authoritative.
