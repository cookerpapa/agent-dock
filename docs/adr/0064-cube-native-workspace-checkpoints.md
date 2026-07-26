# ADR-0064: Cube-native large Workspace checkpoints

Status: accepted

Date: 2026-07-26

## Context

The original provider-neutral Workspace manifest is a safe bootstrap format,
not a large repository persistence engine. It embeds base64 file content in one
bounded JSON message. A real Run that cloned a large public repository
completed its Agent Loop and Tool calls but failed at settlement because the
Workspace exceeded 512 files and 2 MiB.

ADR-0053 made CubeSandbox the ordinary Tool Provider. ADR-0060 already requires
the Manager to seal the Tool service, remove all Tool-UID processes and rotate
authority before reusing a paused microVM. Cube v0.6 also provides a persistent
snapshot that survives source Sandbox destruction and can be used as a new
Sandbox template.

The research note
[`2026-07-26-large-workspace-persistence.md`](../research/2026-07-26-large-workspace-persistence.md)
compares Kopia, Restic, REAPI CAS and Cube snapshots.

## Decision

### New ordinary checkpoint

The Cube Provider performs this sequence:

1. verify the current assignment, RunAttempt and fence;
2. seal the in-guest Tool service and prove zero Tool-UID processes;
3. capture a bounded, content-hashed regular-file index and Git patch while the
   Workspace is quiescent;
4. rotate the sealed service to a random recovery authority without reopening
   Tool execution;
5. if the Workspace still fits the legacy portable manifest, return those
   content bytes so historical file download and GitHub delivery retain their
   existing behavior;
6. otherwise create a Cube native snapshot;
7. encrypt the recovery authority with AES-256-GCM using a
   domain-separated key derived from the persistent Sandbox Manager service
   secret;
8. return a small provider checkpoint reference to the Pi Worker;
9. let the existing S3 upload plus PostgreSQL fence/CAS transaction publish the
   reference as the Workspace head.

The reference hash remains the AgentDock `workspaceRevision`. Cube's snapshot
ID is never accepted by itself.

### Cold restore

If a Workspace restore decodes as a Cube reference, the Cube Provider:

1. verifies tenant, Workspace, image and environment bindings;
2. decrypts the recovery authority;
3. creates a new Cube Sandbox from the immutable Tool template so its physical
   metadata contains the new assignment;
4. invokes Cube's official rollback operation with the snapshot ID;
5. reaches only the sealed Tool service;
6. authenticates with the old recovery authority and rotates to the new
   activation, physical binding, secret and strictly higher fencing token;
7. starts a fresh Tool Worker against the preserved Workspace;
8. validates runtime/environment evidence before returning the handle.

Cube v0.6 also accepts a snapshot ID as a create template, but that route
inherits the source Sandbox labels. AgentDock therefore does not use it for
cold restore: stale physical Attempt metadata would make post-restart orphan
reconciliation unsafe.

No model or Tool request can choose a snapshot ID, Provider, recovery secret,
binding or fence.

### State ownership

- PostgreSQL: canonical Workspace-version head, RunAttempt/fence and artifact
  metadata.
- MinIO/S3: Pi-native session data and the small encrypted Cube checkpoint
  reference.
- Cube: complete filesystem/process snapshot bytes for large primary-Provider
  Workspaces that do not fit the portable manifest.
- Sandbox Manager: Cube API authority and checkpoint encryption key derivation.
- Tool Sandbox: no PostgreSQL, MinIO, model or Cube API credential.

An uploaded/reference object or Cube snapshot that loses the PostgreSQL CAS is
an orphan. It never becomes canonical and is reclaimed separately.

### Compatibility

`agent-dock.workspace-manifest.v1` remains the preferred format when content
fits, preserving existing files/PR behavior for controlled imports, fixtures,
small ordinary Workspaces and the retained gVisor regression Provider. Large
ordinary Cube checkpoints use `agent-dock.workspace-cube-snapshot.v1`; there is
no automatic lower-security runtime fallback.

The provider reference includes file metadata and hashes, so historical lists
and comparisons do not need to boot a VM. Historical content download and
GitHub delivery require materialized v1 bytes or an explicit future
snapshot-reader/data-mover path; they fail clearly rather than returning
invented bytes.

## Consequences

Positive:

- large repositories no longer cross four services as one base64 JSON blob;
- nested Git metadata and other complete filesystem state survive;
- snapshots are fast CoW Provider operations;
- credentials remain outside untrusted execution;
- recovery stays fenced and works after Manager restart;
- the existing PostgreSQL checkpoint commit remains the only head mutation.

Negative:

- new large checkpoints are Provider-bound;
- current single-node Cube snapshot storage does not survive node/disk loss;
- old snapshot garbage collection needs a reference-aware reconciler;
- historical file-content download needs a future read-only snapshot
  materializer;
- rotating the persistent Sandbox Manager service secret requires migrating or
  retaining the previous checkpoint decryption key.

## Rejected alternatives

- Raise JSON/base64 limits: preserves the wrong buffering architecture.
- Kopia/Restic now: mature, but adds a second repository/credential/maintenance
  plane and still needs a Cube data mover.
- Full REAPI CAS now: good future portable model, but duplicates the current
  object plane before a guest streaming bridge exists.
- Make a paused live VM the only authority: does not survive source cleanup or
  Manager restart and cannot support immutable Workspace history.
- Put S3 credentials in the guest: violates the credential boundary.
