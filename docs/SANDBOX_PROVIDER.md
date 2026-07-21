# Kubernetes gVisor Sandbox Provider

## Supported boundary

AgentDock has exactly one untrusted execution provider:
`KubernetesGvisorSandboxProvider`. It creates Kubernetes Pods through the
official JavaScript client. Every Tool Pod selects
`runtimeClassName: agent-dock-gvisor`; K3s/containerd maps that class to the
`io.containerd.runsc.v1` shim, whose configuration fixes `platform = "kvm"`,
`network = "sandbox"`, and disables host/software GSO on the validated WSL2
network path.

There is no runtime selector, runc/systrap fallback, direct-Docker provider,
Docker Desktop sandbox path, or paid managed-provider branch. Missing KVM,
RuntimeClass, network policy, image, RBAC, or live gVisor attestation makes the
Manager unready.

ADR-0030 owns the provider-neutral contract and ADR-0039 is the current
execution-plane decision.

## Layering

```text
Trusted Pi Runner
    | authenticated Tool RPC + activation capability
    v
ToolSandboxManager
    | authorization, replay control, assignment fencing
    v
KubernetesGvisorSandboxProvider
    | scoped Kubernetes API: Pod/log/attach/exec + one RuntimeClass read
    v
K3s -> containerd -> runsc/KVM
    v
Untrusted Tool Pod
    | /workspace + /tmp; no platform credential or network
```

The Manager has a private kubeconfig limited to Pod operations in two
namespaces, NetworkPolicy inspection there, and `get` on one named
RuntimeClass; it has no Docker or containerd socket. The Runner and Tool Pod
receive neither. A credential-free
TCP relay connects the Manager's internal Compose network to the host K3s API;
the relay has no volume, secret, Kubernetes credential, or application API.

## Provider contract

The provider implements:

- `create`, `exec`, `readFile`, `writeFile`, `snapshot` and `inspect`;
- idempotent `stop`/`destroy` with UID-preconditioned deletion;
- exact assignment inventory and orphan reconciliation;
- a separate credential-free exact-commit public GitHub importer;
- `checkHealth` and `close`.

The immutable handle binds API version, tenant, session, turn, Run Attempt,
Supervisor boot, command, lease, fence, Pod name and Pod UID. Identity is copied
to Pod annotations. Every operation re-reads and compares that identity; a stale
handle cannot exec into or delete a replacement Pod.

The browser, prompt, repository and model cannot supply a PodSpec, image,
RuntimeClass, ServiceAccount, volume, node selector, command wrapper, security
context or network policy.

## Active-Turn lifecycle

One active Turn receives one Pod. Every `read`, `write`, `edit`, `bash`, Git and
test call in that Turn uses the same image-owned worker and `/workspace`.

```text
create Pod -> restore checkpoint -> attach Tool Worker
           -> many tool calls -> capture snapshot/patch
           -> delete Pod -> commit terminal state
```

Completion, failure, cancellation and timeout all delete the Pod. A later Turn
creates a different Pod UID and restores the immutable Pi/workspace checkpoint.
Cold conversations therefore consume no Pod or Pi process; Pod survival is not
a durability mechanism.

## Fixed Tool policy

```text
runtimeClass: agent-dock-gvisor (runsc/KVM)
namespace: agent-dock-sandboxes
network: default-deny ingress and egress; DNS disabled
service account: untrusted-tool; token automount disabled
user: 1000:1000, non-root
root filesystem: read-only
privileged / host PID / IPC / network: false
capabilities: drop ALL
allowPrivilegeEscalation: false
seccomp: RuntimeDefault
hostPath / devices / sockets: forbidden
CPU: 1 core
memory: 768 MiB
ephemeral storage: 256 MiB
guest RLIMIT_NPROC: 128
open files: 1024
/tmp: 64 MiB memory-backed emptyDir
/workspace: 128 MiB memory-backed emptyDir
tool output: 1 MiB
command timeout: at most 300 seconds
turn wall clock / Pod active deadline: 900 seconds
```

Kubernetes API normalization may omit secure default booleans or canonicalize
resource quantities. Acceptance inspects the effective Pod and also tests the
limits from inside the gVisor workload.

## Public exact-commit importer

Repository import is not Agent tool egress. A second fixed-purpose gVisor Pod
runs in `agent-dock-importers`; it receives a normalized GitHub repository plus
exact commit, no prompt and no credential, and never runs repository code. Its
namespace permits DNS and public TCP/443 while excluding loopback, private,
link-local, Pod, Service and node ranges. Redirects, hooks, credential helpers,
submodules, LFS and interactive authentication are disabled. The importer is
deleted after returning a bounded manifest. Git is pinned to HTTP/1.1 because
HTTP/2 pack negotiation reproducibly failed through this host's gVisor/K3s
path. Only `/workspace` is declared a safe Git directory to accommodate the
root-owned, group-writable Kubernetes `emptyDir`; global trust is not disabled.
The exact-commit fetch is safe to retry and uses a 20-second low-speed
threshold, a 45-second attempt deadline and at most three attempts inside the
180-second Pod lifetime; protocol, identity and snapshot-policy failures are
not retried.

## Runtime attestation and RBAC

Readiness requires the expected RuntimeClass handler, both pre-created network
policies, the exact Tool image, and a real Pod whose kernel identifies as
gVisor. It does not trust configuration text or an Agent's description of its
environment.

The dedicated Manager ServiceAccount can create/get/list/watch/delete Pods and
use logs/attach/exec only in the Tool and importer namespaces. It cannot read
Secrets, mutate NetworkPolicies/RBAC/ServiceAccounts, inspect nodes, use host
namespaces, or create workloads elsewhere. Tool/import Pods use a separate
ServiceAccount with no RBAC authority.

## Host installation and acceptance

```bash
sudo AGENT_DOCK_HOST_USER="$USER" \
  ./scripts/install-kubernetes-gvisor-host.sh
newgrp docker
npm run sandbox:check
npm run production:check
```

The first gate proves real gVisor identity, host/process/credential/network and
cross-tenant isolation, a real exact-commit public GitHub import,
traversal/symlink rejection, resource/output/timeout bounds, cancellation,
cleanup, checkpoint restore and a real Pi remote-tool repair. The production
gate additionally proves registration isolation,
restart/scale behavior, fencing, Run cancellation, Workspace versions,
observability and encrypted backup/restore.

See [`deploy/host/README.md`](../deploy/host/README.md) and
[`reports/gvisor-sandbox-latest.md`](reports/gvisor-sandbox-latest.md).
