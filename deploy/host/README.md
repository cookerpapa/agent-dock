# AgentDock Kubernetes/gVisor host

AgentDock has one supported untrusted execution plane: K3s/containerd with the
`agent-dock-gvisor` RuntimeClass backed by `runsc` on KVM. Docker Compose still
runs the trusted product services, but Docker never creates or executes Tool
Sandboxes and no application service receives a Docker or containerd socket.

The pinned installer currently targets Ubuntu amd64 (including Ubuntu under
WSL2 when `/dev/kvm` is available):

```bash
cd /home/rayn/agent-dock
sudo AGENT_DOCK_HOST_USER="$USER" \
  ./scripts/install-kubernetes-gvisor-host.sh
newgrp docker
npm run sandbox:check
```

If the host requires a loopback HTTP proxy for package and image downloads:

```bash
sudo AGENT_DOCK_HOST_USER="$USER" \
  AGENT_DOCK_HOST_PROXY_URL=http://127.0.0.1:10808 \
  ./scripts/install-kubernetes-gvisor-host.sh
```

The installer is idempotent and fails closed. It:

- installs Docker Engine/Compose for the trusted product plane;
- installs the exact `runsc 20260714.0` package and requires working KVM;
- installs the checksum-pinned K3s `v1.36.2+k3s1` binary;
- registers `io.containerd.runsc.v1` with `platform = "kvm"` and the measured
  WSL2/K3s network compatibility settings `gso = "false"` and
  `software-gso = "false"`;
- installs checksum-pinned Helm 3.18.6 and owns the versioned
  `deploy/helm/agent-dock-execution-plane` release;
- labels the sandbox node and creates `RuntimeClass/agent-dock-gvisor` with a
  fixed `runsc` handler, node selector, and dedicated-node toleration;
- creates restricted execution namespaces, default-deny network policies,
  no-authority workload identities, namespace-scoped Manager RBAC, one
  resource-name-limited RuntimeClass read, and a two-replica controlled-egress
  proxy with zero-unavailable rolling updates and a disruption budget;
- writes a private, non-root-owned Manager kubeconfig under
  `deploy/production/runtime/kubernetes/`;
- grants the operator access only to Docker and the K3s image-import socket.

Image synchronization is an operator operation:

```bash
npm run kubernetes:image-sync
```

The Sandbox Manager itself has neither socket. `npm run sandbox:check` is the
authoritative end-to-end gate: it imports the Tool image, creates real gVisor
Pods, verifies identity/resource/network/credential/cross-tenant controls,
tests a real exact-commit GitHub import, cancellation and exact cleanup, and
completes a pinned Pi repair through remote Tool RPC.

`npm run helm:check` is the chart policy gate. It lints and renders the chart,
rejects unsafe value overrides, and asserts the fixed gVisor mapping, restricted
namespaces, least-privilege RBAC, deny-by-default network graph, proxy resource
limits and outbound-only Runner topology. Helm rendering is not treated as
evidence for multi-node CNI/CSI behavior; that requires a real cluster gate.

The two GSO settings retain gVisor's isolated userspace network stack; they do
not select host networking. On the validated WSL2 kernel, leaving segmentation
offload enabled caused HTTP/2 framing failures and long TCP retransmissions
during Git pack transfer. The importer also fixes Git to HTTP/1.1 and marks only
the immutable `/workspace` path safe because Kubernetes `emptyDir` ownership is
root with group write access. These are explicit compatibility choices covered
by the live import gate, not runtime fallbacks.

Kubernetes schedules and constrains the workload; gVisor is the syscall
isolation boundary. There is no runc, systrap, Docker-Sandbox, or managed-cloud
fallback in the application runtime.
