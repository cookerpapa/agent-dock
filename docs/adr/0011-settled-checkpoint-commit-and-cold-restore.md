# ADR-0011: Settled checkpoint commit and cold restore

- Status: accepted, rewritten by ADR-0101
- Date: 2026-07-19

## Context

A cold Session must resume Pi's native conversation and the Workspace without
keeping one Pi process or Cube alive forever. A public completion event must not
become visible before the state needed by the next Run is committed.

Pi Session state and Workspace state have different durability owners:

- Pi-native Session entries and compacted branches are stored through the
  PostgreSQL Session/checkpoint boundary;
- the persistent Cube Volume owns Workspace bytes;
- PostgreSQL stores the immutable Workspace reference, file index and current
  version pointer, not another copy of the Workspace.

## Decision

1. Successful settlement prepares the Pi checkpoint and a bounded persistent
   Volume reference before publishing completion.
2. The Control Plane commits the terminal event, Run/Attempt state, Pi
   checkpoint head and Workspace version/head in one fenced PostgreSQL
   transaction. A failure before that transaction cannot expose a completed
   Run.
3. Pi JSONL/SessionStorage remains Pi's conversation authority. PiCloud never
   reconstructs a competing mutable `messages[]` from browser text.
4. Workspace bytes remain on the Workspace's persistent Cube Volume across
   warm reuse and fresh Cube activation. The checkpoint carries only provider
   identity, volume revision, external Git baseline, bounded file metadata and
   integrity hashes.
5. A replacement Worker loads the latest committed Pi checkpoint. A replacement
   Cube mounts the same tenant/workspace-bound persistent Volume and validates
   its generation and revision before Tool execution.
6. Lease, fencing token and Workspace-head compare-and-swap prevent an old
   Attempt from advancing either state head.
7. Cold restore is semantic and filesystem durable, not process-memory
   recovery. Open descriptors, shell state, child processes, sockets and an
   in-flight Tool operation are not restored.
8. Failed or cancelled Runs preserve the interruption boundary defined by
   ADR-0079/ADR-0080 without falsely advancing the successful Workspace head.

## Consequences

- Idle Sessions consume no dedicated Pi process.
- Persistent Workspaces are not copied into PostgreSQL or object storage on
  every Run.
- A warm Cube may preserve processes for product convenience, while correctness
  depends only on committed Pi state and the persistent Volume.
- Arbitrary shell side effects retain honest at-most-once-start semantics; the
  design does not claim process checkpoint/restore or exactly-once Bash.
