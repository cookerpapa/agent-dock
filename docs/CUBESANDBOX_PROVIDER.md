# Experimental CubeSandbox Provider

## Research conclusion

The evaluated upstream is TencentCloud/CubeSandbox v0.6.0. Cube is a
RustVMM/KVM sandbox platform with its own API, scheduler, compute agent,
hypervisor, proxy, networking and snapshot layers. Its Kubernetes chart deploys
those components; it does not make Cube available as another
`runtimeClassName` for ordinary AgentDock Pods.

The useful integration is therefore:

```text
AgentDock SandboxProvider API
        ├── KubernetesGvisorSandboxProvider (default)
        └── CubeSandboxProvider (operator-only experiment)
```

See ADR-0052 for the decision and
[`deploy/cubesandbox/README.md`](../deploy/cubesandbox/README.md) for the
operator path.

## Comparison

| Property | Kubernetes + gVisor | CubeSandbox experiment |
| --- | --- | --- |
| Runtime boundary | runsc userspace application kernel | independent KVM guest kernel |
| Orchestrator | Kubernetes Pod + RuntimeClass | CubeAPI/CubeMaster/Cubelet |
| AgentDock status | supported and live-validated | opt-in, not live-validated here |
| Root filesystem | read-only OCI rootfs | writable disposable guest CoW rootfs |
| Workspace durability | AgentDock content checkpoint | same AgentDock content checkpoint |
| Exact-Session warm rebind | UID/resourceVersion + higher fence | disabled until metadata CAS is proved |
| Tool network | Kubernetes default deny | Cube create request forces Internet/public deny |
| Repository import | signed-capability gVisor importer | same importer in first version |
| Dependency setup | disposable networked bootstrap then fresh offline Pod | rejected in first version |
| Native snapshot | not required | optional future optimization, never commit authority |

## Provider path

`CubeSandboxProvider` implements the existing Provider-neutral operations:

- health/probe;
- create and immutable handle construction;
- bash/read/write/edit through the existing Tool Worker;
- cancellation;
- content snapshot;
- inspect, inventory, stop/destroy and orphan cleanup.

The implementation uses a minimal, bounded client for the official v0.6 REST
contract. The upstream Node SDK source exists but was not published under the
declared npm package at the time of this experiment, so this branch does not
pretend that an unavailable dependency is installable. The client is isolated
behind `CubeSandboxRuntimeClient`, which can be replaced with an official
published SDK later without changing Pi or the Manager contract.

Management requests use a private bearer token loaded from a mode-0600 file.
Data requests use Cube's per-sandbox private traffic token and virtual host.
Responses, request paths, IDs and metadata are bounded before entering
AgentDock.

## Identity and fencing

Cube metadata binds:

```text
activation
tenant / project / workspace
Supervisor / boot / logical sandbox / command
Session / Turn / Attempt
lease / fencing token
AgentDock image revision
```

The public AgentDock runtime ID is a deterministic UUID hash of Cube's native
sandbox ID; the native ID remains a trusted Provider detail. Before each Tool
operation, the Provider re-reads the instance and verifies the full assignment.
A used operation/capture ID is rejected. A transport failure after command
start destroys the VM and produces an unknown result rather than replaying an
arbitrary side effect.

Cube does not currently provide the online metadata compare-and-swap required
for AgentDock's higher-fence warm rebind. A Cube activation is consequently
disposed at the Run boundary. This is slower but correct.

## Network and credential boundary

The create body always contains:

```json
{
  "allow_internet_access": false,
  "network": {
    "allowPublicTraffic": false
  }
}
```

The Tool VM receives no model credential, database URL, object-store key,
Kubernetes credential, CubeAPI key or GitHub token. Port 49984 is reachable only
through CubeProxy using the returned traffic token. CubeAPI itself must use an
API key or authentication callback plus private network/firewall placement;
upstream documentation says its default configuration accepts requests without
authentication. The supplied runbook uses the simple-key mode backed by a
Kubernetes Secret.

In the Compose product plane:

```text
sandbox-manager (internal networks only)
    ├── cube-api-relay   ── fixed private CubeAPI host:port
    └── cube-proxy-relay ── fixed private CubeProxy host:port
```

The relays have no credentials and cannot dial a destination selected by a
request. The CubeAPI bearer key remains only in the Manager.

## Template contract

The template is based on the pinned Cube base image but deliberately replaces
its inherited entrypoint. Root `envd` is not started because it would expose a
second command/file path outside AgentDock's Tool Broker. The sole service on
49984 starts the existing Tool Worker as uid/gid 1000 with no new privileges,
zero effective capabilities, a 128-process limit and a 1024-file limit. It
includes:

```text
Node 24
Java 17
Python 3.11
Git 2
```

The Cube template registration exposes only port 49984 and the probe must
target `49984 /health`. The base image's inherited OCI metadata still declares
49983, so the compatibility gate verifies that the port is unreachable and no
unmediated command daemon was started.

## What is and is not proven on this machine

Proven:

- Provider control/data request shape and private traffic-token routing;
- metadata identity, fencing and replay checks;
- Manager lifecycle, capture and no-warm semantics;
- exact Tool image versions;
- actual file write, Python execution, traversal rejection and content-hashed
  checkpoint through the template service;
- fixed-target control/data relays.

Not proven:

- that a real Cubelet started the image under the Cube KVM hypervisor;
- guest/host or cross-microVM isolation;
- Cube network denial and resource accounting;
- cancellation/orphan cleanup during real node/control-plane failure;
- production latency and density.

Those claims require the dedicated-cluster live gate in ADR-0052.

## Upstream evidence reviewed

This evaluation used the tagged v0.6.0 source at commit
`8721dd151971ce3c2966482bbd32904ad98f378e`, not only the project landing
page:

- [CubeSandbox repository and release source](https://github.com/TencentCloud/CubeSandbox/tree/v0.6.0);
- [Kubernetes architecture](https://cubesandbox.com/guide/kubernetes/architecture)
  and [installation requirements](https://cubesandbox.com/guide/kubernetes/install);
- [management-plane authentication](https://cubesandbox.com/guide/authentication);
- [template-from-image workflow](https://cubesandbox.com/guide/tutorials/template-from-image);
- the in-tree [Node SDK source](https://github.com/TencentCloud/CubeSandbox/tree/v0.6.0/sdk/node)
  and [Pi integration example](https://github.com/TencentCloud/CubeSandbox/tree/v0.6.0/examples/pi-agent-integration).

Before promoting native snapshot/rollback to a durability primitive, reproduce
and close the failure modes represented by upstream issue
[#804](https://github.com/TencentCloud/CubeSandbox/issues/804),
[#985](https://github.com/TencentCloud/CubeSandbox/issues/985) and
[#1105](https://github.com/TencentCloud/CubeSandbox/issues/1105). The experiment
therefore treats a Cube VM as disposable and keeps AgentDock's external,
content-verified checkpoint commit as the source of truth.
