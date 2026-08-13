# ADR-0068: Session-resident Cube and persistent POSIX Workspace continuity

- Status: accepted, rewritten by ADR-0101
- Date: 2026-07-27

## Context

An interactive Coding Agent should not behave like a batch Job. Destroying the
Cube at every successful Run removes development servers and caches, while
keeping every Cube forever makes idle compute scale with stored conversations.
Workspace files need a lifetime independent from both choices.

## Decision

### Warm Cube lifetime

The exact `(tenant, project, workspace, session)` may own at most one live Cube
activation. On a successful Run the per-Run Tool authority is revoked, the
Workspace is captured at a bounded quiescent boundary, background processes are
resumed and the Cube enters `IDLE_WARM`.

A later Run may rebind the same Cube only when identity, environment and
committed Workspace revision match, using a strictly newer fence and fresh
handoff secret. Otherwise the old Cube is destroyed and a fresh Cube mounts the
same persistent Workspace Volume.

Automatic Sessions are reclaimed after their idle TTL. Persistent Sessions
retain the Cube until explicit archive/delete, failure or operator action,
subject to admission limits. Cancellation, ambiguous Tool completion, stale
identity/fence, failed capture and shutdown fail closed and destroy the Cube.

### Tool authority versus user processes

The trusted guest supervisor persists for the Cube lifetime. The uid-1000 Tool
Worker is per active Run. Revoking its opaque Tool capability prevents new
commands without killing unrelated background user processes on the successful
warm-retention path.

Capture closes the Tool Worker, freezes the exact remaining user process
identities, flushes and indexes `/workspace`, computes the trusted external-Git
Patch, then resumes only those same process identities. An uncertain boundary
is not retained warm.

### Persistent Workspace authority

One tenant/workspace-bound Cube Volume owns Workspace bytes across Runs and
fresh Cube activations. The trusted Volume Gateway owns its envelope generation,
external Git metadata, integrity index and materialization. PostgreSQL commits
only the bounded persistent Volume reference and current WorkspaceVersion head
under the RunAttempt fence and base-version CAS.

No Cube memory snapshot, Kopia repository or per-Run Workspace archive is a
recovery authority. A Cube/node loss destroys process memory, sockets and PTYs;
the next activation mounts the persistent Volume and starts fresh processes.
Off-node backup of the Volume is an operator/storage concern, separate from the
interactive Run commit path.

## Consequences

- Background services can survive ordinary multi-round idle periods.
- Chat-only Sessions create no Sandbox.
- Warm Cubes are an availability/UX cache, never the correctness authority.
- Workspace files survive source-Cube destruction without copying all bytes on
  every Run.
- A single-node POSIX backend is not multi-node disaster recovery; distributed
  deployments must supply a shared persistent-volume implementation.

## Acceptance

Automated and live checks prove warm process reuse, higher-fence rebind, stale
capability rejection, fresh-Cube Volume reattachment, tenant isolation,
large-Workspace indexing, source-Cube destruction and complete resource cleanup.
