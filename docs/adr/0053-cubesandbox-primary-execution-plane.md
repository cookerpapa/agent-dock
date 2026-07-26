# ADR-0053: CubeSandbox as the primary Tool execution plane

- Status: Accepted for self-hosted validation
- Date: 2026-07-25
- Supersedes: ADR-0038 for Agent Tool execution
- Promotes: ADR-0052
- Extends: ADR-0029, ADR-0030, ADR-0031, ADR-0050

## Context

AgentDock already separates the trusted Pi runtime from untrusted Tool
execution. The browser and control plane persist a user message and schedule a
Run; a bounded pool of trusted Workers restores Pi conversation state, performs
model calls and owns the Agent Loop. `read`, `write`, `edit`, `bash`, Git and
test execution cross the authenticated Tool Broker boundary.

ADR-0052 proved that this provider-neutral boundary can target Tencent
CubeSandbox v0.6.0. Cube is not merely a queue and it is not a Kubernetes
`RuntimeClass`. Its official architecture is a complete sandbox execution
plane:

- CubeAPI exposes the E2B-compatible management API;
- CubeMaster schedules sandboxes and coordinates cluster state;
- Cubelet manages sandbox lifecycle on each compute node;
- CubeShim and the Rust VMM create KVM microVMs;
- CubeProxy routes capability-protected traffic to an individual sandbox;
- CubeEgress applies outbound policy and credential injection where enabled.

The earlier experiment kept gVisor as the supported Tool Provider. The operator
has now selected Cube as the primary Agent Tool runtime. The trust split must
not move: Pi, model credentials, PostgreSQL, object-store credentials and
conversation state remain outside Cube.

CubeAPI accepts management requests without authentication by default.
Upstream v0.6.0 does not implement a static `CUBE_API_KEY` check. It delegates
authorization to `AUTH_CALLBACK_URL`, forwarding the credential plus the
original path and method. Treating an arbitrary environment variable as
authentication would leave the control plane open.

## Decision

Promote `CubeSandboxProvider` to the default Tool execution Provider in the
self-hosted product:

```text
Browser / REST / SSE
        |
        v
AgentDock Control Plane
        |
        | durable Run / Attempt / lease / fence
        v
Trusted Pi Worker pool
        |
        | narrow authenticated Tool RPC
        v
Trusted Sandbox Manager
        |
        | bearer-authenticated private CubeAPI
        v
CubeAPI -> CubeMaster -> Cubelet -> KVM microVM
                                  |
                                  `- credential-free Tool service :49984
```

Cube owns physical sandbox placement and lifecycle. AgentDock continues to own
tenant authorization, logical Session/Run state, fencing, command replay
policy, content checkpoints and terminal commit semantics. A model, browser
user or tenant cannot choose a Provider, template, native sandbox ID, network
policy or resource shape.

Chat-only Runs reserve a logical Tool lease but create no microVM. The first
real Tool call activates a Cube microVM. Because v0.6.0 does not expose the
metadata compare-and-swap needed to atomically bind a live VM to a later
Attempt/fence, the first promoted version destroys the VM at the Run boundary
instead of claiming unsafe warm reassignment. AgentDock checkpoints restore the
next activation.

ADR-0060 supersedes only that first-version lifecycle restriction. Cube's
pause/connect API is now wrapped by an AgentDock-owned sealed handoff, higher
fence and rotating secret; Cube itself still does not become the business-state
or fencing authority.

The existing Kubernetes gVisor runtime remains temporarily available only to
the separately constrained exact-commit public-repository importer. It is not
an Agent Tool execution fallback. Removing that importer dependency requires a
separate, live-validated Cube import/egress design and is not achieved by
silently giving the offline Tool VM Internet access.

## CubeAPI authentication

Deploy a small AgentDock-owned authorizer beside the Cube control plane. It:

1. reads one random bearer credential from a private Kubernetes Secret;
2. compares credentials in constant time;
3. validates both `X-Request-Path` and `X-Request-Method`;
4. permits only the sandbox create/read/list/delete operations used by the
   trusted Provider;
5. exposes no mutation or template-management wildcard;
6. has no ServiceAccount token, writable root filesystem or egress.

CubeAPI receives:

```text
AUTH_CALLBACK_URL=http://agent-dock-cube-api-authorizer:8080/verify
```

CubeAPI and CubeProxy remain private `ClusterIP` Services. The trusted Compose
plane reaches their fixed private addresses through destination-fixed,
credential-free TCP relays. CubeMaster, Cubelet, MySQL, Redis and proxy admin
ports are never exposed through an Ingress or NodePort.

## Local K3s profile

The current workstation is a single-node validation environment, not the
recommended production topology. The install profile therefore:

- labels the node for both control and compute without adding role taints that
  would disrupt existing workloads;
- disables PVM host-kernel bootstrap and PVM guest mode;
- never installs a host kernel and never requests a reboot;
- uses the existing `/dev/kvm`;
- uses the upstream loopback XFS data volume for local validation;
- disables Cube WebUI/CubeOps and public Ingress;
- disables Cube's CoreDNS mutation because AgentDock routes CubeProxy by a fixed
  address while preserving the virtual Host header;
- keeps CubeEgress enabled and every Agent Tool VM deny-all by default.

On WSL, K3s receives its stable `/32` node address through a dedicated
`agentdock0` dummy interface with MTU 1500. Flannel and Pod MTU must both be
1450. Binding Flannel to the 65536-byte loopback interface is rejected: it
advertises an unusable jumbo MSS and black-holes ordinary responses between
CubeProxy and CubeNode once they exceed the physical path MTU.

This profile must not be described as a multi-node production deployment.
Production requires dedicated control and compute nodes, dedicated XFS
storage, private routing/firewalls and repeatable node-loss/upgrade drills.

## Durability and failure behavior

Cube native pause, snapshot and rollback are execution optimizations, not the
canonical Workspace commit. A successful Tool Run still:

1. captures a bounded content manifest through the AgentDock Tool protocol;
2. uploads the immutable blob to object storage;
3. commits the Workspace revision and conversation result under the current
   RunAttempt and fencing token;
4. only then reaches a terminal completed state.

If Cube control/data transport fails after arbitrary Bash may have started, the
operation becomes unknown, the VM is destroyed and the command is not blindly
replayed. A lost Cube cluster remains recoverable from the last committed
AgentDock checkpoint.

## Acceptance

Cube becomes the running default only after the exact v0.6.0 deployment passes:

1. authenticated CubeAPI allow/deny tests, including path-plus-method denial;
2. a real KVM guest/runtime evidence probe;
3. two-tenant same-path filesystem isolation;
4. model/platform/Kubernetes/Cube credential absence in the guest;
5. public, host, control-plane, database and cross-sandbox network denial;
6. traversal, symlink, output, process, memory and timeout limits;
7. cancellation and exact orphan cleanup;
8. content checkpoint and cold restore;
9. chat-only execution with zero Cube microVM creation;
10. two real Pi/model Tool Runs, including a same-Session Workspace restore;
11. sanitized latency and resource evidence.

Failure of any gate keeps the currently running product on its last validated
configuration; it must not be hidden by falling back to local process or
ordinary Docker execution.

## Consequences

The selected trust boundary matches the desired cloud-agent architecture:
Worker density is governed by the trusted Pi pool, while untrusted code density
and placement are delegated to Cube. AgentDock gains an independent guest
kernel and purpose-built snapshot/networking primitives without moving model
credentials into a sandbox.

The cost is operational: Cube adds its own scheduler, database, cache, proxy,
compute daemon, XFS storage and upgrade lifecycle. A one-node WSL deployment
can prove the integration and KVM path but cannot prove production
availability, node isolation or capacity.
