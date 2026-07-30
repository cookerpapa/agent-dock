# ADR-0073: Trusted platform Git metadata

- Status: Accepted
- Date: 2026-07-30
- Refines: ADR-0072

## Context

AgentDock creates a synthetic root Git repository for every Workspace. It is
not a repository supplied by the user: its baseline commit represents the
accepted source state, and its cumulative binary diff feeds terminal Run
settlement, Review Bundles, Candidate Race evaluation and delivery evidence.

ADR-0072 moved the Volume generation marker outside the Cube-visible
`/workspace`, but retained this synthetic `.git` directory inside the user
tree. That kept Patch semantics intact at the cost of exposing platform
metadata to untrusted commands and cluttering every otherwise-empty
Workspace.

Setting `GIT_DIR` inside the guest or leaving a `.git` indirection file would
only move the name. The guest would still receive platform metadata, and a
process-wide Git environment would break independently cloned nested
repositories.

## Decision

The physical POSIX Volume envelope is:

```text
agentdock-posix-<volume-id>/
├── .agent-dock-runtime/
│   ├── generation
│   └── git/
└── workspace/
    └── user files
```

Only `workspace/` is mounted into Cube. The trusted Workspace Data Mover alone
can access `.agent-dock-runtime/git`.

For a fresh activation:

1. the Data Mover creates an empty envelope and generation;
2. Cube materializes the accepted seed and executes the deployment-owned
   environment recipe;
3. before the Sandbox handle becomes available to Agent Tools, the Sandbox
   Manager asks the Data Mover to create the external baseline;
4. the Data Mover invokes Git with explicit trusted paths:

   ```text
   GIT_DIR=<envelope>/.agent-dock-runtime/git
   GIT_WORK_TREE=<envelope>/workspace
   ```

At a checkpoint boundary, Cube freezes the exact user-process identities,
flushes `/workspace`, and returns only the bounded file index. While that
boundary remains frozen, the Data Mover computes the cumulative binary Patch
through the external Git directory and snapshots the complete envelope with
Kopia. The Manager then completes the checkpoint and resumes the frozen
processes.

The Git baseline commit is carried in the Data Mover state and immutable
Workspace checkpoint reference. Restore validates the expected baseline
before exposing the Workspace to a new Cube. The checkpoint reference advances
to `agent-dock.workspace-kopia-snapshot.v4`; v3 references and physical
Volumes are rejected rather than migrated in place.

Root `.git` is no longer reserved as platform state. If a user explicitly runs
`git init` or clones a repository inside `/workspace`, that repository remains
ordinary user data. Platform Patch collection excludes the root `.git`
directory from its synthetic baseline so user Git internals are not mistaken
for product source changes.

## Consequences

- A fresh `/workspace` contains only user files.
- Cube cannot read, corrupt or forge the platform baseline/index/object store.
- Patch, Review Bundle and Candidate semantics remain available.
- Root `git status` no longer discovers AgentDock's synthetic repository.
  Coding Tools use AgentDock's Patch result for platform review, while user
  Git commands continue to work in repositories the user creates or clones.
- Environment validation checks the writable Workspace boundary instead of
  assuming that `/workspace` itself is a user-visible Git repository.
- Existing development Workspace heads, Kopia references and POSIX Volumes
  from v3 must be discarded at deployment cutover.

## Acceptance

1. Cube sees no platform `.git` file or directory under `/workspace`;
2. the trusted envelope contains a valid external Git baseline;
3. edits, deletions and new files produce the same bounded binary Patch;
4. external Git metadata survives Kopia snapshot and cold restore;
5. a missing or mismatched baseline fails closed before Tool execution;
6. a user-created nested repository remains usable and is not treated as
   platform metadata; and
7. real Cube/model acceptance proves two-round warm reuse, cold restore and
   cross-tenant isolation with a clean Workspace root.
