# ADR-0053: CubeSandbox as the primary Tool execution plane

- Status: accepted for self-hosted production
- Date: 2026-07-25
- Extends: ADR-0029, ADR-0030, ADR-0031, ADR-0050

## Context

AgentDock separates the trusted Pi SDK runtime from untrusted Tool execution.
Tencent CubeSandbox supplies a complete KVM execution plane rather than only a
queue: CubeAPI, CubeMaster, Cubelet, CubeShim/VMM, CubeProxy and Cube egress
components create and route microVM Sandboxes.

The platform needs one supported execution path with a stronger boundary than a
shared-kernel container, while keeping tenant, Run, credential and Workspace
authority outside Cube.

## Decision

CubeSandbox is the sole production Tool runtime:

```text
Browser / REST / SSE
        -> Control Plane / PostgreSQL ready queue
        -> trusted Pi Worker pool
        -> authenticated Tool RPC
        -> trusted Sandbox Manager
        -> private CubeAPI
        -> CubeMaster / Cubelet / KVM microVM
```

1. Cube owns physical placement and lifecycle. AgentDock owns tenants, Sessions,
   Runs/Attempts, leases, fences, Tool replay policy and terminal commits.
2. Pi, provider credentials, PostgreSQL credentials and conversation state
   remain outside Cube. The guest contains only fixed
   toolchains and its assigned `/workspace`.
3. CubeAPI is private and protected through its upstream authorization callback
   using an AgentDock-owned constant-time authorizer. The trusted Manager has
   only the closed management permissions it requires.
4. Chat-only Runs do not create a microVM. The first Tool call activates Cube;
   ADR-0068 governs exact-Session warm retention, rebinding and idle cleanup.
5. The Cube Volume Plugin supplies the persistent POSIX Workspace. PostgreSQL
   CAS/fencing commits its immutable Volume reference and Workspace head as
   defined by ADR-0072 and ADR-0101; no per-Run Workspace copy is made.
6. Public guest egress is mediated by the fixed Cube egress gateway in ADR-0063;
   platform/private destinations and metadata remain denied.
7. Repository acquisition for the default product happens as ordinary Tool work
   inside Cube through that governed egress path. There is no gVisor importer or
   alternate Tool runtime fallback.
8. The model and tenant cannot choose Cube templates, native IDs, mounts,
   management endpoints, network shape or resource ceilings.
9. Cancellation, ambiguous Tool completion, stale fence, failed checkpoint and
   reconciliation uncertainty fail closed and destroy the exact activation.

## Consequences

- The user-facing Agent Loop remains independent of Cube implementation details.
- Untrusted code receives a KVM boundary without receiving platform authority.
- A single-node workstation deployment validates the architecture but is not
  multi-node disaster recovery; production scale requires external durable
  services and multiple Cube compute nodes.
- Adding another execution runtime is a future migration, not compatibility
  code in the current product.
