# Session-resident Cube runtime research

Date: 2026-07-27

## Question

How should AgentDock preserve an interactive coding environment after a Run
without giving a stale Pi Worker continuing Tool authority, losing background
processes, or making Cube and PostgreSQL competing state authorities?

## Findings

### Cube Volume Plugin is a mount contract, not a checkpoint engine

Cube v0.6 Volume Plugin splits storage allocation and node attachment into
`Create`/`Destroy` and `Attach`/`Detach` hooks. The node hook returns a
`hostPath`, and Cubelet exposes that path to the microVM through virtiofs. The
backend may be a local POSIX directory for one-node development or a shared
filesystem such as NFS or a distributed filesystem for multiple Cube nodes.

The plugin therefore solves live-byte persistence across Sandbox lifecycles. It
does not provide immutable versions, retention, verification, rollback or
off-node disaster recovery by itself.

Source:
<https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/volume-plugin.md>

### Cube native snapshots cannot include the AgentDock Volume topology

Cube documents `create_snapshot()` as a complete memory-and-filesystem
snapshot. That is true for a supported CubeCoW Sandbox:

<https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/snapshot-rollback-clone.md>

However, the v0.6 Cubelet implementation validates the target before
`CommitSandbox`. It rejects:

- every container mount with a non-empty `host_path`;
- a used `host_dir` volume; and
- `sandbox_path` directory/shared-bind mounts.

The Volume Plugin attaches `/workspace` through exactly such an external
hostPath/virtiofs dependency. Consequently, an AgentDock Sandbox with a
persistent plugin-backed Workspace cannot use Cube's native complete snapshot.
This is an enforced implementation constraint, not merely a missing SDK
option.

Source:
<https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/Cubelet/services/cubebox/template_ops.go>

The alternatives are therefore:

1. put the Workspace inside CubeCoW and use a node-local complete snapshot; or
2. keep the Workspace on an external Volume and version it independently.

AgentDock chooses the second option because Workspace durability and
multi-node recovery matter more than hibernating process memory after the idle
window.

### A running Session, not a paused VM, preserves Web previews

Cube pause/resume is useful when the only requirement is reducing idle CPU. A
paused VM cannot continue serving a Web preview or let a background process
write its data. The product behavior requested for an interactive coding
session is instead:

```text
Run settles
    -> revoke the RunAttempt Tool capability
    -> checkpoint the Workspace at a short quiescent boundary
    -> keep the exact-Session Cube running
    -> keep background user processes and ports alive
    -> idle TTL expires
    -> disconnect and destroy the Cube
```

The physical Cube belongs only to one tenant/project/Workspace/Session and is
never reassigned. A later Run for that exact Session rotates the guest handoff
secret, installs a strictly higher fencing token and starts a fresh Tool
Worker. The old Pi Worker cannot execute another Tool even though the user's
background processes survived.

### Live storage and immutable checkpoints have different jobs

AgentDock keeps three non-overlapping responsibilities:

| Layer | Responsibility |
| --- | --- |
| Cube Volume Plugin + POSIX backend | live mutable `/workspace` bytes |
| Kopia + S3-compatible repository | immutable encrypted/deduplicated recovery points |
| PostgreSQL WorkspaceVersion head | canonical version, parent and fencing/CAS decision |

Kopia snapshots are content-addressed and incremental, and its repository can
use S3-compatible object storage. Kopia also supports repository and file
verification. This makes it a suitable portable checkpoint provider for local
POSIX, NFS or CephFS-backed live volumes.

Sources:

- <https://kopia.io/docs/advanced/architecture/>
- <https://kopia.io/docs/getting-started/>
- <https://kopia.io/docs/advanced/consistency/>

CephFS can create immutable filesystem and subvolume snapshots. It is a valid
future provider when AgentDock is deployed on a real Ceph cluster, but
requiring a Ceph cluster for the single-node development product would add
MON/MGR/MDS/OSD operations solely to replace an already working checkpoint
engine.

Sources:

- <https://docs.ceph.com/en/latest/cephfs/snapshots/>
- <https://docs.ceph.com/en/latest/cephfs/fs-volumes/>

## Selected shape

```text
Trusted Pi Worker (one RunAttempt)
        |
        | fenced Tool RPC
        v
Trusted Sandbox Manager
        |
        | rotated guest handoff secret
        v
Session-resident Cube microVM
        |-- root Tool supervisor
        |-- ephemeral Tool Worker for the active Run
        |-- user background processes across Runs
        `-- /workspace -> Cube Volume Plugin -> POSIX backend
                                             |
                                             `-> trusted Kopia Data Mover
                                                 -> S3-compatible repository
```

At checkpoint, the root Tool supervisor closes the Tool Worker, stops the
remaining uid-1000 processes, flushes and indexes `/workspace`, and keeps the
process identities frozen while the trusted host-side Data Mover snapshots the
Volume. The Manager then sends a commit/abort acknowledgement; the supervisor
resumes only the same PID/start-time identities and remains detached until the
next higher-fence rebind.

The live Volume is reusable only for the exact Session and expected committed
snapshot base. An explicit rollback to another WorkspaceVersion forces an
immutable restore. This preserves background writes during the warm window
without allowing a stale Volume to override a rollback.

## Removed design

AgentDock no longer reads or produces
`agent-dock.workspace-cube-snapshot.v1`. The native Cube snapshot recovery
authority, materializer and reference-aware Cube snapshot garbage collector
were compatibility machinery for a topology that is now invalid. Development
data that references that format is deleted during cutover instead of migrated.

