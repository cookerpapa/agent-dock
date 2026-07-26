# Network and credential matrix

## Rule

Untrusted Cube Tool microVMs never join a platform network. They have full
public IPv4 egress through CubeVS, with explicit denial of private, loopback,
carrier-grade NAT, link-local/metadata and other special address classes.
Network membership never replaces application authentication.

The trusted product plane currently runs in isolated Compose networks; the
ordinary untrusted execution plane runs in Cube KVM guests. K3s/gVisor remains
for exact-commit import. Credential-free relays provide closed bridges from the
Manager to fixed CubeAPI, CubeProxy and Kubernetes endpoints, and from the
trusted Model Gateway to the exact model provider host.

## Trusted product plane

| Component | Edge/API | Management | Database | Object storage | Sandbox control | GitHub control | Observability | Model egress | Provider egress | K3s API relay | Public ports |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Web ingress | yes | no | no | no | no | webhook proxy only | no | no | no | no | loopback `8080` |
| Control Plane | API | yes | yes | no | no | yes | metrics/trace | no | no | no | none |
| Trusted Pi Runner | no | yes | yes | yes | yes | yes | metrics/trace | internal relay only | no direct route | no | none |
| Provider bridge relay | no | no | no | no | no | no | no | yes | Unix socket only | no | none |
| Provider host relay | no | no | no | no | no | no | no | Unix socket only | exact provider or operator proxy | no | no TCP listener |
| Sandbox Manager | no | no | no | no | yes | no | metrics/trace | no | no | via relay | none |
| Kubernetes API relay | no | no | no | no | yes | no | no | no | no | fixed host `6443` | none |
| CubeAPI relay | no | no | no | no | fixed Cube lifecycle target | no | no | no | fixed private CubeAPI | no | none |
| CubeProxy relay | no | no | no | no | fixed per-guest data target | no | no | no | fixed private CubeProxy | no | none |
| GitHub Gateway | no | no | no | no | no | yes | no | no | yes | no | none |
| PostgreSQL | no | no | yes | no | no | no | no | no | no | no | none |
| MinIO | no | no | no | yes | no | no | no | no | no | no | none |
| Prometheus / Jaeger / Grafana | no | no | no | no | no | no | yes | no | no | no | none |
| Observability ingress | separate loopback edge | no | no | no | no | no | proxy only | no | no | no | loopback `9090`, `16686`, `3001` |

The Kubernetes relay has no mount, secret, environment credential or application route. It
accepts TCP only on the private `sandbox-control` network and forwards only to
the fixed `agent-dock-kubernetes-host:6443` target. TLS authentication and
authorization remain end-to-end between the Manager's scoped kubeconfig and
the Kubernetes API server.

The two Cube relays likewise hold no API key or guest traffic token. Each can
dial only one operator-validated private endpoint. CubeAPI authentication and
CubeProxy per-sandbox traffic authentication remain end-to-end with the
Manager.

The provider bridge accepts CONNECT only on the internal `model-egress`
network and forwards bytes through a `0700` named-volume Unix socket. The
host-network half listens on no TCP port, permits only
`api.deepseek.com:443`, rejects non-public direct DNS answers, and contains no
model or platform credential. Provider TLS and API authentication remain
end-to-end between the trusted Model Gateway and DeepSeek. The Runner is not a
member of the directly routed `provider-egress` network.

## Cube Tool execution plane

| Workload | Ingress | DNS | Public egress | Platform/private endpoints | Credential |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary Tool microVM | private-token Tool protocol through CubeProxy only | Cube-managed | allow | deny by CIDR policy | none |

Every create request sets `allow_internet_access=true`,
`allowPublicTraffic=false` and an explicit `denyOut` list for non-public and
infrastructure-relevant IPv4 classes. No `allowOut` entries are supplied,
because Cube evaluates allow entries before deny entries. The real KVM gate
requires public HTTPS to succeed while CubeAPI, Control
Plane/PostgreSQL-class endpoints and `169.254.169.254` fail. Port 49984 is the
only registered Tool service and remains protected by Cube's per-Sandbox
traffic token. Cube's inherited `envd` command channel is not started.

This CubeVS/NAT path requires every Cube node to have a native public route.
Host-level `HTTP_PROXY` is not inherited by a microVM. A proxy-only WSL
`mirrored` node with no IPv4 default route does not satisfy the full-public
tier; the live gate rejects it before creating acceptance guests.

## Kubernetes importer plane

| Workload/namespace | Ingress | DNS | Public egress | Cluster/private/link-local | Platform networks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Disposable dependency bootstrap Pod / `agent-dock-sandboxes` | proxy Pod only | deny | exact-host HTTPS through proxy only | proxy rejects every non-public answer | none |
| Importer Pod / `agent-dock-importers` | proxy Pod only | deny | exact `github.com:443` through a signed capability only | proxy rejects every non-public answer | none |
| Capability proxy / `agent-dock-egress` | labelled setup/import Pods only | cluster DNS only | TCP/443 only | NetworkPolicy exclusion plus per-resolution application check | none |

Both namespaces receive pre-created default-deny NetworkPolicies. Neither the
importer nor a dependency-bootstrap Pod receives DNS or arbitrary public HTTPS.
Their only egress is the proxy ClusterIP. The Manager signs a short-lived
capability for exact recipe hosts or the fixed `github.com` import host; the
proxy resolves names and rejects non-public answers. Standard NetworkPolicy
provides the L3/L4 path while the application capability supplies the domain,
port, lifetime, connection, concurrency, byte and duration boundary.

Importer/bootstrap Pods set `dnsPolicy: None`, publish no port, and are
unreachable from the Manager except through Kubernetes attach/exec
subresources. A disposable Pod selected for dependency setup can connect only
to the proxy Service. For a Cube environment with `dependencyHosts`, the
Manager captures only that bootstrap Pod's regular-file Workspace, destroys the
Pod and capability, and restores the bytes into a newly created
Cube microVM. Processes, network namespaces, connections and capability
material are not promoted. That remains a reproducible environment-preparation
boundary, but the ordinary Cube Tool microVM subsequently has ADR-0062's
full-public/private-denied egress.

## Credential and authority matrix

| Component | Tenant API auth | Model secret | DB | Object store | Manager token | GitHub key/token | Kubernetes credential | Docker/containerd socket |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser/Web | cookie/bearer | no | no | no | no | no | no | no |
| Control Plane | digest verification | encrypted credential authority | yes | no | no | service RPC only | no | no |
| Trusted Pi Runner | no public token | turn-scoped gateway + trusted resolver | yes | scoped identity | yes | service RPC only | no | no |
| Sandbox Manager | no | no | no | no | own verifier | no | importer namespaces plus one named RuntimeClass read; Cube API key separately | no |
| Kubernetes API relay | no | no | no | no | no | no | no | no |
| GitHub Gateway | no | no | no | no | no | App key + memory-only token | no | no |
| Provider relays | no | no | no | no | no | no | no | no |
| Cube Tool microVM | no | no | no | no | no | no | no Kubernetes/Cube credential | no |
| Importer Pod | no | no | no | no | no | no | no ServiceAccount token | no |

Only the trusted host operator uses Docker to build the product images and the
K3s containerd socket to import the Tool image. Neither socket is mounted into
an application container.

## Executable denial evidence

The primary live gate verifies from inside real Cube KVM Tool guests that they:

- can reach a stable public HTTPS endpoint;
- cannot reach CubeAPI, the Control Plane/PostgreSQL-class platform endpoints
  or link-local metadata;
- cannot read Runner/Manager environment, model/platform credentials or a Kubernetes
  token;
- cannot find a Docker/containerd socket or another tenant's Workspace.

It additionally verifies a guest kernel distinct from the host, UID/GID,
capabilities, rlimit behavior, bounded output, cancellation and complete
microVM deletion. The retained `sandbox:check` separately verifies the gVisor
importer/regression boundary.

## Dependency network

Dependency installation uses a separately authenticated CONNECT proxy with
exact-host Ed25519 capabilities, proxy-side DNS resolution, private/special IP
rejection, TCP/443-only forwarding, connection/byte/duration bounds and
redacted audit logs. Redirects require another CONNECT and therefore another
exact allowed host. The issuer private key remains in the Sandbox Manager;
Kubernetes receives only its public key. Cube Tool microVMs are never added to
provider egress, the importer namespace, a host bridge, or a platform network.
Their public Internet path is CubeVS's independent NAT/policy plane.
