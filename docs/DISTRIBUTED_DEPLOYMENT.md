# Distributed Kubernetes deployment

This profile runs the AgentDock application plane across multiple Kubernetes
nodes. It is intentionally separate from the one-host installer in
[PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md).

## 1. What the Chart deploys

```text
Ingress
  → Web Deployment + HPA
  → Control Plane Deployment + HPA
       ├── PostgreSQL/PgBouncer (external)
       ├── direct PostgreSQL LISTEN endpoint (external)
       ├── Temporal cluster (external)
       └── replicated Sandbox Manager Service

Temporal Activity Task Queue
  → KEDA
  → Pi Worker StatefulSet (2..N)
       └── exact Worker management over headless DNS

Sandbox Manager replica N + Workspace Data Mover N
  → Cube API/Proxy cluster (external KVM execution plane)
  → shared RWX POSIX Workspace volume
  → Kopia object repository
```

The Chart is
[`deploy/helm/agent-dock-platform`](../deploy/helm/agent-dock-platform).
It deploys Web, Control Plane, the trusted Manager/Data-Mover replica set, the Pi
Worker pool, policies, bootstrap migration and autoscalers. It does **not**
silently install data stores or Cube under application credentials.

## 2. Required authorities

Prepare these before installing AgentDock:

| Dependency | Production contract |
| --- | --- |
| PostgreSQL | HA PostgreSQL; `database-url` normally targets PgBouncer transaction pooling |
| PostgreSQL notifications/migrations | `database-notification-url` connects directly to PostgreSQL for `LISTEN` and the Helm migration hook |
| Temporal | durable multi-node Temporal namespace and frontend endpoint |
| Pi checkpoints | S3-compatible bucket with versioning/retention policy |
| Workspace checkpoints | separate Kopia S3-compatible repository |
| Workspace live volume | existing `ReadWriteMany` PVC backed by a real multi-node POSIX filesystem |
| CubeSandbox | separate Cube v0.6+ control/compute cluster and registered AgentDock Tool template |
| KEDA | v2.20+ Temporal scaler CRDs/controller |
| Metrics API | metrics-server or compatible `metrics.k8s.io` provider |
| node capacity | provider-specific Cluster Autoscaler/Karpenter equivalent when automatic machine growth is desired |

Cube v0.6 provides an upstream Kubernetes/Helm deployment, but that upstream
path is currently documented as preview. Operate and validate it as a separate
execution-plane release rather than nesting its cluster lifecycle inside the
AgentDock application release:
<https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.6.0>.

## 3. Secret and storage contract

Create one namespace-scoped Secret named by `global.existingSecret`. It must
contain these keys:

```text
api-token
aws-credentials
cube-egress-config-token
cubesandbox-api-key
database-notification-url
database-url
metrics-token
model-credential-master-key
sandbox-manager-token
sandbox-materializer-token
supervisor-enrollment-token
supervisor-management-token
workspace-data-mover-token
workspace-kopia-aws-credentials
workspace-kopia-repository-password
```

Use `kubectl create secret generic ... --from-file=<key>=<private-file>` or an
external-secrets controller. Do not put values in Helm YAML or Git. Secret file
mounts preserve the runtime's `O_NOFOLLOW`, private-mode and bounded-size
validation.

Create the Workspace PVC separately. The deploy preflight rejects it unless its
access mode includes `ReadWriteMany`. A single-node `hostPath` or local-path PVC
does not satisfy the distributed durability claim.

## 4. Configure and render

Start from:

```bash
cp deploy/helm/agent-dock-platform/values.distributed.example.yaml \
  /secure/operator/agent-dock-values.yaml
```

Replace all image references, UUIDs, storage classes, endpoints and network
CIDRs. Configure `global.imagePullSecrets` when the images are private. Each
execution Cell has one stable `sandbox-manager` Service and at least three
Manager replicas. PostgreSQL ownership rows bind a live activation to one
replica; the create response carries that replica's headless-DNS owner URL for
all subsequent operations.

Render without contacting a cluster:

```bash
npm run kubernetes:distributed:render -- \
  --values /secure/operator/agent-dock-values.yaml
```

The CI Helm gate rejects unknown values, fewer than three Manager replicas,
single-replica API workloads, unsafe host mounts and drift in the expected
autoscaling/management topology.

## 5. Preflight and deploy

```bash
npm run kubernetes:distributed:preflight -- \
  --values /secure/operator/agent-dock-values.yaml \
  --namespace agent-dock-system

npm run kubernetes:distributed:deploy -- \
  --values /secure/operator/agent-dock-values.yaml \
  --namespace agent-dock-system \
  --release agent-dock
```

Deployment is `helm upgrade --install --atomic --wait`. A Helm hook runs schema
migrations and the idempotent production bootstrap before application rollout.
Check the release with:

```bash
npm run kubernetes:distributed:status -- \
  --namespace agent-dock-system \
  --release agent-dock
```

The preflight normally requires two Ready schedulable nodes. A one-node test
cluster can bypass only that check with
`AGENT_DOCK_ALLOW_SINGLE_NODE_DISTRIBUTED=1`; doing so is not HA evidence.

## 6. Scaling behavior

| Component | Mechanism | Default | Important boundary |
| --- | --- | --- | --- |
| Web | CPU HPA | 2–8 | stateless |
| Control Plane | CPU HPA | 3–12 | PostgreSQL/object storage remain authoritative |
| Pi Worker | KEDA Temporal Activity backlog | 2–32 Pods, four bounded runtime slots per Pod | no scale-to-zero; graceful Activity drain |
| Sandbox Manager/Data Mover | replicated StatefulSet | 3 replicas | DB-backed ownership; owner loss makes ambiguous Tool work `UNKNOWN` before cleanup |
| Cube control/compute | Cube's own K8s deployment | operator defined | KVM/PVM capacity and upstream preview limitations apply |
| Kubernetes Nodes | cloud/provider node autoscaler | operator defined | Kubernetes YAML alone cannot create machines |

KEDA filters backlog by the configured Temporal Worker Deployment name and
Build ID, so a blue-green Worker version scales from its own compatible queue
view. The StatefulSet uses headless DNS; adding ordinal Pods requires no new
Service objects.

Worker SIGTERM first stops new Temporal Activity polling. The termination grace
period covers the bounded Pi Turn, Sandbox settlement and additional cleanup
margin. The HPA removes no more than one Worker per long scale-down period. An
operator must still use Temporal Worker Versioning and drain the old Build
before deleting it.

## 7. Network and placement

The install command labels the AgentDock namespace
`agent-dock.io/trusted-plane=true`. Label an in-cluster dependency namespace
the same way only after reviewing that trust expansion. Otherwise list its
concrete CIDR in both platform and Worker `externalEgressCidrs`. `0.0.0.0/0` is
schema-rejected.

Use node labels/taints to keep trusted application Pods away from Cube compute
nodes. Cube guests still receive no Kubernetes, database, Temporal, model or
object-store credentials. The platform NetworkPolicy and Cube guest egress
policy are separate layers and both remain required.

## 8. Sandbox Manager replica changes

Manager replicas no longer form a process-local hash ring. A create may reach
any Ready replica through the Cell Service. Reservation uses a Workspace row
lock and a partial unique index; subsequent calls follow the returned owner
URL. A replica heartbeat Lease fences an expired owner before another replica
may clean its activation. An ordinary in-place rollout preserves committed
state, but an in-flight arbitrary Tool outcome can still become `UNKNOWN` and
force the current Run to recover cold. To perform a no-sacrifice policy or
image rollout:

1. stop new coding Run admission;
2. wait for active Tool operations to settle;
3. destroy or expire warm Cube activations;
4. checkpoint every dirty Workspace;
5. deploy the new replica set and matching Worker/Control Plane configuration;
6. resume admission;
7. reconcile the old ring and then remove it.

Scaling `sandboxPlane.replicas` does not remap Workspaces. If one Manager Pod is
lost, a surviving replica expires its DB Lease, marks running Tool operations
unknown and claims orphan cleanup. The next Attempt restores the last committed
Pi and Workspace state and receives the model-visible Sandbox reset boundary.

Use one AgentDock release per namespace. The stable `control-plane` and
`sandbox-manager` Services plus per-Pod headless DNS form the routing contract.

## 9. What remains to prove

The Chart and CI validate manifest shape and application-level routing. A real
production claim additionally requires evidence for:

- a Control Plane node disappearing during active streams;
- Pi Worker node loss and Temporal retry on another node;
- Sandbox Manager ordinal replacement and cold Workspace recovery;
- Cube compute-node drain/replacement;
- PostgreSQL, Temporal and S3 failover;
- KEDA backlog growth and node-autoscaler provisioning at sustained load.

Until those tests run on a real multi-node cluster, describe this as a
multi-node-capable deployment implementation, not as measured multi-region or
zero-downtime HA.
