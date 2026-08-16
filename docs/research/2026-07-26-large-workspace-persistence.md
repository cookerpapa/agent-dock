# Large Workspace persistence research

Date: 2026-07-26

## Problem

The production Tool checkpoint path still serializes every regular Workspace
file into one `pi-cloud.workspace-manifest.v1` JSON document. The format is
intentionally bounded to 512 files, 512 KiB per file and 2 MiB total. A real
Cube Run cloned `temporalio/temporal`, completed its model calls and Tool
operations, then failed during checkpoint capture because the repository was
outside those limits. The failure was surfaced as `Local supervisor execution
failed`, which also hid that execution itself had succeeded.

Increasing the JSON limits is not an acceptable fix:

- base64 and JSON multiply memory and wire cost;
- the Cube Tool response, Sandbox Manager response, Pi Worker and S3 client
  would all buffer the same tree;
- large Git pack files still exceed any reasonable control-message bound;
- a larger bound does not provide incremental persistence or fast restore.

The required semantics are:

- preserve a complete large Workspace without exposing object-store
  credentials to untrusted Tool processes;
- commit only a snapshot produced by the current RunAttempt/fence;
- restore on another Pi Worker and after a Sandbox Manager restart;
- keep Pi conversation state independent from Workspace state;
- retain one durable application pointer in PostgreSQL;
- keep the existing provider-neutral manifest readable for old and small
  checkpoints while not using it for new ordinary Cube checkpoints.

## Candidates

### Kopia

[Kopia](https://github.com/kopia/kopia) is Apache-2.0, actively maintained and
provides encrypted, compressed, deduplicated filesystem snapshots. Its
[architecture](https://kopia.io/docs/advanced/architecture/) layers
content-addressable blocks and objects over S3-compatible storage. Its
[repository server](https://kopia.io/docs/repository-server/) lets remote
clients use username/password authentication without learning S3 credentials
and limits ordinary users to their own snapshot manifests.

Kopia is technically capable, and Velero is evidence that it can be embedded
behind an adapter: Velero's
[File System Backup](https://velero.io/docs/v1.18/file-system-backup/) integrates
the Kopia uploader and repository modules and creates a separate repository
prefix per namespace.

It is not the best first authority for PiCloud:

- it adds a second repository format, server, user lifecycle, repository
  password, cache, maintenance and garbage-collection plane beside MinIO and
  Cube;
- the untrusted guest would need a scoped repository credential and a network
  route, or a privileged data mover would need filesystem access to the guest;
- Kopia's snapshot publication does not replace PiCloud's RunAttempt fence,
  Workspace-version CAS or PostgreSQL commit;
- adopting Velero's node-agent topology would require a host/PVC mount and in
  some deployments privileged access, while Cube's Workspace lives inside a
  microVM disk.

Kopia remains the preferred future portable backup uploader if PiCloud adds a
trusted Cube volume export/data-mover API or a multi-node object-backed Cube
snapshot store.

### Restic

[Restic](https://github.com/restic/restic) is BSD-2-Clause, actively maintained
and supports S3/MinIO plus the open
[REST backend protocol](https://restic.readthedocs.io/en/stable/REST_backend.html).
Its [repository design](https://restic.readthedocs.io/en/stable/100_references.html)
uses immutable SHA-256-addressed objects, parallel readers/writers and explicit
locks.

It has the same guest-credential/data-mover mismatch as Kopia, introduces
repository locks and maintenance into the Run critical path, and offers no
PiCloud fencing or Workspace-head CAS. It is therefore rejected for the
ordinary interactive checkpoint path.

### Remote Execution API CAS

The Apache-2.0
[Bazel Remote Execution API](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)
defines a strong generic model: file bytes and `Directory` nodes live in a
content-addressable store, a root digest identifies a Merkle tree, missing
blobs can be queried before upload, and large bytes use streaming APIs.
NativeLink, Buildbarn and Buildfarm are mature implementation options.

This is the best model for a future provider-neutral, portable Workspace CAS,
but a full REAPI service is broader than PiCloud currently needs. Adding it
now would duplicate the existing S3 object plane and still require a streaming
bridge from the Cube guest. The useful design constraints are retained:
immutable data, bounded references in control messages, digest verification,
and an external transactional head.

### CubeSandbox native snapshots

PiCloud already pins and operates
[TencentCloud/CubeSandbox](https://github.com/TencentCloud/CubeSandbox).
Cube v0.6.0 documents
[snapshot, clone and rollback](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/snapshot-rollback-clone.md).
`create_snapshot()` persists the complete filesystem and memory independently
of the source Sandbox, and a snapshot ID can be supplied as the template for a
new Sandbox. Cube's CoW/reflink implementation avoids serializing the
Workspace through PiCloud's JSON control protocol.

This is the closest fit for the current primary Provider:

- no new storage service or guest object-store credential;
- exact filesystem preservation, including large nested Git repositories;
- the Manager already owns the Cube API and private traffic token;
- a snapshot can be taken only after the Manager seals the Tool boundary and
  proves that no Tool-UID process remains;
- a new Sandbox can restore the snapshot and rotate to a higher fence before
  accepting any Tool call.

The limitation is explicit: in the current one-node deployment Cube snapshots
are a durable local Provider artifact, not a portable multi-node/object-store
backup. Node/disk-loss durability still requires a future Cube storage profile
or a Kopia/REAPI data mover. The project must not claim otherwise.

## Decision

Use the existing portable manifest when an ordinary Cube Workspace still fits
it, and use Cube v0.6 native snapshots once the Workspace exceeds that format,
behind the existing `SandboxProvider` boundary. This preserves historical
file/PR behavior for existing small Workspaces while removing the
large-repository settlement bottleneck.

The checkpoint artifact stored in MinIO is a small
`pi-cloud.workspace-cube-snapshot.v1` reference containing:

- exact tenant/Workspace and environment bindings;
- Cube snapshot/source identities;
- the prior activation, physical binding and fence;
- an encrypted recovery authority;
- a content-hashed file/symbolic-link index for listing and comparison.

The index never follows a symbolic link. Link targets are hashed with a
domain-separated digest so replacing a regular file with a link cannot reuse
the regular-file digest. A Workspace containing links is ineligible for the
portable regular-file manifest and therefore uses the native Cube snapshot,
which preserves Git's `120000` entries exactly. Special files remain rejected.

The recovery authority is generated only after Tool processes are sealed,
encrypted with a domain-separated key derived from the stable Sandbox Manager
service secret, and never returned to the model or Tool process. A cold restore
creates a new Cube instance from the snapshot, authenticates with the recovery
authority, and atomically rotates activation, binding, secret and fence before
starting a new Tool Worker.

PostgreSQL remains the application authority. Creating a Cube snapshot may
leave an orphan after a failed/stale commit, but cannot advance the Workspace
head. Only the existing fenced checkpoint transaction can do that.

Legacy `pi-cloud.workspace-manifest.v1` checkpoints remain read-compatible
and writable for small ordinary Workspaces, migration, imports and the gVisor
regression Provider.

## Required evidence

- a Workspace above the old file/byte limits completes checkpointing;
- a nested Git repository, including `.git`, survives a cold restore;
- a fresh Sandbox Manager process can decrypt and restore the reference;
- restore rejects a different tenant/Workspace/environment;
- an equal or stale fence cannot rebind the snapshot;
- the recovery secret is absent from the stored reference, Tool environment,
  events and Temporal history;
- the old v1 fixture remains readable;
- a failed capture reports a checkpoint-specific safe error;
- real Git symbolic links are indexed without dereferencing or losing them;
- no source Sandbox or temporary clone remains after the test.
