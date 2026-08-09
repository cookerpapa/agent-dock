# ADR-0088: Distributed Kubernetes topology and demand scaling

- Status: Partially superseded by ADR-0089
- Date: 2026-08-09
- Refines: ADR-0054, ADR-0067, ADR-0074 and ADR-0086

The fixed process-local Sandbox Manager ring in decisions 6–7 is superseded.
The remaining Kubernetes, Worker DNS and autoscaling decisions stay active.

## Context

The single-host production profile proves the complete Browser → Temporal → Pi
Worker → Cube path, but a larger installation needs independently replaceable
API replicas, queue-driven Worker capacity and external state authorities. A
naive replica increase is unsafe in two places:

- a WebSocket steer sent through a random Control Plane replica does not
  necessarily reach the replica that owns the Worker connection; and
- Sandbox Manager owns live Cube activation/capability state in memory, so an
  L4 load balancer may route a later Tool operation to a Manager that cannot
  validate it.

Kubernetes HPA scales ordinary stateless workloads from resource or custom
metrics, and node autoscaling provisions capacity for pending Pods. These are
separate mechanisms:
<https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/>
and
<https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/>.

KEDA's Temporal scaler reads Task Queue backlog and can select one Worker
Deployment version with `workerDeploymentName` and `workerDeploymentBuildId`:
<https://keda.sh/docs/2.20/scalers/temporal/>. CubeSandbox v0.6 exposes an
official Kubernetes deployment for its control and compute nodes, while the
upstream documentation still marks that path preview:
<https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.6.0>.

## Decision

1. The distributed profile requires external PostgreSQL, Temporal,
   S3-compatible Pi-checkpoint storage, Kopia storage and a Cube cluster.
   Application Pods contain no irreplaceable business state.
2. PostgreSQL remains the business/event authority. Its normal application URL
   may use PgBouncer transaction pooling; PostgreSQL `LISTEN` uses a separate
   direct session URL because transaction pooling cannot preserve a session
   listener.
3. Web and Control Plane are multi-replica Deployments with Pod disruption
   budgets, topology spreading and CPU HPA. Control Plane duplicate outbox
   observations remain safe because Temporal Workflow IDs are deterministic
   and PostgreSQL exact-command admission is transactional.
4. Pi Workers remain capacity-one Temporal Activity Workers. KEDA scales their
   StatefulSet from the exact versioned Activity Task Queue. The lower bound is
   two; scale-to-zero is forbidden. Scale-down removes at most one replica per
   long window, and SIGTERM first stops Task polling, then waits for the active
   Activity and settlement boundary.
5. Worker management uses stable StatefulSet headless DNS. A Worker advertises
   `pod.headless-service.namespace.svc`, so Control Plane replicas can deliver
   authenticated steer directly to the exact active Worker without relying on
   replica-local WebSocket ownership or pre-creating per-ordinal Services.
6. Sandbox Managers form an operator-owned fixed deterministic hash ring. Workspace
   ID deterministically selects one shard, and all Tool reservation, operation,
   release and orphan cleanup traffic returns to that shard. Each Manager is
   paired with a trusted Workspace Data Mover and durable local Kopia state.
7. Sandbox Manager shard count is not HPA-managed. Changing the ring requires
   draining active/warm activations and performing a blue-green ring rollout;
   a shard failure sacrifices ambiguous live process state and cold-restores
   only the committed Workspace/Pi authorities. Application readiness remains
   healthy while at least one Manager shard is reachable, so an isolated shard
   failure does not remove every Control Plane/Worker endpoint; Runs assigned
   to the unavailable shard fail retryably until that ordinal is restored.
   Manager image/policy upgrades use the same drain when preserving the
   current Run matters; an undrained rolling replacement preserves committed
   state but intentionally does not preserve ambiguous live process state.
8. Shared ordinary Workspaces remain globally serialized in PostgreSQL before
   Run claim. The Manager ring is a runtime-routing mechanism, not a substitute
   for Workspace row locking and head CAS.
9. K8s NetworkPolicy denies unlisted trusted-plane egress. External database,
   Temporal, S3, Cube and provider-proxy CIDRs must be explicit, or their
   in-cluster namespaces must carry the trusted-plane label. Sandbox guest
   egress remains independently governed by Cube.
10. The Helm profile includes a pre-install/pre-upgrade database migration and
    idempotent bootstrap Job. A preflight/deploy command validates KEDA,
    Metrics API, a multi-node cluster, the complete Secret contract and a
    `ReadWriteMany` Workspace PVC before invoking an atomic Helm upgrade.

## Consequences

- Pi Worker, Control Plane and Web capacity can grow by adding Pods and, when a
  cluster autoscaler is installed, by adding machines.
- Exact Worker steer now works from any Control Plane replica.
- A random load-balanced Sandbox Manager Deployment is explicitly unsupported;
  stable sharding keeps current live authority unambiguous.
- A rendered Chart proves the resource and security contract, but it does not
  prove multi-node availability. Node-loss, external-authority failover and
  Cube compute drain remain live acceptance work.
- Kubernetes does not create cloud machines by itself. Operators must install
  a provider-specific node autoscaler and supply suitable trusted/Cube node
  pools with correct resource requests and KVM support.
