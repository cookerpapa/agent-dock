# ADR-0045: Single-consumption clean gVisor prewarming

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0039, ADR-0040, ADR-0043

## Context

Demand activation keeps pure chat free of execution resources, but the first
Tool Call in a coding Session still pays Kubernetes scheduling, containerd
image preparation, `runsc` startup and worker-process startup. Exact-Session
warm reuse removes this cost from later Runs, not from the first coding Run.

Recycling a Pod that previously executed tenant code would create a
cross-tenant residual-state boundary that cannot be justified by deleting a
few files. Any shared pool must therefore contain only runtimes that have never
received tenant identity, Workspace content, recipe commands, capabilities or
secrets.

## Decision

The Kubernetes gVisor Provider may maintain a small operator-configured pool of
clean Pods for its one fixed Tool image and image revision. Production defaults
to two Pods with a five-minute claim TTL.

A clean prewarm Pod:

- is labelled `workload=clean-prewarm`, not `tool-sandbox`;
- has only a random prewarm ID and fixed image/policy metadata;
- has no tenant, Project, Workspace, Session, Run, Attempt, lease, fence or
  sandbox hash;
- has empty memory-backed Workspace and temporary volumes;
- has default-deny networking, no DNS, no ServiceAccount token, a read-only
  root, no capabilities or host namespace/mount/socket;
- runs the fixed Tool Worker waiting for its first trusted initialization
  message; and
- is inspected through a trusted `uname` probe to prove the `runsc` boundary
  before entering the pool.

The first eligible offline activation atomically removes one Pod from the
in-memory pool, then replaces its metadata under Pod UID and resourceVersion
preconditions with the exact assignment and `workload=tool-sandbox`. Only after
that irreversible claim does the Manager attach, restore the Workspace,
validate the image/toolchain and execute the recipe. A missing, stale or
mismatched Pod is destroyed and cannot be returned to the pool.

Dependency bootstrap Pods are never taken from this pool because they require
a different network selector. The fresh offline Pod created after dependency
setup may consume a clean prewarm. Once any Pod is claimed, it may remain warm
only for the exact Session under the existing higher-fence protocol or be
destroyed. It is never sanitized or reintroduced into the shared pool.

The Pod active deadline is fixed at clean-pool TTL plus a complete Turn budget,
so a Pod claimed at the end of its permitted pool lifetime still has the same
minimum execution window. A periodic reconciler expires unused Pods and
restores the target count. Manager shutdown deletes tracked clean Pods;
startup deletes clean or dependency-bootstrap Pods orphaned by the previous
singleton Manager process before accepting traffic.

## Failure and deployment behavior

- Prewarming is an optimization. A temporarily empty pool creates a fresh Pod
  with the identical security policy; it never falls back to another runtime,
  image or network mode.
- Claim is single-consumption even when initialization later fails. Failure
  deletes the UID-fenced Pod.
- Clean Pods never appear in Supervisor assignment inventory because that
  inventory selects only `workload=tool-sandbox` plus the Supervisor sandbox
  hash.
- The current deployment intentionally runs one Sandbox Manager replica. A
  future highly available Manager requires leader/lease ownership for pool
  reconciliation before increasing this replica count.
- `agent_dock_sandbox_prewarm` reports the current clean pool separately from
  active and exact-Session warm Sandboxes.

## Evidence

The live K3s/runsc test observes a tenant-free clean Pod, claims the same Pod
name and UID for one exact tenant/Attempt, verifies that the prewarm annotation
is removed, executes an offline Node command and confirms gVisor/default-deny
isolation. The used Pod is deleted, never returned to the pool, while a new
clean Pod replenishes the target.

On the 2026-07-22 local KVM/runsc gate, first Tool completion from a ready clean
Pod measured 2,260 ms versus 4,073 ms from a fresh Pod using the same already
cached image and command. These are environment-specific acceptance data, not
a universal latency claim.
