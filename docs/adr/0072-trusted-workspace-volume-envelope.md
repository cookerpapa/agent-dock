# ADR-0072: Trusted Workspace Volume envelope

- Status: Accepted
- Date: 2026-07-29
- Refines: ADR-0067, ADR-0068

## Context

The Cube POSIX Volume previously mounted its physical root directly at
`/workspace`. The trusted Volume Gateway stored
`.agent-dock-runtime/generation` in that root so the marker followed the same
persistent Volume lifecycle as the mutable Workspace.

Tool file APIs, Workspace indexes and Git patches excluded the marker, but an
untrusted shell could still list it because Cube mounted the entire physical
Volume. This mixed platform checkpoint metadata with user-visible files and
made `/workspace` less clean than its product contract.

At the time of this decision, the root `.git` directory still held AgentDock's
private Workspace baseline. ADR-0073 subsequently moved that metadata beside
the user-visible tree as well.

## Decision

Every physical POSIX Volume is an envelope:

```text
agentdock-posix-<volume-id>/
├── .agent-dock-runtime/
│   └── generation
└── workspace/
    ├── .git/
    └── user files
```

The trusted Workspace Volume Gateway owns the envelope root. The Cube Volume
Plugin exposes only the `workspace/` child as the guest's `/workspace` mount.
The sibling metadata directory is therefore absent from the untrusted guest
filesystem rather than hidden by an application-level path filter.

The Volume Gateway must validate all three facts before reusing or publishing a
Volume:

1. the Volume identity matches the requested tenant and Workspace;
2. the envelope generation matches the committed Volume reference; and
3. the `workspace/` child is a real directory, not a symbolic link.

Snapshot file materialization prefixes the requested user-relative path with
`workspace/`. User-visible indexes and portable snapshots operate only on the
mounted child and no longer reserve `.agent-dock-runtime` as a user path.

The persistent Volume reference carries the generation/revision and tenant,
Workspace and activation binding. Previous development checkpoint formats and
physical Volume layouts are rejected; no compatibility reader or in-place
migration branch is retained.

## Consequences

- `ls -la /workspace` no longer exposes AgentDock checkpoint metadata.
- An untrusted command cannot read, delete or forge the generation marker.
- Workspace bytes stay on the persistent Volume; PostgreSQL receives only the
  bounded immutable reference and file index.
- Root `.git` handling is superseded by ADR-0073.
- Existing development Workspace heads, old checkpoint references and local POSIX
  Volumes from the previous layout must be discarded during deployment
  cutover.

## Acceptance

1. a fresh Volume exposes an empty `/workspace` without
   `.agent-dock-runtime`;
2. the physical envelope contains a generation marker beside `workspace/`;
3. persistent Volume reattachment and file materialization use the envelope layout;
4. missing, linked or mismatched envelope components fail closed;
5. warm same-Session reuse and post-checkpoint background writes still work;
6. Workspace Patch behavior remains unchanged; and
7. source tests and the live Cube production gate prove fresh-Cube recovery
   after the source VM is destroyed.
