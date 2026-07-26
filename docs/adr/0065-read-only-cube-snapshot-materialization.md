# ADR-0065: Read-only Cube snapshot materialization

Status: accepted

Date: 2026-07-26

## Context

ADR-0064 stores large Workspace versions as small, encrypted references to
immutable Cube snapshots. The reference contains a complete content-hashed file
index, so the product can list and compare historical versions without loading
their file bytes. It could not previously return one historical file or prepare
that version for a trusted delivery workflow.

Restoring a snapshot through the ordinary Tool path is not acceptable for a
read-only product request. That path rotates to a higher write fence and starts
a Tool Worker capable of Bash and edits. Giving the Control Plane the ordinary
Sandbox Manager token would also turn a file-preview dependency into a broad
execution capability.

## Decision

AgentDock adds a distinct read-only snapshot materialization boundary:

1. the Control Plane reads and integrity-checks the immutable Workspace
   reference from object storage;
2. it sends the reference, tenant, Workspace and exact indexed path to a
   dedicated Sandbox Manager endpoint;
3. the endpoint accepts only a separately generated materializer credential;
   that credential is rejected by the ordinary Sandbox lifecycle endpoint;
4. the Manager applies the same global physical-Sandbox admission limit used by
   active Tool workloads;
5. the Cube Provider validates tenant, Workspace and current image bindings,
   decrypts the snapshot recovery authority and verifies that the requested
   path exists in the immutable index;
6. it creates a short-lived Cube clone from the snapshot but never calls
   `/v1/rebind` and never starts a new Tool Worker;
7. the still-sealed root service authenticates the recovery authority, safely
   opens one regular file beneath `/workspace` with `O_NOFOLLOW`, and returns at
   most 512 KiB;
8. the Provider validates byte length, SHA-256 and executable mode against the
   checkpoint index;
9. it destroys the clone and confirms absence before returning the bytes and
   releasing admission.

Path normalization, parent `realpath`, `O_NOFOLLOW`, before/after inode and
timestamp checks, and the immutable content index prevent traversal, symlink
escape and time-of-check/time-of-use substitution.

If clone deletion or absence confirmation fails, the request fails closed and
its admission permit remains held. An operator must reconcile the uncertain
physical resource before capacity is reused.

## Authority and network boundary

- Control Plane: object-store read authority plus the read-only materializer
  token.
- Sandbox Manager: Cube API and checkpoint-decryption authority.
- Materializer clone: the old sealed recovery authority only; no model,
  database, object-store, Kubernetes or Cube API credential.
- Pi Worker and model: no materializer credential and no ability to choose a
  snapshot ID.

The Control Plane joins the trusted `sandbox-control` network only to reach the
fixed Sandbox Manager service. The materializer token cannot reserve a Tool
Sandbox, execute Bash, inspect assignments or delete arbitrary runtimes.

## Consequences

Positive:

- large Cube-native historical versions can serve bounded file previews;
- file bytes remain hash-bound to the committed Workspace version;
- no writable Agent execution or fence transfer occurs;
- temporary readers share the global microVM capacity limit;
- the ordinary Manager credential is not widened to the public API process.

Negative:

- a cold materialization pays one Cube clone startup per request;
- only bounded regular files are currently previewable; links, special files
  and files larger than 512 KiB require a future streaming data mover;
- this does not copy Cube snapshot storage off-node and therefore does not
  satisfy the node-loss recovery gate;
- GitHub delivery of an entire large version still needs a trusted streaming
  exporter.

## Backup boundary

Kopia remains the selected portable backup technology, but it consumes a
readable file tree or stream. It must not be pointed only at Cube's local CoW
files without the matching Cube catalog/control state. The next backup slice
therefore uses a coordinated Cube export or full Cube control/data backup,
verifies a restore in an empty environment, and only then enables
reference-aware deletion of old native snapshots.

