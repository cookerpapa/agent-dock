# ADR-0011: Settled checkpoint commit and cold restore

- Status: Accepted
- Date: 2026-07-19

## Context

The Phase 1 Docker activation deliberately starts with a fresh image fixture and
starts Pi with `--no-session`. This proves isolation and event delivery, but a
second turn with the same AgentDock session ID would lose both the Pi message
tree and the modified workspace. Keeping one container or Pi process alive per
stored session would preserve that state only by coupling durable identity to
idle compute.

ADR-0003 makes object storage authoritative for settled Pi and workspace
snapshots, and ADR-0005 defines semantic rehydration as the baseline recovery
tier. The missing detail is the commit boundary. Pi currently publishes
`turn.completed` before its caller regains control. Uploading a snapshot only
after that event is durably acknowledged creates a contradictory failure mode:
the transcript can say completed while the dispatcher later marks the turn
failed because no recoverable checkpoint exists.

The checkpoint transport also crosses the sandbox boundary. A restored
workspace can contain attacker-controlled paths and bytes, while a stale
supervisor must not replace a newer session snapshot after losing its lease.

## Decision

1. A checkpoint is created only at a settled successful turn boundary. Failed
   and cancelled turns do not advance the last settled checkpoint.
2. Successful completion uses this order:
   `Pi settles -> worker captures checkpoint -> trusted host validates and
   durably stores checkpoint -> worker receives checkpoint ACK -> worker
   publishes turn.completed -> control plane durably ACKs the terminal event`.
   Therefore a checkpoint-store failure produces no public completed event.
3. The Docker worker protocol gains a private checkpoint publish/ACK exchange.
   Snapshot bytes never enter public AgentDock events, SSE, Docker arguments,
   container environment, or logs. The exchange is closed, size bounded,
   content hashed, and tied to command/session/turn/lease/fence identity.
4. The trusted host loads the latest checkpoint before starting an activation.
   The worker receives an opaque pair of bounded blobs over stdin, restores
   them inside the disposable filesystem, and starts Pi with an explicit
   session JSONL path. No host bind mount is introduced.
5. Pi JSONL remains Pi's conversation authority. The runner may persist an
   explicit session file inside its temporary runtime only when settled
   checkpointing is enabled. The file is read after Pi's settled event and is
   removed with the rest of the activation after its checkpoint is committed.
6. The initial workspace snapshot format is a canonical manifest of regular
   files, relative POSIX paths, executable bits, content lengths, hashes, and
   base64 content. Symlinks, special files, duplicate/non-canonical paths,
   `.git` paths, invalid UTF-8 metadata, oversized files, too many files, and
   hash/length mismatches are rejected. Restore starts from the trusted fixture
   Git baseline, replaces its non-`.git` working tree with the manifest, and
   leaves the baseline commit intact so the final diff remains cumulative.
7. A checkpoint store is a replaceable trusted-host interface. Its load returns
   an opaque revision plus bytes; save performs compare-and-swap against that
   revision. The control-plane implementation writes objects first, then in one
   PostgreSQL transaction verifies the current unexpired lease/fence, inserts
   artifact metadata, and stages both session snapshot pointers. The durable
   `turn.completed` event is the commit marker: cold load accepts the pointed
   pair only when it belongs to the latest completed event, otherwise it falls
   back to the most recent artifact pair that does. Thus a worker crash between
   checkpoint ACK and terminal publication cannot make a failed turn the
   recovery authority. An object written before a failed transaction is
   unreferenced and may be deleted or collected later; it never becomes
   authoritative merely by existing.
8. The development object-store adapter uses a private host directory with
   atomic file publication and hash verification. It exercises the same
   checkpoint-store contract but is not claimed to survive host loss. MinIO/S3
   is a later adapter, not a different recovery model.
9. The current slice is intentionally bounded: at most 2 MiB of Pi JSONL, 2 MiB
   of workspace manifest, 512 regular files, 512 KiB per file, and 512 UTF-8
   bytes per relative path. Larger repositories require an archive/object
   streaming format rather than raising JSONL transport limits without
   measurement.
10. Cold restore is semantic, not process-memory recovery. Open file handles,
    child processes, shell state, network connections, and a tool call that was
    in flight are not restored. Recovery returns to the most recent successful
    turn.

## Consequences

- A stored AgentDock session consumes no Pi process, thread, or container while
  idle, yet its next turn can see prior messages and workspace modifications.
- The terminal transcript and recoverable state share an explicit ordering
  guarantee instead of relying on best-effort post-completion upload.
- Checkpoint persistence adds latency to the successful turn boundary and needs
  object-store health before completion can be acknowledged.
- The custom manifest is safe and testable for the small Java fixture but is
  not a generic large-repository packaging format.
- Content hashes detect corruption, while lease/fence validation and revision
  compare-and-swap prevent stale checkpoint replacement. They do not make
  arbitrary external tool side effects exactly once.

## Rejected alternatives

### Keep the container warm for each session

This preserves incidental process state but makes idle resource consumption
scale with stored conversations and turns a cache into the recovery authority.

### Upload after `turn.completed`

This permits a durable completed transcript without a durable continuation
point. A failed upload would force either a false success or contradictory
terminal state.

### Bind-mount a host checkpoint directory

This expands the untrusted container's filesystem authority and bypasses the
object-store restoration path that production needs.

### Persist snapshot blobs in PostgreSQL

PostgreSQL owns pointers and transactional metadata, not large cold bytes.
Moving blobs into the control database would contradict the existing ownership
model and make later S3/MinIO adoption a migration rather than an adapter.

### Archive the whole workspace with unrestricted `tar`

Blind extraction must handle traversal, links, devices, ownership, and archive
bombs. The first bounded manifest rejects those classes explicitly.
