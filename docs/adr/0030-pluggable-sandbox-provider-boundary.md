# ADR-0030: Internal Sandbox Provider boundary

- Status: accepted, amended for the Cube-only product
- Date: 2026-07-20
- Extends: ADR-0029

## Context

Authorization, Tool RPC and durable Run semantics must not depend on a vendor
SDK. At the same time, exposing runtime selection to users would allow a request
to choose a weaker boundary and would keep retired implementations alive.

## Decision

1. `ToolSandboxManager` owns activation IDs, capability digests, authorization,
   lease/fence validation and the stable Tool-facing contract.
2. The internal `SandboxProvider` seam owns physical create, inspect, operation,
   checkpoint integration, stop/destroy and orphan inventory.
3. `CubeSandboxProvider` is the only production implementation. There is no
   runtime selector and no Docker/gVisor compatibility fallback.
4. Provider handles are opaque and bound to tenant, Workspace, Session,
   RunAttempt, activation and fencing identity. Pi and browsers never receive a
   Cube-native sandbox ID as authority.
5. Deployment policy fixes the Cube template, resource ceilings, Volume Plugin,
   egress route and trusted service endpoints. Callers cannot inject images,
   host paths, runtime flags, network rules or management credentials.
6. Revocation happens before teardown. Cleanup and reconciliation confirm the
   exact physical generation before removing it.
7. A future runtime requires a new ADR, full contract/security tests and a
   deliberate cutover. Implementing the TypeScript interface alone is not a
   supported-runtime claim.

## Consequences

- Trusted Agent code depends on a small stable boundary rather than Cube APIs.
- The current product has one clear security posture and deployment path.
- Provider neutrality remains an internal design property, not user-visible
  configurability or legacy compatibility.
