# ADR-0052: CubeSandbox KVM microVM Provider experiment

- Status: Proposed / experimental
- Date: 2026-07-24
- Extends: ADR-0030, ADR-0031, ADR-0032, ADR-0039, ADR-0040

## Context

The supported AgentDock execution plane uses Kubernetes RuntimeClass and
gVisor/runsc. It has passed the repository's live isolation, recovery and
production gates. CubeSandbox v0.6.0 is a different kind of system: a
standalone sandbox control/data plane whose CubeAPI and CubeMaster schedule KVM
microVMs through Cubelet, CubeShim and the RustVMM-based hypervisor. It is not a
replacement `RuntimeClass` that can be assigned to the existing Tool Pod.

Cube is attractive for a future hostile-code boundary because each sandbox has
an independent guest kernel, a disposable copy-on-write root filesystem,
private-ingress traffic capabilities, snapshot/rollback primitives and a
purpose-built high-density lifecycle. Its Kubernetes/Helm delivery is currently
documented upstream as Preview. It also requires privileged host preparation,
KVM/PVM, dedicated compute placement and XFS-backed `/data/cubelet`; compute
upgrades can interrupt active sandboxes.

Installing that chart into AgentDock's current single-node production K3s would
mutate the same host, compete with the proven runsc execution plane and make an
experiment capable of interrupting the working product. The experiment
therefore needs a separate Provider and a separate Cube cluster or dedicated
compute nodes.

## Decision

Add an operator-only, opt-in `CubeSandboxProvider` behind the existing
`SandboxProvider` contract. `kubernetes-gvisor` remains the default and the only
supported production Provider until the Cube live gate is complete. Browser,
tenant, prompt, model and Pi inputs cannot select a Provider or provide a Cube
template/runtime identifier.

```text
Trusted Pi Runner
    |
    | existing capability-scoped Tool RPC
    v
ToolSandboxManager
    |
    | Provider-neutral handle + assignment/fence
    v
CubeSandboxProvider
    |                         |
    | CubeAPI management      | CubeProxy private data path
    v                         v
CubeAPI -> CubeMaster      traffic token -> port 49984
              |
              v
        Cubelet / CubeShim
              |
              v
       per-activation KVM microVM
       ├── AgentDock Tool Worker (uid 1000)
       ├── /workspace
       ├── bash/edit/git/test
       ├── no platform/model credential
       └── deny-all outbound network
```

Pi, model credentials, conversation state, database credentials, Kubernetes
credentials and object-store credentials stay outside Cube. The custom Cube
template contains only the existing AgentDock Tool Worker plus fixed Node 24,
Java 17, Python 3.11 and Git 2 tools. The service bridges the closed AgentDock
operation/capture protocol over port 49984. It replaces the base image
entrypoint and does not start root `envd`; otherwise untrusted code could reach
a second command/file daemon without passing through the Tool Broker.

Every Cube create request fixes:

- the operator-owned template ID;
- `allow_internet_access = false`;
- `network.allowPublicTraffic = false`;
- bounded lifetime;
- full tenant/project/workspace/session/turn/Attempt/lease/fence metadata.

The Provider requires the returned private-ingress traffic token. It validates
image revision, guest resources, uid/gid 1000, hypervisor evidence,
`NoNewPrivs`, empty effective capability set and the exact Tool environment
before returning a handle. Every operation re-reads Cube inventory and checks
the assignment metadata. The model never receives the traffic token, native
Cube sandbox ID, CubeAPI credential or network address.

The trusted Compose plane reaches Cube through two credential-free,
fixed-upstream TCP relays: one for CubeAPI and one for CubeProxy. The Manager
stays on internal networks. Only the relays join an egress bridge and neither
accepts a request-selected destination.

## Deliberate first-version limits

### No warm reassignment

> Historical first-promotion limit. ADR-0060 supersedes this limit with a
> sealed exact-Session pause/connect protocol; cross-identity reassignment
> remains forbidden.

AgentDock warm reuse requires an atomic metadata rebind to a higher writer
fence. The evaluated Cube API does not expose a sufficiently strong online
compare-and-swap for all assignment metadata. `supportsWarmRebind` is therefore
false: a completed Run destroys its Cube microVM even when the Manager receives
`keep_warm`. A future implementation may enable exact-Session reuse only after
the live API can prove stale-worker fencing.

### External checkpoints remain authoritative

Cube native pause/snapshot/rollback is not the durable AgentDock commit. Tool
capture still creates the bounded, content-hashed Workspace manifest that is
committed through object storage and PostgreSQL CAS. Cube snapshots may later
optimize cold start or candidate cloning, but a lost Cube cluster must remain
recoverable from AgentDock artifacts.

### No dependency egress inside the Tool VM

> ADR-0060 retains the offline Tool-VM rule and adds a disposable gVisor
> dependency bootstrap whose regular-file snapshot is promoted into a new
> offline Cube guest.

The first Provider accepts only the final deny-all Tool policy. It rejects an
environment recipe that asks for dependency hosts because the experiment has
not yet proved an atomic transition from temporary Cube egress to a
never-networked runtime identity.

### Repository import stays on the proven gVisor importer

Exact-commit GitHub import remains a separate credential-free gVisor workload
with its existing signed egress capability. The Cube Tool VM never receives
GitHub network access or a token. The Cube deployment therefore does not remove
the current scoped Kubernetes importer plane.

### No blind command replay

If the Cube data connection fails after an arbitrary Tool command may have
started, the Provider marks the result unknown, destroys the microVM and does
not retry the command. Run scheduling remains at-least-once with fenced
commits; arbitrary Bash is not described as exactly once.

## Acceptance before promotion

The experiment cannot become the production default until a dedicated Cube
v0.6 cluster passes all of the following:

1. a real CubeAPI health and private-template probe;
2. guest-kernel/KVM attestation that is not derived from Docker/runc;
3. two-tenant filesystem and runtime isolation;
4. no model/platform/Kubernetes/object-store credential in guest environment or
   `/proc`;
5. no Internet, platform service, host gateway, Docker socket or cross-sandbox
   access;
6. resource, timeout, output, path traversal and symlink controls;
7. cancellation that terminates the complete guest execution;
8. Run failure/restart/orphan reconciliation without a leaked VM;
9. content checkpoint, cold restore and two-round real Pi coding;
10. measured p50/p95 create, first-Tool, execution and destroy latency;
11. Cube control/compute upgrade and node-loss failure drills;
12. security review of CubeAPI authentication, private network
    exposure and release pinning.

The local `cubesandbox:template-check` intentionally reports
`isolationValidated: false`. It proves image/tool protocol compatibility in an
ordinary Docker container and cannot satisfy the KVM gate.

## Consequences

This experiment preserves the trusted/untrusted split and makes the security
boundary stronger without rewriting Pi or the durable Run protocol. It also
adds a second operational system—CubeAPI, CubeMaster, CubeProxy, Cubelet,
database/cache and compute storage—so the burden of upgrades, metrics,
capacity, backup and incident response increases.

The branch is useful even if Cube is not promoted: it proves that
`SandboxProvider` is a real portability seam and documents the exact semantic
gaps between an OCI RuntimeClass Provider and a microVM service Provider.
