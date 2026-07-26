# Primary CubeSandbox Provider

## Research conclusion

The evaluated upstream is TencentCloud/CubeSandbox v0.6.0. Cube is a
RustVMM/KVM sandbox platform with its own API, scheduler, compute agent,
hypervisor, proxy, networking and snapshot layers. Its Kubernetes chart deploys
those components; it does not make Cube available as another
`runtimeClassName` for ordinary AgentDock Pods.

The useful integration is therefore:

```text
Trusted Pi Worker pool
        │ narrow Tool RPC
        ▼
AgentDock Sandbox Manager
        ├── CubeSandboxProvider (ordinary Tool execution)
        └── Kubernetes/gVisor bootstrap/import
            (capability-scoped acquisition and dependency setup only)
                │
                ▼
CubeAPI -> CubeMaster -> Cubelet -> CubeShim/KVM
```

The upstream Pi example places Pi itself inside Cube. AgentDock deliberately
does not copy that placement: Pi, model authentication and durable conversation
state remain trusted; only the untrusted Tool Worker and Workspace enter the
guest.

See ADR-0052 for the evaluation, ADR-0053 for the promotion decision, and
[`deploy/cubesandbox/README.md`](../deploy/cubesandbox/README.md) for the
operator path.

## Comparison

| Property | Retained Kubernetes + gVisor path | Primary CubeSandbox path |
| --- | --- | --- |
| Runtime boundary | runsc userspace application kernel | independent KVM guest kernel |
| Orchestrator | Kubernetes Pod + RuntimeClass | CubeAPI/CubeMaster/Cubelet |
| AgentDock status | importer and deterministic regression only | ordinary Tool execution, live KVM validated |
| Root filesystem | read-only OCI rootfs | writable disposable guest CoW rootfs |
| Workspace durability | AgentDock portable content manifest | Cube Volume Plugin + POSIX Workspace + trusted Kopia snapshot |
| Exact-Session warm rebind | implemented in former Tool Provider | sealed pause/connect/rebind with higher AgentDock fence |
| Tool network | Kubernetes default deny | one trusted web gateway; every direct route denied |
| Repository import | signed-capability gVisor importer | delegates to that importer |
| Dependency setup | disposable exact-host bootstrap | promotes regular files into a proxy-mediated Cube VM |
| Native snapshot | not required | legacy restore only; new checkpoints use ADR-0067 Kopia references |

## Provider path

`CubeSandboxProvider` implements the existing Provider-neutral operations:

- health/probe;
- create and immutable handle construction;
- bash/read/write/edit through the existing Tool Worker;
- cancellation;
- sealed content-index capture plus trusted Kopia snapshot;
- inspect, inventory, stop/destroy and orphan cleanup.

The implementation uses a minimal, bounded client for the official v0.6 REST
contract. The upstream Node SDK source exists but was not published under the
declared npm package at the time of integration, so AgentDock does not
pretend that an unavailable dependency is installable. The client is isolated
behind `CubeSandboxRuntimeClient`, which can be replaced with an official
published SDK later without changing Pi or the Manager contract.

Management requests use a private bearer token loaded from a mode-0600 file.
Data requests use Cube's per-sandbox private traffic token and virtual host.
Responses, request paths, IDs and metadata are bounded before entering
AgentDock.

## Identity and fencing

Cube metadata records the immutable physical binding plus the original
assignment for orphan diagnosis:

```text
activation
tenant / project / workspace
Supervisor / boot / logical sandbox / command
Session / Turn / Attempt
lease / fencing token
AgentDock image revision
```

The public AgentDock runtime ID is a deterministic UUID hash of Cube's native
sandbox ID; the native ID remains a trusted Provider detail. Mutable
Run/Attempt ownership lives in the Manager. Every Tool request carries a
Manager-only handoff secret, immutable binding digest and current fencing
token. The root-owned guest supervisor checks them before forwarding work to a
uid-1000 Tool Worker.

At a warm Run boundary the supervisor stops the Worker, kills and verifies the
absence of every uid-1000 process, then Cube explicitly pauses the VM. A later
exact-Session Run must present a strictly higher fence to connect, rotate the
secret and start a fresh Worker against the preserved Workspace. The traffic
token alone is insufficient after rebind. Any ambiguous transition destroys
the VM and falls back to the committed AgentDock checkpoint.

At an ordinary durable checkpoint, the same sealed boundary captures a
content-hashed file index and Git patch, terminates every Tool process, and
flushes `/workspace`. Cube mounts that path from an `agentdock-posix` Volume
Plugin volume. A separately authenticated trusted Data Mover snapshots the
quiescent POSIX directory into Kopia's encrypted, content-addressed repository
in the dedicated MinIO bucket. The bounded checkpoint contains the Kopia
snapshot ID, deterministic Session volume ID, file index, environment binding,
activation and fence; it contains neither repository credentials nor Workspace
file bytes.

PostgreSQL publishes that immutable candidate only under the current
RunAttempt fence and Workspace-head CAS. A cold restore first asks the Data
Mover to restore the committed Kopia snapshot into the exact bound POSIX
volume, then creates a fresh base-template Cube VM with that volume mounted.
The new Tool Worker starts only under a strictly higher fence. A stale or
wrong-tenant Attempt therefore cannot select a snapshot, publish a new head, or
rebind another Session's volume. Legacy ADR-0064 Cube snapshot references
remain readable for migration, but no new Run creates them. See ADR-0067.

## Network and credential boundary

The create body always contains:

```json
{
  "allow_internet_access": true,
  "network": {
    "allowPublicTraffic": false,
    "allowOut": ["10.255.255.254/32"],
    "denyOut": ["0.0.0.0/0"]
  }
}
```

The sole allowed address is the trusted host-network Cube web-egress gateway.
The Tool Worker receives that stable host and port through standard HTTP proxy
variables, not the operator's upstream proxy URL. The gateway resolves targets,
rejects every private/special answer and forwards only public HTTP/HTTPS through
the hot-configured operator proxy. Direct public, platform, metadata and
cross-tenant IPv4 connections remain denied by Cube. See ADR-0063.

The Tool VM receives no model credential, database URL, object-store key,
Kubernetes credential, CubeAPI key or GitHub token. Port 49984 is reachable only
through CubeProxy using the returned traffic token. CubeAPI itself must use an
API key or authentication callback plus private network/firewall placement;
upstream documentation says its default configuration accepts requests without
authentication. The supplied runbook uses the simple-key mode backed by a
Kubernetes Secret. Its external authorizer uses an exact method/path allowlist:
ordinary lifecycle routes plus snapshot creation are allowed, while deletion
is limited to Cube's pinned `snap-<24 lowercase hex>` identity.
The Manager credential therefore cannot delete the immutable `tpl-*` Tool
template.

In the Compose product plane:

```text
sandbox-manager (internal networks only)
    ├── cube-api-relay   ── fixed private CubeAPI host:port
    └── cube-proxy-relay ── fixed private CubeProxy host:port

Cube Tool VM
    └── 10.255.255.254:3128 only
          └── trusted Cube egress gateway
                └── hot-configured operator HTTP(S) proxy
```

The relays have no credentials and cannot dial a destination selected by a
request. The CubeAPI bearer key remains only in the Manager.

## Template contract

The template is based on the pinned Cube base image but deliberately replaces
its inherited entrypoint. Root `envd` is not started because it would expose a
second command/file path outside AgentDock's Tool Broker. The sole root-owned
supervisor on 49984 authenticates the closed protocol and starts the existing
Tool Worker as uid/gid 1000 with no new privileges, zero effective
capabilities, a 128-process limit and a 1024-file limit. It includes:

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

## Acceptance evidence

The pinned v0.6.0 plane is installed on this machine with `/dev/kvm`.
The production MTU invariant is explicit: a stable `agentdock0` node interface
uses MTU 1500 and Flannel/Pod traffic uses MTU 1450. Binding Flannel to WSL's
65536-byte loopback interface was rejected after it was shown to black-hole
ordinary CubeProxy responses larger than the physical path MTU.

The live gate has proven:

- Provider control/data request shape and private traffic-token routing;
- metadata identity, fencing and replay checks;
- Manager lifecycle, capture, sealed pause/connect and higher-fence rebind;
- exact Tool image versions;
- actual file write, Python execution, traversal rejection and content-hashed
  checkpoint through the template service;
- Kopia snapshot creation from a sealed POSIX Workspace, source-VM destruction,
  local-copy deletion, and cold restore into a fresh higher-fence activation;
- fixed-target control/data relays.
- a real Cubelet/CubeShim KVM guest whose kernel differs from the host;
- simultaneous tenant canaries remaining in different Workspaces;
- no model/platform credential, Kubernetes token or Docker socket in the guest;
- successful proxy-mediated public HTTPS plus denial of direct public,
  CubeAPI, platform/private endpoints and link-local metadata from the guest;
- output, path, symlink, command-time and process limits;
- cancellation destroying the affected microVM;
- content capture and exact zero-orphan cleanup.

Recipes that require dependency hosts retain the disposable gVisor bootstrap
governed by ADR-0044. Its captured regular files are restored into a fresh
Cube VM. This is still a reproducible preparation boundary, but proxy-aware
ordinary Cube Bash subsequently has mediated public-web egress under ADR-0063.

The local profile proves loss of the Cube execution copy, not loss of the
physical host that also runs MinIO. A multi-node deployment must mount the same
POSIX filesystem at `/data/cube-shared/volume` on CubeMaster, every Cubelet and
the Data Mover, and must place Kopia's S3 repository off-node or on replicated
storage. Cube control-node loss, rolling upgrade, storage failure, density and
long-duration soak drills remain release gates for a public service.

The latest sanitized measurements are recorded in
[`reports/cubesandbox-kvm-acceptance-latest.md`](reports/cubesandbox-kvm-acceptance-latest.md).

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

ADR-0067 supersedes Cube-native snapshot creation for new Workspaces. Cube
rollback remains origin-Sandbox-bound and is deliberately not part of the
Manager credential. The
failure modes represented by upstream issue
[#804](https://github.com/TencentCloud/CubeSandbox/issues/804),
[#985](https://github.com/TencentCloud/CubeSandbox/issues/985) and
[#1105](https://github.com/TencentCloud/CubeSandbox/issues/1105) remain part of
the multi-node release gate. PostgreSQL remains the logical head authority,
Kopia stores immutable Workspace bytes, and the POSIX directory is a
replaceable execution copy rather than the durable commit authority.
