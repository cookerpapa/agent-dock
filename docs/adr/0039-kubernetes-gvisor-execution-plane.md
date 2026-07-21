# ADR-0039: Kubernetes-managed gVisor execution plane

Status: Accepted

Date: 2026-07-21

Supersedes: the Docker Engine lifecycle mechanism in ADR-0038. The gVisor-only
security decision, the provider-neutral Manager contract from ADR-0030, and the
trusted Pi Runner / untrusted Tool Sandbox split remain in force.

## Context

ADR-0038 made `runsc` with the KVM platform mandatory, but the trusted Sandbox
Manager still held the host Docker socket and implemented scheduling, inventory,
resource limits, process attachment and cleanup directly through Docker. That
proved the gVisor boundary, but it left one root-equivalent daemon socket in the
application topology and did not exercise the Kubernetes execution-plane design
the project intends to demonstrate.

AgentDock already has durable Runs/Attempts, leases, fencing, immutable
checkpoints and cold session restore. A Kubernetes migration therefore must not
replace those application-level guarantees with Pod state or keep one Pod alive
for every stored conversation. Kubernetes is responsible for runtime placement
and lifecycle; PostgreSQL and object storage remain authoritative for agent and
workspace durability.

K3s currently does not auto-discover `runsc` as one of its built-in alternative
runtimes. The embedded containerd must be configured explicitly with the
`io.containerd.runsc.v1` shim, and a Kubernetes `RuntimeClass` must map the
trusted name `agent-dock-gvisor` to that handler.

## Decision

1. The only concrete Provider is `KubernetesGvisorSandboxProvider`. Docker is
   no longer used to create, inspect, execute, inventory or destroy untrusted
   workloads.
2. The local self-hosted execution plane is K3s with its embedded containerd.
   Containerd registers the `runsc` shim explicitly, and `/etc/containerd/runsc.toml`
   fixes `platform = "kvm"` and `network = "sandbox"`. Host and software GSO
   are disabled for the validated WSL2/K3s path after reproducible Git/TCP
   failures; this retains gVisor netstack isolation. There is no runc, systrap,
   or host-network fallback.
3. Every active Turn receives one Pod in `agent-dock-sandboxes` with
   `runtimeClassName: agent-dock-gvisor`. All tool calls in that Turn attach to
   the same image-owned Tool Worker. A settled, failed, cancelled or timed-out
   Turn deletes the Pod. A later Turn creates a fresh Pod and restores the
   immutable workspace checkpoint; cold Sessions consume no Pod.
4. The trusted Sandbox Manager remains in the Compose control plane. It no
   longer mounts `/var/run/docker.sock`, runs as the non-root application user,
   and receives only a private kubeconfig for a dedicated ServiceAccount. Its
   namespace-scoped Roles permit Pod create/get/list/watch/delete, log, attach,
   exec and NetworkPolicy inspection in the two execution namespaces. One
   resource-name-constrained ClusterRole permits `get` on
   `RuntimeClass/agent-dock-gvisor`; no permission permits Secrets,
   ServiceAccounts, RBAC mutation, NetworkPolicy mutation, nodes or arbitrary
   namespaces.
5. Sandbox namespaces enforce the Kubernetes Restricted Pod Security standard.
   Untrusted Pods use a no-authority ServiceAccount with token automount
   disabled. The Manager constructs a fixed Pod spec; the browser, tenant,
   repository and model cannot submit a PodSpec, image, RuntimeClass,
   ServiceAccount, host namespace, volume or security context.
6. Tool Pods are non-root, non-privileged, read-only outside memory-backed
   `/workspace` and `/tmp`, drop all capabilities, prohibit privilege
   escalation, use `RuntimeDefault` seccomp, have no hostPath/device/socket, and
   carry bounded CPU, memory, ephemeral-storage, process, file-descriptor,
   output, command and Turn limits.
7. `agent-dock-sandboxes` has a pre-created default-deny ingress/egress
   NetworkPolicy. Manager readiness validates the policy and launches a real
   Pod whose kernel must identify as gVisor. The integration gate additionally
   proves that TCP access to cluster services, node/host addresses and the
   Internet fails.
8. Public exact-commit import is a separate, fixed-purpose gVisor Pod in
   `agent-dock-importers`. It receives no prompt or credential and never runs
   repository code. Its namespace permits DNS plus public TCP/443 while
   excluding loopback, link-local, private, Pod, Service and node ranges. This
   remains a bounded bootstrap path, not network access for Agent tools. Git
   uses HTTP/1.1 and fixed `safe.directory=/workspace`; redirects, credentials,
   hooks, submodules and LFS execution remain disabled. A transient fetch uses
   a bounded low-speed threshold and at most three 45-second attempts inside
   the Pod deadline; protocol, identity and snapshot-policy failures do not
   retry.
9. Pod UID is the provider runtime ID and Pod name is the runtime name. Exact
   assignment identity is copied into annotations. Destructive operations
   re-read the Pod, compare every assignment field and use a UID precondition,
   so a stale worker cannot delete a replacement Pod.
10. The Manager uses the official Kubernetes JavaScript client and native
    attach/exec subresources. It does not shell out to `kubectl`, expose the
    Kubernetes client through a Provider handle, or pass Kubernetes credentials
    to Pi or a Tool Pod.
11. The production deployment imports the exact locally built Tool image into
    K3s containerd before starting the Manager. Image import is an operator
    action; neither the Manager nor the Runner receives the containerd socket.

## Why active-Turn Pods, not permanent Session Pods

Conversation history belongs to Pi JSONL and workspace state belongs to
versioned checkpoints. Keeping a Pod per stored Session would turn idle chat
history into live memory/process cost and make Pod survival an accidental
durability requirement. Reusing one Pod during an active Turn retains the file
system, dependencies and background processes needed by the agent loop, while
checkpoint-and-delete after settlement preserves the existing cold-session
invariant and horizontal scheduling model.

## Security boundary

Kubernetes is an orchestrator, not the syscall sandbox. The execution boundary
is still gVisor: application syscalls are handled by Sentry before limited host
operations reach the node kernel. Kubernetes adds API-mediated lifecycle,
RuntimeClass selection, cgroup resource declarations, namespace/RBAC policy and
NetworkPolicy enforcement.

The trusted computing base becomes the K3s control plane, kubelet, containerd,
`runsc`, the node kernel and the narrowly authorized Sandbox Manager. A
compromise of the Manager can create or exec restricted Pods in its two
namespaces, but it no longer grants direct Docker-host administration. Pod
Security admission and immutable namespace policies provide a second boundary
against an accidentally weakened Pod template.

This remains a private self-hosted claim. It does not assert that one WSL node
is an independently audited hostile public SaaS, nor that NetworkPolicy is a
domain-aware egress firewall.

## Consequences

- Host setup is more involved and requires K3s, containerd/runsc configuration,
  CNI policy enforcement, scoped credentials and local image synchronization.
- Disabling host/software GSO can reduce network throughput. It is an explicit
  compatibility trade-off backed by the exact-commit import gate; future host
  kernels must re-benchmark before changing it.
- Pod startup is slower than direct Docker activation and must be measured.
- Kubernetes has no portable per-Pod `ulimit` field. The fixed container command
  lowers `RLIMIT_NPROC` and `RLIMIT_NOFILE`, while the K3s node also sets a
  kubelet Pod PID limit; the gate tests actual exhaustion rather than trusting
  declarations.
- Memory-backed `emptyDir` data is ephemeral and charged against the Pod memory
  budget. Durable state continues to use AgentDock checkpoints, not PVCs.
- A future multi-node deployment can move gVisor nodes behind RuntimeClass
  scheduling labels/taints without changing the Tool RPC or Provider contract.

## Acceptance evidence

The Kubernetes gVisor gate must prove:

1. the RuntimeClass maps to the `runsc` handler and a live Pod reports a gVisor
   kernel;
2. Manager readiness fails without the RuntimeClass, default-deny policy,
   image or working Pod;
3. the effective Pod spec is restricted, non-root, credential-free and has no
   host namespaces, hostPath, device or ServiceAccount token;
4. CPU, memory, process, file-descriptor, workspace, output and timeout bounds
   are effective;
5. Tool Pods cannot reach platform services, the Kubernetes API, node/host
   addresses, another tenant workspace or the Internet;
6. operation cancellation kills descendants, terminal cleanup deletes the Pod,
   and UID-fenced reconciliation removes orphan Pods;
7. exact-commit GitHub import succeeds only through the importer namespace and
   leaves no Pod;
8. two real Pi Turns restore conversation/workspace state through different
   Pod UIDs; and
9. the running Sandbox Manager has no Docker/containerd socket and only the
   scoped kubeconfig.
