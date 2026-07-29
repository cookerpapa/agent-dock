# ADR-0072: Trusted Workspace Volume envelope

- Status: Accepted
- Date: 2026-07-29
- Refines: ADR-0067, ADR-0068

## Context

The Cube POSIX Volume previously mounted its physical root directly at
`/workspace`. The trusted Data Mover stored
`.agent-dock-runtime/generation` in that root so the marker was carried by the
same Kopia snapshot as the mutable Workspace.

Tool file APIs, Workspace indexes and Git patches excluded the marker, but an
untrusted shell could still list it because Cube mounted the entire physical
Volume. This mixed platform checkpoint metadata with user-visible files and
made `/workspace` less clean than its product contract.

The root `.git` directory is different. AgentDock uses the baseline repository
to create the private Workspace patch consumed by terminal Run settlement,
Review Bundles, Candidate Race evaluation and production acceptance. Removing
it merely because the current browser does not render a per-Run diff would
silently remove those backend semantics.

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

The trusted Workspace Data Mover and Kopia snapshot the envelope root. The Cube
Volume Plugin exposes only the `workspace/` child as the guest's `/workspace`
mount. The sibling metadata directory is therefore absent from the untrusted
guest filesystem rather than hidden by an application-level path filter.

The Data Mover must validate all three facts before reusing or publishing a
Volume:

1. the trusted sidecar matches the requested immutable snapshot;
2. the envelope generation matches the sidecar generation; and
3. the `workspace/` child is a real directory, not a symbolic link.

Snapshot file materialization prefixes the requested user-relative path with
`workspace/`. User-visible indexes and portable snapshots operate only on the
mounted child and no longer reserve `.agent-dock-runtime` as a user path.

The Kopia checkpoint reference format advances to
`agent-dock.workspace-kopia-snapshot.v3`. Older development checkpoint
references and physical Volume layouts are rejected; no compatibility reader
or in-place migration branch is retained.

## Consequences

- `ls -la /workspace` no longer exposes AgentDock checkpoint metadata.
- An untrusted command cannot read, delete or forge the generation marker.
- Kopia still captures metadata and Workspace bytes in one immutable snapshot.
- Root `.git` remains part of the user-visible Workspace because it still
  powers backend review and evaluation behavior and remains useful to coding
  tools.
- Existing development Workspace heads, Kopia references and local POSIX
  Volumes from the previous layout must be discarded during deployment
  cutover.

## Acceptance

1. a fresh Volume exposes an empty `/workspace` without
   `.agent-dock-runtime`;
2. the physical envelope contains a generation marker beside `workspace/`;
3. Kopia snapshot/restore and file materialization use the envelope layout;
4. missing, linked or mismatched envelope components fail closed;
5. warm same-Session reuse and post-checkpoint background writes still work;
6. Git Patch and Review Bundle behavior remains unchanged; and
7. source tests and the live Cube production gate prove cold restore after the
   local envelope is erased.
