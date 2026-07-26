# ADR-0067: Cube POSIX volumes and Kopia workspace authority

Status: Accepted

Date: 2026-07-26

## Context

ADR-0064 made a Cube native snapshot the fallback for Workspaces that do not fit
the bounded portable checkpoint format. That preserves a full Workspace across
Run boundaries, but Cube v0.6 stores the snapshot bytes in the Cube execution
plane. A committed PostgreSQL Workspace version can therefore point at bytes
that disappear with the only Cube node.

AgentDock already has the correctness boundary needed for a replacement:

- PostgreSQL owns the current Session Workspace-version head;
- a RunAttempt owns a lease and monotonically increasing fencing token;
- immutable checkpoint metadata is stored in the checkpoint object store; and
- only a fenced compare-and-swap may publish a new Workspace head.

The missing part is a node-independent Workspace data plane. Cube v0.6 exposes
an official Volume Plugin API with controller `Create`/`Destroy` and node
`Attach`/`Detach` hooks. Kopia is an Apache-2.0, actively maintained,
content-addressed, encrypted, compressed and deduplicated snapshot engine with
S3-compatible repository support.

## Decision

Large and ordinary Cube Workspaces use the following chain:

```text
Cube Volume Plugin
    -> stable per-Session POSIX volume
    -> trusted Workspace Data Mover
    -> Kopia immutable snapshot in S3-compatible object storage
    -> compact checkpoint reference
    -> existing PostgreSQL fenced/CAS WorkspaceVersion commit
```

The Cube Tool VM mounts exactly one AgentDock-created volume at `/workspace`.
The model, Pi Worker and Tool VM cannot choose a volume ID, host path, storage
driver or Kopia snapshot ID. The stable volume ID is a server-side hash of the
tenant, Workspace and Session identity.

The POSIX plugin is deliberately small. It only accepts AgentDock volume IDs,
keeps each path below Cube's configured `volume_plugin_base_dir`, rejects
symbolic-link paths, creates directories with a private mode and returns the
pre-mounted shared path to Cubelet. In a multi-node installation,
`volume_plugin_base_dir` must be the same POSIX shared filesystem mount on every
Cube node and on the trusted data mover. A local directory is allowed only for
the single-node development profile.

Kopia runs only in the trusted data mover. The mover has:

- the shared POSIX mount;
- a dedicated Kopia repository password and S3 credential;
- a narrow authenticated API for ensure/restore, snapshot and verification.

It does not have a model credential, Pi history, PostgreSQL credential,
Kubernetes credential or Cube administrative credential. A Tool VM never sees
Kopia or object-store credentials.

Every restore verifies tenant/Workspace/Session/volume binding and restores an
immutable Kopia snapshot into an empty or matching stable volume before Cube
attaches it. Every snapshot is taken only after the guest Tool boundary is
sealed, all Tool-UID processes are gone and the Workspace filesystem is
flushed. Kopia success only creates an orphan-safe immutable candidate. The
candidate becomes canonical only when the existing PostgreSQL transaction
checks the RunAttempt/fence and compare-and-swaps the expected Workspace head.

Physical writable volume reuse is restricted to the exact tenant, Workspace
and Session. AgentDock must prove the previous physical Cube assignment absent
before a higher-fence cold activation attaches the same volume. A volume that
has held one tenant's code is never reassigned to another tenant.

The previous `agent-dock.workspace-cube-snapshot.v1` format remains readable
for migration and rollback. New large checkpoints use
`agent-dock.workspace-kopia-snapshot.v1`. Cube native snapshots stop being the
new Workspace authority after cutover.

## Failure semantics

- A Kopia snapshot created by a stale Attempt may consume object bytes, but its
  old fence cannot advance PostgreSQL and it is eligible for garbage
  collection.
- A PostgreSQL commit whose acknowledgement is lost is resolved by the existing
  idempotent commit ID and head state; the Kopia snapshot is immutable.
- A Cube node or VM may disappear. A new node creates/attaches the stable
  volume, and the mover restores the latest committed Kopia snapshot before
  Tool execution.
- If a command result is ambiguous, AgentDock still destroys the VM and does
  not replay arbitrary Bash. Workspace persistence does not change command
  delivery semantics.
- If the shared POSIX backend or Kopia repository is unavailable, activation or
  checkpointing fails closed. No empty Workspace is silently accepted for a
  committed non-empty checkpoint.

## Explicit non-goals

This protocol preserves Workspace files and metadata represented by Kopia. It
does not preserve process memory, open sockets, background processes, PTYs or
an in-memory database. Run recovery starts a fresh Cube VM and fresh processes.

The local single-node profile can prove loss of the Cube node-local Workspace
copy by deleting that copy and restoring from MinIO. It does not prove whole
physical-host disaster recovery because local MinIO and the development POSIX
directory share that host. That claim requires externally replicated POSIX and
S3-compatible services.

## Alternatives considered

### Keep Cube native snapshots

Rejected as the long-term authority because the current deployment leaves
snapshot bytes node-local.

### Put Kopia inside the Tool VM

Rejected because it would expose durable object-store authority to untrusted
model-generated code.

### Velero alone

Rejected for this storage path. Velero protects Kubernetes resources and
supported volumes, but a Cube Workspace crosses Cube's own control plane,
microVM and host mount. It does not provide AgentDock's RunAttempt fencing or
Workspace-head CAS.

### Build a custom chunk store

Rejected under the adopt-before-build rule. Kopia already supplies encrypted
content addressing, compression, deduplication, verification, retention and
S3-compatible storage. AgentDock implements only the narrow identity/fence
adapter that Kopia cannot own.

## Consequences

The data path gains an external shared-filesystem dependency and a Kopia
repository. Operators must monitor both and run Kopia maintenance. The benefit
is that Cube execution-node lifecycle is no longer the durable Workspace
authority, while the existing PostgreSQL correctness model remains unchanged.

