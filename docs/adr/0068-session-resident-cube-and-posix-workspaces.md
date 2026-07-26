# ADR-0068: Session-resident Cube and POSIX Workspace continuity

- Status: Accepted
- Date: 2026-07-27
- Supersedes: ADR-0060 warm pause behavior, ADR-0064, ADR-0065, ADR-0066
- Refines: ADR-0067

## Context

The previous warm lifecycle sealed the Tool boundary, killed all uid-1000
processes and paused Cube at every successful Run boundary. It safely rotated
fencing ownership, but it made an interactive environment behave like a batch
job: a development server disappeared when a response settled and a paused VM
could not serve a preview.

ADR-0067 moved `/workspace` to a Cube Volume Plugin backed POSIX path and made
Kopia the immutable checkpoint provider. Cube v0.6 `CommitSandbox` rejects
hostPath/plugin-backed mounts, so Cube native memory/filesystem snapshots
cannot checkpoint this topology. Keeping both implementations created a
misleading fallback and substantial legacy authority, materialization and
garbage-collection code.

## Decision

### One live Cube activation per active Session

The exact tuple `(tenant, project, workspace, session)` may own at most one
live Cube activation. After a successful Run:

1. the current Tool Worker is closed;
2. the RunAttempt Tool capability and guest handoff secret are rotated;
3. the Workspace is checkpointed at a bounded quiescent boundary;
4. user background processes are resumed;
5. the Cube remains running in `IDLE_WARM`; and
6. an idle TTL reaper destroys it if no later Run arrives.

A later Run reuses the Cube only when the exact identity, environment and
committed Workspace revision match. Rebind requires a strictly higher fencing
token and a new random handoff secret. Otherwise the old Cube is destroyed and
the committed Kopia checkpoint is restored into a new activation.

The default idle TTL remains fifteen minutes. A successful rebind refreshes the
TTL. Cancellation, ambiguous Tool completion, failed checkpoint, stale
identity, failed rebind and shutdown destroy the Cube instead of retaining it.

### Tool authority and user processes are separate

The trusted root guest supervisor is persistent. The uid-1000 Tool Worker is
per active Run and receives no handoff credential. Revoking a Run closes that
Tool Worker and prevents new commands, but does not kill unrelated background
uid-1000 processes on the successful path.

Checkpoint uses a two-step protocol:

```text
prepare
    -> close Tool Worker
    -> SIGSTOP remaining uid-1000 process identities
    -> sync and index Workspace
    -> return frozen process evidence

trusted Kopia snapshot

complete or abort
    -> verify PID plus process start-time identity
    -> SIGCONT only those frozen processes
    -> remain detached with no Tool Worker
```

If the protocol cannot prove that the boundary is idle or cannot resume the
same identities, the Sandbox is not eligible for warm retention.

### Workspace durability

The plugin-backed POSIX Volume is the live mutable Workspace. The trusted Kopia
Data Mover creates immutable recovery points in S3-compatible storage.
PostgreSQL remains the only canonical WorkspaceVersion-head authority and
publishes a snapshot only after the existing RunAttempt fence and base-version
CAS succeed.

The Data Mover may reuse an exact-Session live Volume only when its trusted
sidecar base equals the requested committed Kopia snapshot **and** the
sidecar's random volume generation equals the protected generation marker
carried inside that live Volume and its Kopia snapshot. This preserves writes
made by a retained background process after the previous checkpoint without
mistaking an empty or replaced POSIX path for a healthy warm Workspace. A
missing or mismatched marker/sidecar, identity mismatch, requested rollback to
another snapshot or explicit reset causes an empty-then-restore operation.

`.agent-dock-runtime/generation` is platform metadata, not user Workspace
content. It is excluded from Tool file paths, Workspace indexes, portable
snapshots and Git patches. A Kopia snapshot without the current generation
marker is invalid; no legacy fallback is supported.

Kopia remains behind the `WorkspaceDataMover` boundary. A deployment backed by
CephFS may later add a CephFS checkpoint provider without changing Pi, Tool
RPC, Cube or PostgreSQL ownership.

### Native Cube Workspace checkpoints are removed

The runtime accepts only `agent-dock.workspace-kopia-snapshot.v1` for Cube
Workspace restoration. The following are deleted:

- `agent-dock.workspace-cube-snapshot.v1` codec and recovery authority;
- native Cube snapshot creation/restoration branches;
- Cube snapshot file materialization;
- Cube snapshot reference reconciliation and garbage collection;
- related service credentials, API endpoints, state and tests.

No migration path is kept. Development databases, object data, Cube snapshots
and Workspace volumes from the incompatible formats are deleted during
cutover.

## Consequences

- A Web server or other background process can remain reachable between Runs
  during the Session idle window.
- Process memory, sockets and PTYs are not durable after idle disconnection,
  Manager failure or Cube-node failure. The next Run restores Workspace files
  and starts fresh processes.
- A live POSIX backend is required for continuity; Kopia is still required for
  immutable versioning, rollback and off-node recovery.
- Running warm Cubes consume memory. Admission and least-recently-used eviction
  cap the number of retained activations; eviction destroys processes but not
  the live Volume or committed Kopia snapshots.
- Chat-only Sessions still create no physical Sandbox.

## Acceptance

The cutover is complete only when automated and live tests prove:

1. a background process and its PID survive two successful Runs on the same
   physical Cube;
2. stale Tool capability, old handoff secret and old fence are rejected;
3. checkpoint freezes and resumes the same PID/start-time identities;
4. Workspace writes made by the retained process survive the next Run;
5. an exact-Session rebind does not call Cube pause/connect;
6. TTL expiry, cancellation and failed checkpoint destroy the Cube and its
   processes;
7. rollback or identity mismatch restores the requested Kopia snapshot instead
   of reusing live bytes;
8. deleting the POSIX contents while retaining the trusted sidecar forces a
   Kopia restore of the same committed snapshot;
9. no native Cube Workspace checkpoint or snapshot-GC compatibility code
   remains;
10. two tenants cannot observe each other's process, Volume or Workspace; and
11. a real-model multi-round coding Run and Web preview pass end to end.
