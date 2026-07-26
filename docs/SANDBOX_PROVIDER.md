# Sandbox Providers

## Supported boundary

AgentDock has one supported ordinary Tool execution Provider:
`CubeSandboxProvider`. It creates independent KVM guests through the pinned
Tencent CubeSandbox v0.6.0 CubeAPI/CubeMaster/Cubelet/CubeShim plane.

`KubernetesGvisorSandboxProvider` remains executable only for:

- the exact-commit repository importer and dependency bootstrap boundary;
- the explicit deterministic production regression gate.

It is not an ordinary production Tool fallback. There is no tenant-, prompt-,
browser- or model-controlled runtime selector, local-process Provider,
ordinary-runc Provider, Docker Desktop path or paid managed-provider branch.
Missing KVM, Cube authentication, closed network policy, current-commit READY
template or live runtime evidence makes production unready.

ADR-0030 owns the provider-neutral contract, ADR-0052 records the Cube
evaluation, and ADR-0053 is the current execution-plane decision.

## Layering

```text
Trusted Pi Worker pool
    | authenticated Tool RPC + activation capability
    v
ToolSandboxManager
    | authorization, replay control, assignment fencing
    v
CubeSandboxProvider
    | fixed CubeAPI lifecycle + private-token CubeProxy data path
    v
CubeMaster -> Cubelet -> CubeShim/KVM
    v
Untrusted Tool microVM
    | /workspace; no platform credential or outbound network
```

The Pi Worker has no Cube credential or Kubernetes credential. The Manager
holds a mode-0600 CubeAPI key and reaches CubeAPI/CubeProxy through
credential-free fixed-target relays. The relays cannot dial a destination
selected by a request. The guest receives neither the API key nor its private
traffic token.

The Manager separately holds a least-privilege kubeconfig for importer Pods. It
has no Docker/containerd socket. No Tool or importer workload receives a
ServiceAccount token.

## Provider contract

The Provider implements:

- `checkHealth` and a real KVM runtime probe;
- `create`, `exec`, `readFile`, `writeFile`, `snapshot` and `inspect`;
- cancellation plus idempotent `stop`/`destroy`;
- exact assignment inventory and orphan reconciliation;
- `close`.

The immutable handle binds API version, tenant, project, Workspace, Session,
Turn, RunAttempt, Supervisor boot, logical sandbox, command, lease, fence,
activation and opaque physical runtime identity. The model never receives a
native Cube sandbox ID. Before every Tool operation, the Provider re-reads the
instance and verifies the complete metadata assignment. Reused operation or
capture IDs fail closed.

If Cube transport fails after arbitrary Bash might have started, the result is
`UNKNOWN`, the guest is destroyed and the command is not blindly replayed.

The browser, prompt, repository and model cannot supply a template, image,
native sandbox ID, network policy, resource shape, mount, device, command
wrapper or runtime configuration.

## Demand-activated Run lifecycle

A Run first receives only a logical capability reservation. No guest is
created until the first authenticated `read`, `write`, `edit` or `bash`
operation. Repository instructions are loaded from the already committed
Workspace snapshot in the trusted Worker, so reading `AGENTS.md` does not
accidentally activate Cube.

```text
chat:
  reserve -> Pi/model -> save Pi JSONL -> release unused reservation
  Cube activations = 0

code:
  reserve -> first Tool -> create/restore Cube KVM guest
  -> many Tools -> capture Workspace/Pi
  -> commit content checkpoint under Attempt/fence
  -> seal uid-1000 execution -> pause guest

later code Run:
  matching Workspace revision + higher fence
  -> Cube connect -> rotate handoff authority -> fresh Tool Worker attach
```

Cube's lifecycle state is not used as the ownership CAS. AgentDock seals the
guest, requires a strictly higher business fence, rotates a Manager-only
handoff secret and keeps warm reuse scoped to the exact tenant/project/
Workspace/Session. Environment or committed-Workspace revision mismatch,
failure, cancellation, timeout, Manager restart or any ambiguous transition
destroys the VM. Guest survival is never a durability mechanism.

## Versioned Project environment

Every accepted Run carries one immutable Project environment snapshot:

```text
environmentVersionId / versionNumber
profileKey = agent-dock-fullstack
profileVersion = 1
imageRevision = immutable deployment revision
specSha256 = canonical profile specification
recipeSha256 = canonical offline recipe
```

`ToolSandboxManager` accepts the request only when the profile and image
revision match its startup configuration. Production also validates that the
Cube template evidence binds the exact AgentDock Git revision, pushed image
digest, READY template ID and closed specification SHA-256.

During initialization, the Tool Worker compares the expected revision with the
value baked into the image and probes Node.js 24, Java 17, Python 3.11 and Git
2. The Provider combines that report with real `cubesandbox-kvm`,
guest-kernel, deny-all network, UID/GID 1000:1000, no-new-privileges and
zero-effective-capability evidence. Cube's CoW guest root is writable, so the
report does not falsely claim a read-only OCI rootfs.

Recipes with `dependencyHosts` use the retained disposable gVisor bootstrap and
the ADR-0044 Ed25519 proxy. After content capture and exact bootstrap
destruction, a fresh Cube guest restores the regular files. gVisor never
executes an ordinary Agent Tool Call; the resulting Cube guest uses the
deployment-owned proxy-mediated public-web policy.

## Fixed Cube Tool policy

```text
upstream: TencentCloud/CubeSandbox v0.6.0
template: immutable READY ID + image digest + current Git revision
network: allow_internet_access=true; allow only 10.255.255.254/32; deny all other IPv4
inbound: allowPublicTraffic=false; private-token port 49984 only
user: 1000:1000
privileged: false
capabilities: zero effective / drop ALL
allowPrivilegeEscalation: false / no-new-privileges
host mounts / Docker socket / Kubernetes token: forbidden
CPU: 1 logical core policy; 2 vCPU template ceiling
memory: 768 MiB policy; 2000 MiB template ceiling
guest process limit: 128
open files: 1024
CoW writable layer / Workspace bound: 1 GiB
tool output: 1 MiB
command timeout: at most 300 seconds
turn wall clock: 900 seconds
```

CubeVS permits only the trusted host-network web gateway. The Tool Worker
receives that gateway address in proxy variables; the gateway hot-loads the
operator proxy, resolves targets itself and rejects non-public answers.
`cubesandbox:live-check` requires proxy-mediated HTTPS from a real guest while
direct public and platform/private probes fail.

The template replaces Cube's inherited entrypoint. Root `envd` is not started,
because it would expose an unmediated second command/file channel. Port 49983
must not have a listener.

## Repository importer

Repository import is not Agent Tool egress. A fixed-purpose gVisor Pod runs in
`agent-dock-importers`; it receives a normalized GitHub repository plus exact
commit, no prompt and no credential, and never runs repository code. It has no
DNS and can reach only the capability proxy ClusterIP. A per-import Ed25519
capability permits only `github.com:443` and bounds time, connections,
concurrency and bytes; the proxy rejects every non-public DNS answer.
Redirects, hooks, credential helpers, submodules, LFS and interactive
authentication are disabled. The importer is deleted after returning a
bounded manifest.

This path uses `RuntimeClass/agent-dock-gvisor -> runsc/KVM` and scoped
Kubernetes RBAC. It remains separately attested by `npm run sandbox:check`.

## Runtime acceptance

```bash
npm run cubesandbox:template-check
npm run cubesandbox:live-check
AGENT_DOCK_LIVE_CUBESANDBOX_CHECK=1 npm run production:semantic-check
```

The local template gate proves protocol/toolchain compatibility but explicitly
does not claim KVM isolation. The live gate proves a distinct guest kernel,
two-tenant same-path Workspace isolation, credential absence, platform/public
network denial, path/output/resource bounds, cancellation and zero-orphan
cleanup. The real production gate then consumes model tokens and proves:

- pure chat creates zero Cube guest;
- two coding Runs in one Session use different guests;
- the second Run restores and modifies the first checkpoint;
- provider usage and semantic projections commit;
- cross-tenant conversation reads return 404;
- no test-session guest remains.

See [`deploy/cubesandbox/README.md`](../deploy/cubesandbox/README.md),
[`CUBESANDBOX_PROVIDER.md`](CUBESANDBOX_PROVIDER.md), and
[`THREAT_MODEL.md`](THREAT_MODEL.md).
