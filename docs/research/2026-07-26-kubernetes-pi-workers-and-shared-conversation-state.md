# Kubernetes Pi Workers and shared conversation-state research

- Date: 2026-07-26
- Scope: trusted Pi Worker lifecycle, Temporal rollout/versioning, and external
  conversation persistence
- Source policy: official project documentation, repositories, releases, and
  licenses

## Conclusion

The right target is not “put every Session inside a Kubernetes Pod.” It is:

```text
Kubernetes
  creates/restarts/spreads capacity-one trusted Pi Workers

Temporal
  matches bounded Run Workflows to available Workers

PostgreSQL + S3
  let any Worker restore the exact committed Session

CubeSandbox
  runs only the untrusted Tool calls
```

A StatefulSet is selected for the Worker pool because each Worker identity
retains a small private boot/event-delivery recovery volume. Session and
conversation data remain external, so the StatefulSet does not create Worker
affinity for users.

## Evaluated primitives

### Kubernetes StatefulSet

Kubernetes documents StatefulSet as the workload controller for Pods that need
stable unique identity and persistent storage across rescheduling. Each ordinal
can receive its own persistent claim, while `Parallel` Pod management permits
independent replicas to start and stop concurrently.

This matches PiCloud's current boot-ledger/event-spool contract. Kubernetes
also recommends `ReadWriteOncePod` when one Pod must exclusively mount a claim.

Sources:

- <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/>
- <https://kubernetes.io/docs/concepts/storage/persistent-volumes/>
- <https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/>

### Kubernetes Deployment

A Deployment is the simpler choice for interchangeable stateless pollers. It
would be preferable if the Worker held no private crash-recovery bytes.
PiCloud cannot use it honestly today because a replacement Pod would not
automatically reacquire the previous Pod's unacknowledged event spool and boot
ledger.

Decision: do not weaken the delivery contract merely to use a simpler
controller.

### Temporal Worker Versioning

Temporal recommends Worker Versioning for new production Workflow deployments.
A Worker Deployment Version is identified by Deployment name plus Build ID.
Pinned Workflows remain on the version where they started; current/ramping
versions control new Workflow routing and permit rollback.

The installed TypeScript SDK is `1.21.1`. The self-hosted Server image is
Temporal `1.29.1`, which is the documented minimum Server version for current
Worker Deployment Versioning. PiCloud's per-Run Workflow is bounded, so
`PINNED` is a better fit than automatically moving one Run between revisions.

Sources:

- <https://docs.temporal.io/production-deployment/worker-deployments>
- <https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning>
- <https://docs.temporal.io/worker-versioning>
- <https://github.com/temporalio/sdk-typescript>

### Temporal Worker Controller

Temporal's MIT-licensed Worker Controller is the official Kubernetes automation
for versioned Worker Deployments. Release `v1.8.0` was published on
2026-06-29. It supports version registration, progressive/rainbow rollouts,
drain cleanup, HPA, and KEDA. Its own guidance prefers:

- HPA plus Prometheus adapter for continuously loaded queues and large queue
  counts;
- KEDA for scale-to-zero, long idle periods, or faster first-backlog reaction.

The Controller creates and manages Kubernetes Deployments. PiCloud currently
needs stable per-replica private storage, so adopting it would either discard
delivery state or require a separate spool migration first.

Decision: adopt Temporal Worker Versioning now; defer Worker Controller
automation until the storage contract fits its Deployment lifecycle.

Sources:

- <https://docs.temporal.io/production-deployment/worker-deployments/kubernetes-controller>
- <https://github.com/temporalio/temporal-worker-controller>
- <https://github.com/temporalio/temporal-worker-controller/blob/main/docs/scaling-recommendations.md>

## Conversation storage

### Why it must be independent

If Session state lived on a Worker node, a later message could only run on that
node. Node loss would lose the Session, and Temporal would not be free to assign
the next Run to another poller. Horizontal scaling therefore requires shared
authorities reachable by every trusted Worker.

The existing split is retained:

| Authority | Stored data | Reason |
| --- | --- | --- |
| PostgreSQL | tenancy, mailbox order, Run/Attempt, lease/fence, events, semantic Turn projection, usage, compaction audit, checkpoint head | transactional/queryable product state |
| S3-compatible store | Pi JSONL segments/manifests, Workspace versions, artifacts | immutable large/private bytes |
| Temporal | bounded Run identifiers and orchestration transitions | scheduling/retry/cancellation history |
| Worker PVC | boot ledger and unacknowledged event spool | private Worker crash recovery only |
| Worker memory/tmpfs | active Pi runtime, verified reconstructed JSONL, ten-minute object cache | disposable acceleration |

The Pi-native checkpoint is not replaced by a relational `messages[]` array.
It preserves Pi's session tree, Tool/model entries, branches, and compaction
boundaries. PostgreSQL semantic projections remain the efficient Web read model.

### PostgreSQL HA candidate

For a self-hosted Kubernetes database, CloudNativePG is the strongest
foundation-backed candidate evaluated here. It is Apache-2.0, actively
maintained, and its current `v1.30.0` release was published on 2026-06-29. Its
operator manages a primary with hot standbys, failover, rolling updates,
backups, and services that follow the current writer. Its documentation
recommends shared-nothing replicas across nodes/zones.

PiCloud does not bundle CloudNativePG in the Worker chart. Database lifecycle,
backup, storage class, RPO/RTO, and availability-zone policy are a separate
operator concern. The Worker contract accepts one PostgreSQL URL, so a managed
database, CloudNativePG `-rw` Service, or another compatible HA endpoint can be
used without changing Worker code.

Sources:

- <https://cloudnative-pg.io/>
- <https://cloudnative-pg.io/documentation/current/architecture/>
- <https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.30.0>

### Object storage

The Worker contract targets the S3 API rather than a MinIO-specific SDK.
Single-host MinIO remains the local fixture. A multi-node profile must use a
durable S3-compatible service with independent replication/backup and measure
manifest/segment restore p50/p95 before making an availability claim.

## Scaling rule

Increasing replicas is safe only when all downstream capacities are considered:

```text
effective chat concurrency
  <= ready Pi Workers

effective coding concurrency
  <= min(ready Pi Workers, global Cube admission)

and also bounded by:
  PostgreSQL connections
  S3 request/throughput capacity
  Temporal Task Queue and Server capacity
  provider rate limits
  model-egress proxy capacity
```

CPU-based autoscaling alone is not yet selected. A Pi Run can be waiting on a
model while CPU is low. The next autoscaling step should use Temporal slot
utilization plus Task Queue schedule-to-start/backlog evidence, then choose HPA
or KEDA using the official Controller guidance.
