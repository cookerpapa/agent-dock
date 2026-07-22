# Run lifecycle

## Durable acceptance

The public request returns `202` only after PostgreSQL commits the prompt Turn,
execute Command, mailbox position, idempotency fingerprint, immutable Project
environment snapshot, and outbox record.
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

The dispatcher claims work with PostgreSQL locking, creates an immutable-numbered
`RunAttempt`, and obtains:

```text
runId / attemptId / attemptNumber
commandId / turnId
leaseId
fencingToken
lease expiry
Supervisor boot and connection generation
```

`attemptId` is independent from `leaseId`. Lease acquisition binds the exact
current Attempt to sandbox, lease, and fence in PostgreSQL before execution ACK.
A retry before durable acknowledgement terminates the old Attempt and creates a
new one. Once execution is acknowledged, a crash is ambiguous and the Run fails
instead of blindly replaying commands.

## Two-phase start

1. Control Plane sends `command.turn.execute` as a preparation.
2. Supervisor validates capacity/identity and returns a side-effect-free ACK.
3. Control Plane commits `ACKNOWLEDGED/RUNNING` under the current lease/fence.
4. Control Plane sends `command.commit`.
5. Trusted Runner durably advances the Attempt through restore/run/checkpoint
   phases while resolving model and workspace state.
6. `ToolSandboxManager` reserves one logical activation and rotating capability;
   it does not create a Pod.
7. Trusted Runner starts pinned Pi with only the fixed remote-tool extension.
8. The first actual Tool operation makes the Provider create/restore/attest the
   gVisor Pod. Before the first repository command, the worker verifies the
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

One shared Supervisor heartbeat reports all active assignments. PostgreSQL
renews only the exact current lease/fence, current RunAttempt, boot, command
lifecycle, and event cursor. Lease loss revokes execution authority.

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

1. If a Tool was used, Provider snapshots regular workspace files and the
   cumulative Git patch and returns the validated environment evidence.
   Otherwise no Workspace capture/version or physical environment validation is
   created.
2. Trusted Runner captures stable Pi JSONL.
3. Content hashes and bounded manifests are validated.
4. Bytes are conditionally written to object storage.
5. PostgreSQL always stages the new Pi conversation pointer. A Tool-using Run
   additionally stages an immutable Workspace version and append-only
   environment validation bound to the current Run/Attempt, parent version,
   artifact hashes, lease, and fence.
6. The terminal settlement transaction advances the checkpoint and current
   Workspace-version pointers with session-version/Run/Attempt/lease/fence CAS,
   settles the staged version, and records the Attempt revision. A failure
   abandons the staged version and restores the previous settled pointers.
7. `turn.completed` is durably published as the commit marker.
8. Manager revokes the capability. A successful exact-revision coding Session
   may retain the Pod as a bounded warm cache; every failure/cancel/mismatch
   path confirms runtime absence.

If failure occurs before the terminal marker, the next activation restores the
previous settled Pi/workspace pair. Uploaded but uncommitted objects are not
treated as current state.

Rollback never edits a historical version. An idle Session moves its current
pointer to an existing settled version under an expected-current-version CAS;
the next activation restores that version. A fork creates a new cold Session
from an immutable version. Both write tenant-scoped operation audit records.

## Cancellation

Cancellation is its own durable command. After its ACK is committed, the
Supervisor aborts Pi's model request and the active Tool RPC. Bash receives
process-group termination; Provider cleanup then removes and confirms absence of
the entire Tool Sandbox. Only after that proof may `turn.cancelled` settle the
Turn and release capacity.

Natural completion wins if it commits before cancellation's linearization
point. A cleanup failure fails closed and retains/quarantines capacity for
reconciliation.

## Crash and restart behavior

| Failure | Behavior |
| --- | --- |
| Browser disconnect | reconnect with `Last-Event-ID`; replay durable suffix |
| Control Plane replica loss | outbox claim expires; another replica may claim pre-ACK work |
| Supervisor socket loss | same boot reconnects only after local assignments settle |
| Runner loss after ACK | fenced as ambiguous; no arbitrary tool replay |
| Manager/Provider loss | host retirement inventories exact labels and confirms absence |
| Tool Sandbox exit | active operation fails; capability is revoked; runtime is removed |
| Event ACK loss | Supervisor file spool redelivers the identical event/batch; cumulative sequence ACK deduplicates it |
| Checkpoint upload interruption | previous settled revision remains authoritative |
| Old Attempt resumes late | current-attempt/lease/fence checks reject its phase, checkpoint, and terminal writes |

## Terminal invariant

Every terminal path revokes the per-Attempt capability. Failed, cancelled,
timed-out, lease-revoked and shutdown paths additionally prove exact Provider
absence. A successful coding Run may instead transfer the same exact-session
Pod to the bounded warm cache; the next Attempt must present the committed
Workspace revision and a higher fence before use. Orphan cleanup matches
Supervisor, boot, sandbox, command, session, turn, lease, fence, Pod UID and
runtime identity before destruction.
