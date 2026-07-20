# Run lifecycle

## Durable acceptance

The public request returns `202` only after PostgreSQL commits the prompt Turn,
execute Command, mailbox position, idempotency fingerprint, and outbox record.
An HTTP retry with the same key and body returns the same Turn. The same key with
a different body is rejected.

```text
queued -> dispatching -> running -> checkpointing -> completed
                   |          |                  -> failed
                   |          -> cancelling -> cancelled
                   -> queued (pre-ACK only)
```

AgentDock does not claim exactly-once execution for shell commands or external
side effects.

## Attempt identity and claim

The dispatcher claims work with PostgreSQL locking, then obtains:

```text
commandId
leaseId / attemptId
fencingToken
lease expiry
Supervisor boot and connection generation
```

Today the lease UUID is also the Provider attempt UUID. A retry before durable
execution acknowledgement receives a new lease/fence. Once execution is
acknowledged, a crash is ambiguous and the Turn fails instead of blindly
replaying commands.

## Two-phase start

1. Control Plane sends `command.turn.execute` as a preparation.
2. Supervisor validates capacity/identity and returns a side-effect-free ACK.
3. Control Plane commits `ACKNOWLEDGED/RUNNING` under the current lease/fence.
4. Control Plane sends `command.commit`.
5. Trusted Runner resolves model and workspace state.
6. `ToolSandboxManager` creates one Provider handle and capability.
7. Provider waits for Tool worker readiness and inspected runtime identity.
8. Trusted Runner starts pinned Pi with only the fixed remote-tool extension.

Cold or queued sessions own no Pi process, Tool Sandbox, socket, thread, or
per-session timer.

## Active execution

Pi's Agent Loop and conversation state remain trusted. `read/write/edit/bash`
cross Tool RPC. The Manager validates the activation capability and unique
operation ID before the Provider sends a closed worker request. Tool output is
bounded before returning to Pi.

One shared Supervisor heartbeat reports all active assignments. PostgreSQL
renews only the exact current lease/fence, boot, command lifecycle, and event
cursor. Lease loss revokes execution authority.

## Checkpoint commit

At `agent_settled`:

1. Provider snapshots regular workspace files and the cumulative Git patch.
2. Trusted Runner captures stable Pi JSONL.
3. Content hashes and bounded manifests are validated.
4. Bytes are conditionally written to object storage.
5. PostgreSQL advances the workspace revision with lease/fence CAS.
6. `turn.completed` is durably published as the commit marker.
7. Manager revokes the capability and Provider confirms runtime absence.

If failure occurs before the terminal marker, the next activation restores the
previous settled Pi/workspace pair. Uploaded but uncommitted objects are not
treated as current state.

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
| Event ACK loss | Supervisor file spool redelivers the identical event |
| Checkpoint upload interruption | previous settled revision remains authoritative |

## Terminal invariant

Every `completed`, `failed`, `cancelled`, `timed_out`, lease-revoked, or shutdown
path ends in capability revocation plus exact Provider absence. Orphan cleanup
matches Supervisor, boot, sandbox, command, session, turn, lease, fence, and
runtime identity before destruction.
