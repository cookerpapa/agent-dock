# Enterprise execution Cells

AgentDock scales trusted Agent execution by adding independent execution Cells rather than by
turning one cluster-wide Worker queue into an unbounded shared failure domain. PostgreSQL,
Temporal, checkpoint object storage and the Web/API plane remain global authorities. Every Cell
owns one Temporal Activity Task Queue, a replicated Sandbox Manager, a private Workspace volume
and a KEDA-scaled Pi Worker pool.

The checked-in profiles are capacity envelopes, not benchmark claims:

| Profile | Cells | Worker replicas per Cell | Slots per Worker | Maximum admitted Run slots |
| --- | ---: | ---: | ---: | ---: |
| `stage1-8-cells` | 8 | 64 | 4 | 2,048 |
| `stage2-32-cells` | 32 | 80 | 4 | 10,240 |

An Active Run occupies one Pi SDK slot. Actual sustainable throughput still depends on model
latency, repository size, Cube capacity, PostgreSQL/event-log throughput and workload shape. The
profiles deliberately provision more Sandbox admission capacity than Worker slots, so the
Sandbox Manager is not the first configured admission bottleneck.

The global event plane uses the measured-gated Kafka path. Install the Strimzi
cluster and topic from [deploy/enterprise/kafka](../deploy/enterprise/kafka/README.md) before
deploying either profile. PostgreSQL remains the Run/fence/sequence authority;
Kafka carries high-frequency Worker batches, and Event Gateway replicas build
the Valkey live replay plus PostgreSQL terminal projection consumed by SSE and
terminal settlement. KEDA
scales those replicas from Kafka consumer-group lag plus CPU, while retaining a
three-replica floor if the scaler cannot read Kafka metrics.

## Deployment topology

The same Helm chart has two explicit roles:

- one global release with `globalPlaneEnabled=true` and `executionPlaneEnabled=false`;
- one release per Cell with `globalPlaneEnabled=false` and `executionPlaneEnabled=true`.

The deployment command uses a three-step rollout:

1. install every Cell's Sandbox Manager without Pi Workers;
2. install or upgrade the global Control Plane, Event Gateway and Web plane;
3. enable every Cell's Pi Worker pool.

This order avoids a circular readiness dependency. The global Control Plane requires the Cell
Managers to be reachable, while Pi Workers require the global Control Plane for authenticated
enrollment.

Each profile also expands a distinct Cube API, proxy node and Cube domain per Cell. A real
deployment must replace the checked-in `.example.com` templates with independently scalable Cube
authorities; pointing every Cell at one Cube cluster would preserve routing isolation but not the
intended compute failure-domain isolation.

Each Cell namespace must already contain the configured platform Secret and one ReadWriteMany
Workspace PVC. Secret material is intentionally not copied by the deployment script. Cell
namespaces receive `agent-dock.io/trusted-plane=true` and a stable execution-cell label; the
global namespace receives only the trusted-plane label.

## Commands

Inspect the capacity envelope without Kubernetes:

```bash
npm run enterprise:stage1:describe
npm run enterprise:stage2:describe
```

Render every global/Cell release and validate Helm schemas:

```bash
npm run enterprise:stage1:render
npm run enterprise:stage2:render
```

For a real cluster, copy the distributed values example outside the repository, replace all
image and authority endpoints, create the per-namespace Secret/PVC objects, then run:

```bash
node scripts/enterprise-cells.mjs preflight \
  --profile deploy/enterprise/stage1-8-cells.yaml \
  --values /private/agent-dock-values.yaml

node scripts/enterprise-cells.mjs deploy \
  --profile deploy/enterprise/stage1-8-cells.yaml \
  --values /private/agent-dock-values.yaml
```

The Stage 2 command is identical except for the profile path. `preflight` requires KEDA, the
Kubernetes Metrics API, a Ready Kafka bootstrap service, all namespace-scoped credentials and RWX Workspace claims. Deployment is
atomic per Helm release; a failed Cell does not silently mutate the directory of another Cell.

## Authorities and isolation

The global bootstrap registers all Cell routes in PostgreSQL. Once a Cell owns a Workspace, its
Temporal queue, Sandbox Manager URL, Worker URL template and storage key are immutable through
ordinary bootstrap reconciliation. This prevents a configuration rollout from silently routing
an existing Workspace into a different execution boundary.

Every Cell uses a distinct namespace, Worker pool identity, Temporal queue, Workspace storage key
and POSIX volume. Kopia/object storage remains the durable checkpoint authority, so a drained
Workspace can later be moved between Cells without treating a live VM or local PVC as the source
of truth.

## Draining and cross-Cell recovery

Cross-Cell movement is an offline, checkpoint-based operation. It never transfers ownership of a
live Cube VM. The operator first marks the source Cell `draining`, which prevents new Workspace
placement there. A Workspace route moves only when it has no unsettled Run, no live/warm Sandbox
activation, no active import and—when a version exists—a settled Workspace checkpoint. The
transaction locks the Workspace and both Cell rows, advances the Workspace row-version fence,
updates both placement counters and clears Worker affinity.

Run the operation from a trusted Control Plane administration environment with
`DATABASE_URL_FILE` configured:

```bash
npm run production:cell-admin -- drain \
  --source cell-0003 \
  --target cell-0007 \
  --actor 00000000-0000-4000-8000-000000000001
```

Busy Workspaces remain in the draining Cell and are reported with a retryable reason. Re-run the
command after their Runs settle. The Cell becomes `disabled` only after its Workspace count reaches
zero. On the next Run, the destination Manager materializes the globally committed Kopia snapshot
into the destination Cell's POSIX volume. Stale data on the old Cell is not an authority and can be
garbage-collected after the migration audit has settled.
