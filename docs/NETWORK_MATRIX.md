# Network and credential matrix

## Rule

Untrusted Tool Pods never join a platform network and have default-deny ingress
and egress. Network membership never replaces application authentication.

The trusted product plane currently runs in isolated Compose networks; the
untrusted execution plane runs in K3s. A credential-free relay is the only
bridge between the Manager's internal Compose network and the host Kubernetes
API endpoint.

## Trusted product plane

| Component | Edge/API | Management | Database | Object storage | Sandbox control | GitHub control | Observability | Provider egress | K3s API relay | Public ports |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Web ingress | yes | no | no | no | no | webhook proxy only | no | no | no | loopback `8080` |
| Control Plane | API | yes | yes | no | no | yes | metrics/trace | no | no | none |
| Trusted Pi Runner | no | yes | yes | yes | yes | yes | metrics/trace | yes | no | none |
| Sandbox Manager | no | no | no | no | yes | no | metrics/trace | no | via relay | none |
| Kubernetes API relay | no | no | no | no | yes | no | no | no | fixed host `6443` | none |
| GitHub Gateway | no | no | no | no | no | yes | no | yes | no | none |
| PostgreSQL | no | no | yes | no | no | no | no | no | no | none |
| MinIO | no | no | no | yes | no | no | no | no | no | none |
| Prometheus / Jaeger / Grafana | no | no | no | no | no | no | yes | no | no | none |
| Observability ingress | separate loopback edge | no | no | no | no | no | proxy only | no | no | loopback `9090`, `16686`, `3001` |

The relay has no mount, secret, environment credential or application route. It
accepts TCP only on the private `sandbox-control` network and forwards only to
the fixed `agent-dock-kubernetes-host:6443` target. TLS authentication and
authorization remain end-to-end between the Manager's scoped kubeconfig and
the Kubernetes API server.

## Kubernetes execution plane

| Workload/namespace | Ingress | DNS | Public egress | Cluster/private/link-local | Platform networks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean prewarm Pod / `agent-dock-sandboxes` | deny | deny | deny | deny | none |
| Ordinary Tool Pod / `agent-dock-sandboxes` | deny | deny | deny | deny | none |
| Disposable dependency bootstrap Pod / `agent-dock-sandboxes` | proxy Pod only | deny | exact-host HTTPS through proxy only | proxy rejects every non-public answer | none |
| Importer Pod / `agent-dock-importers` | deny | cluster DNS only | TCP/443 only | explicitly excluded | none |
| Dependency proxy / `agent-dock-egress` | labelled setup Pods only | cluster DNS only | TCP/443 only | NetworkPolicy exclusion plus per-resolution application check | none |

Both namespaces receive pre-created default-deny NetworkPolicies. The importer
has an additional egress policy for DNS plus public HTTPS, excluding loopback,
RFC1918, link-local, Pod, Service and node ranges. This is a bounded public
GitHub bootstrap path, not dependency or Agent-command egress. Standard
NetworkPolicy is L3/L4 policy, not a DNS-aware domain firewall. The dependency
path therefore uses a separate application proxy; the public GitHub importer
remains a broader bootstrap exception and is not claimed as a hostile
public-SaaS domain boundary.

Tool Pods set `dnsPolicy: None`, publish no port, and are unreachable from the
Manager except through Kubernetes attach/exec subresources. A disposable Pod
selected for dependency setup can connect only to the proxy Service. The
Manager snapshots its Workspace, destroys that exact Pod, confirms its UID is
absent, and restores into a fresh Pod with no dependency selector. Only the
fresh deny-all Pod can enter Supervisor inventory or execute Agent commands;
neither Pod can connect back to the Manager, Runner or relay.

## Credential and authority matrix

| Component | Tenant API auth | Model secret | DB | Object store | Manager token | GitHub key/token | Kubernetes credential | Docker/containerd socket |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser/Web | cookie/bearer | no | no | no | no | no | no | no |
| Control Plane | digest verification | encrypted credential authority | yes | no | no | service RPC only | no | no |
| Trusted Pi Runner | no public token | turn-scoped gateway + trusted resolver | yes | scoped identity | yes | service RPC only | no | no |
| Sandbox Manager | no | no | no | no | own verifier | no | two execution namespaces plus one named RuntimeClass read | no |
| Kubernetes API relay | no | no | no | no | no | no | no | no |
| GitHub Gateway | no | no | no | no | no | App key + memory-only token | no | no |
| Tool Pod | no | no | no | no | no | no | no ServiceAccount token | no |
| Importer Pod | no | no | no | no | no | no | no ServiceAccount token | no |

Only the trusted host operator uses Docker to build the product images and the
K3s containerd socket to import the Tool image. Neither socket is mounted into
an application container.

## Executable denial evidence

The live gate verifies from inside a real `runsc`/KVM Tool Pod that it cannot:

- reach the Control Plane, Sandbox Manager, PostgreSQL, MinIO or Kubernetes API;
- reach node/host gateways, loopback aliases, another Pod or public Internet;
- read Runner/Manager environment, ServiceAccount credentials or host `/proc`;
- find a Docker/containerd socket or another tenant's workspace.

It additionally verifies UID/GID, read-only root, mounts, capabilities, cgroup
and rlimit behavior, bounded output, cancellation and complete Pod deletion.

## Dependency network

Dependency installation uses a separately authenticated CONNECT proxy with
exact-host Ed25519 capabilities, proxy-side DNS resolution, private/special IP
rejection, TCP/443-only forwarding, connection/byte/duration bounds and
redacted audit logs. Redirects require another CONNECT and therefore another
exact allowed host. The issuer private key remains in the Sandbox Manager;
Kubernetes receives only its public key. Tool Pods are never added to provider
egress, the importer namespace, a host bridge, or a platform network.
