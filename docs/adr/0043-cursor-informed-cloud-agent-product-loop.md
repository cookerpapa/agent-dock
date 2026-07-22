# ADR-0043: Cursor-informed Cloud Agent product loop

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0031, ADR-0032, ADR-0039, ADR-0040, ADR-0042

## Context

AgentDock already separates durable conversation, Workspace and physical
Sandbox state; uses demand-activated exact-Session gVisor Pods; and persists
fenced RunAttempt history. Official Cursor engineering articles published in
2026 provide useful independent evidence that environment quality, durable
task execution, independent state lifecycles, controlled networking,
self-diagnosis, and review artifacts are central Cloud Agent product concerns.

The remaining gap is not another Agent loop. It is the product loop around that
runtime: describe and validate an environment, execute work across exact source
repositories, recover and explain attempts, and hand a reviewer complete,
immutable evidence.

The source analysis and adoption rationale are recorded in
[`../research/2026-07-22-cursor-cloud-agent-lessons.md`](../research/2026-07-22-cursor-cloud-agent-lessons.md).

## Decision

AgentDock adds a dependency-ordered Cloud Agent product milestone with these
bounded capabilities:

1. versioned, declarative workspace setup/verification configuration;
2. owner-controlled environment activation and rollback with CAS and audit;
3. deterministic diagnosis plus fresh-gVisor validation and repair proposals;
4. several exact-commit repositories under disjoint Workspace roots;
5. per-environment dependency egress through a policy-enforcing proxy;
6. optional never-used clean Sandbox prewarming;
7. explicit Attempt supersession/rewind projection; and
8. immutable, safe Review Bundles plus reproducible Helm execution-plane
   packaging.

## Security invariants

- Environment configuration controls commands inside the untrusted Sandbox. It
  cannot control image, RuntimeClass, PodSpec, namespace, ServiceAccount,
  resource ceilings, host mounts, or platform networks.
- A proposed environment version is inert until a tenant owner activates it
  with the expected current version. A failed version cannot become active.
- The Tool Sandbox receives no long-lived platform/provider/GitHub/object-store
  credential. Dependency access is a proxy capability, not general network
  membership.
- Repository roots are normalized platform identifiers. Content extraction and
  path access remain beneath the assigned root after symlink resolution.
- A clean prewarm Pod is single-consumption. Once bound to tenant data it can
  only remain warm for the exact Session or be destroyed.
- Events and Attempts remain append-only. Rewind changes the canonical
  projection, never deletes evidence.
- Review artifacts contain escaped/bounded data or opaque authenticated
  downloads; no untrusted active HTML is rendered.

## Durability rules

- Environment activation and rollback use expected-current CAS and one audit
  transaction.
- Each Run retains the environment and repository-set snapshot accepted with
  it even if the Project changes later.
- Network policy, environment validation, Tool execution, Workspace commit and
  Review Bundle creation are fenced by the current RunAttempt.
- Proxy requests and shell commands retain at-most-once-start caution; an
  ambiguous side effect is not blindly retried.
- A replacement Attempt emits an explicit supersession boundary. Terminal
  canonical conversation and Workspace pointers advance only from the current
  committed Attempt.

## Exclusions

- No Temporal migration: existing task-scoped PostgreSQL protocols already own
  these semantics and have failure evidence.
- No silent base-image fallback.
- No arbitrary Agent-selected Dockerfile or image build in a trusted service.
- No cross-tenant reuse of a Pod that executed code.
- No browser/VNC/desktop or multi-agent feature is introduced by this ADR.

## Consequences

The environment becomes an auditable product resource rather than an implicit
image label. Coding tasks can span several repositories and controlled package
sources, operators can improve cold starts without weakening tenancy, retries
become understandable to users, and completed work has a reviewable evidence
surface. The implementation cost is additional schema, APIs, a network
enforcement service, lifecycle reconciliation and broader production tests.

## Implementation status

- Environment configuration, validation, activation and rollback are complete.
- Exact-commit multi-repository Workspaces and immutable Run source-set
  snapshots are complete. Public and tenant-allowlisted GitHub App sources may
  be combined under 2–8 unique top-level roots. Root-aware multi-repository PR
  delivery remains intentionally unavailable until a patch can be mapped to an
  explicit destination repository without ambiguity.
- Controlled dependency egress, clean prewarming, Attempt rewind/Review
  Bundles and Helm acceptance remain subsequent dependency-ordered work.
