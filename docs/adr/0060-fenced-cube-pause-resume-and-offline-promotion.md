# ADR-0060: Fenced Cube pause/resume and offline promotion

- Status: Accepted
- Date: 2026-07-26
- Extends: ADR-0031, ADR-0044, ADR-0053, ADR-0057
- Partially superseded by: ADR-0062 for ordinary Cube egress only

## Context

CubeSandbox v0.6.0 can pause a KVM microVM with its memory and filesystem and
resume it later. Reusing that state across AgentDock Runs avoids repeated guest
creation and Workspace restoration. Cube's lifecycle lock does not, however,
replace AgentDock's RunAttempt lease or writer fencing token.

The original Cube template also ran its trusted Tool service and untrusted user
commands under uid 1000. A process at the same uid can signal or inspect its
peer, so that layout cannot establish a trustworthy handoff boundary.

Cube supports outbound policy, but the ordinary Agent Tool guest must not gain
general Internet access. Dependency installation already has a narrower,
audited capability path under ADR-0044.

## Decision

### Trusted guest supervisor

The Cube template starts one root-owned, no-login AgentDock supervisor. It is
the only listener on port 49984. It accepts bounded JSON and authenticates every
mutable endpoint with a random Manager-held handoff secret, immutable binding
digest and current fencing token.

The supervisor starts the Tool Worker as uid/gid 1000. User commands inherit
uid/gid 1000 and no platform, model, Cube or handoff credential. The handoff
secret stays only in the trusted Manager and the root supervisor's memory.

### Seal and rebind

Before a warm release:

1. the current Run captures and commits the Workspace through the existing
   content-checkpoint protocol;
2. the Manager asks the supervisor to seal under the current secret and fence;
3. the supervisor stops the Tool Worker, kills every remaining uid-1000 process
   and verifies that none remain;
4. the Provider calls Cube's explicit pause endpoint and observes `paused`;
5. the Manager stores the handle only in its exact-Session warm map.

A later Run may resume only when tenant, project, Workspace, Session,
environment and Workspace revision match and its fence is strictly greater.
The Provider calls Cube connect, then rebinds with the old secret and fence.
The supervisor atomically installs the new fence and a rotated random secret,
starts a fresh uid-1000 Tool Worker attached to the preserved Workspace, and
only then becomes ready.

Every Tool operation, capture, cancellation and seal request presents the
current authority. A stale Manager/Attempt holding the previous secret fails
after rebind even if it still knows the Cube traffic token.

### Failure policy

The handoff secret is intentionally not persisted. Warm reuse is an
optimization scoped to the live Sandbox Manager. A graceful shutdown destroys
all warm VMs. An orphan found after process loss is destroyed by reconciliation
and the next Run restores the portable AgentDock checkpoint.

Any ambiguous pause, connect, rebind or guest-process cleanup destroys the
microVM. Arbitrary Bash is never replayed.

### Controlled dependency networking

This subsection records the accepted policy at the time of ADR-0060.
ADR-0062 now enables full public egress with explicit private-network denial
for ordinary Cube Tools. The sealed pause/rebind decisions in this ADR are
unchanged.

Cube Tool VMs remain `allow_internet_access=false` and
`allowPublicTraffic=false`.

When an immutable environment recipe requires dependency hosts, the Provider
uses the existing gVisor bootstrap Provider and ADR-0044 proxy. It captures the
prepared Workspace, destroys that network-capable Pod, restores the content
into a newly created offline Cube VM, and runs the recipe's verification phase
again without a network capability.

This is a promotion boundary, not a runtime fallback: all Agent Tools still run
in Cube, while gVisor performs only the disposable dependency preparation.

## Consequences

- Chat-only Runs still create no physical sandbox.
- The first Tool call pays a Cube cold start; later exact-Session Runs can pay a
  pause/connect/rebind cost instead.
- Arbitrary background user processes do not survive the Run boundary in the
  first implementation. Cube preserves platform process state, but AgentDock
  deliberately retains only Workspace state and the trusted supervisor.
- A Manager restart loses warm optimization but not committed user data.
- Native Cube domain egress is not part of the hostile-tenant trust claim.

## Acceptance

The change requires automated and live evidence for:

1. one physical Cube ID reused across two higher-fence Runs;
2. stale old-secret and old-fence operation rejection;
3. no uid-1000 process surviving seal;
4. exact-Session, environment and Workspace-revision mismatch fallback;
5. pause/connect ambiguity destroying the VM;
6. dependency setup through the capability proxy followed by an offline Cube
   verification VM;
7. two-tenant same-path isolation; and
8. a real-token multi-round Pi coding Run with lower second-Run Tool latency.
