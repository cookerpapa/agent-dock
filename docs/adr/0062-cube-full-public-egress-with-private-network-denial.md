# ADR-0062: Cube full public egress with private-network denial

- Status: Accepted
- Date: 2026-07-26
- Supersedes: the ordinary Cube offline-egress decision in ADR-0060
- Extends: ADR-0030, ADR-0042, ADR-0053, ADR-0060

## Context

AgentDock originally created every ordinary Cube Tool microVM with
`allow_internet_access=false`. Dependency installation used a separate,
capability-scoped gVisor bootstrap and promoted only regular Workspace bytes
into a fresh offline Cube guest.

The product owner now requires ordinary coding Tools to reach the public
Internet. This enables interactive dependency installation, public API probes
and development workflows that cannot be fully predicted in an immutable
environment recipe.

CubeSandbox v0.6.0 provides this policy natively. With
`allow_internet_access=true`, CubeVS permits unmatched public IPv4
destinations, while `deny_out` continues to reject selected IPv4/CIDR ranges.
Inbound public traffic is a separate setting controlled by
`allowPublicTraffic`.

General public egress materially increases data-exfiltration, supply-chain and
abuse risk. It must not create a route to AgentDock, Cube management, cloud
metadata or other private networks, and it must not make the guest's exposed
Tool service publicly unauthenticated.

## Decision

### Fixed deployment-owned policy

The sole ordinary Cube Provider uses a closed
`public_egress_private_denied` policy:

- every create request sets `allow_internet_access=true`;
- every create request sets `allowPublicTraffic=false`;
- every create request explicitly supplies a fixed `denyOut` list covering
  unspecified/current-network, RFC1918, loopback, carrier-grade NAT,
  link-local/metadata, protocol-assignment, benchmarking, documentation,
  multicast and reserved IPv4 ranges;
- no `allowOut` entry is supplied, because Cube evaluates allow entries before
  deny entries;
- browser, tenant, model and Tool arguments cannot alter this policy; and
- the per-Sandbox Cube traffic token remains mandatory for the only registered
  Tool-service port.

The current single-node AgentDock, Cube and Kubernetes management endpoints
are all inside the denied address classes. A future deployment that places a
platform endpoint on a public address must extend the deployment-owned deny
set and pass the same live gate before it is supported.

### Outbound versus inbound

This decision enables only outbound connections from Tool code to public
destinations. It does not implement Web Preview or arbitrary inbound port
publication. The registered template continues to expose only the authenticated
Tool supervisor on port 49984. A future Preview Gateway must be designed as a
separate authenticated, tenant-bound capability.

### Environment recipes

The existing exact-host dependency bootstrap remains an immutable environment
preparation path. Its process/capability promotion boundary is still useful for
reproducible operator-managed environment versions, but it is no longer a
claim that the resulting Cube guest is offline. Once the Workspace is restored,
ordinary Tool commands in that Cube guest have the same full-public policy.

Recipe command `network` fields describe how the immutable preparation step is
performed; they are not an enforcement boundary for later arbitrary Tool Bash
inside a full-public Cube activation.

### Security claim

The supported claim becomes:

> Untrusted Tool code can reach public IPv4 Internet destinations but receives
> no platform credential and cannot route to the explicitly denied
> private/link-local/metadata/platform address classes.

This is not a data-loss-prevention claim. A malicious prompt or repository can
send Workspace bytes to an arbitrary public host. Public anonymous hostile
tenants, egress billing/abuse controls and destination-level audit remain
outside the current private-deployment claim.

## Failure behavior

- Cube creation fails closed if the full-public policy cannot be encoded.
- Missing private-ingress traffic token destroys the new microVM.
- A live gate failure to reach the public acceptance endpoint blocks release.
- A live gate success against any denied platform/private endpoint blocks
  release.
- Lease, fencing, cancellation, checkpoint and sealed pause/rebind behavior are
  unchanged.

## Consequences

- Agent-selected `npm install`, `pip install`, `git fetch`, `curl` and public
  Web/API probes can work during a Tool Run.
- Public egress increases exfiltration and supply-chain risk and must be
  presented honestly in the threat model and UI.
- Model/provider/database/object-store/Cube credentials remain absent from the
  guest, limiting what can be exfiltrated to untrusted Workspace and prompt
  data already available to the Tool.
- Cube's private-ingress token still protects port 49984; no Web application
  preview becomes reachable as a side effect.

## Acceptance

The change requires:

1. request-shape tests for `allow_internet_access=true`,
   `allowPublicTraffic=false` and the exact `denyOut` set;
2. Provider evidence reporting `public_egress_private_denied`;
3. a real KVM guest reaching a stable public HTTPS endpoint;
4. the same guest failing to reach CubeAPI, Control Plane/database-class
   endpoints and `169.254.169.254`;
5. unchanged private Tool ingress-token enforcement, two-tenant Workspace
   isolation, cancellation, sealed handoff and zero-orphan cleanup; and
6. updated architecture, network matrix, threat model, production runbook and
   release evidence.
