# AgentDock trusted Pi Worker pool chart

This chart deploys a trusted Pi SDK Worker pool with a bounded number of runtime
slots per Pod. It does not
deploy CubeSandbox, PostgreSQL, S3/MinIO, Temporal, the Control Plane, or any
untrusted code-execution runtime.

## State boundary

Every Worker may run on any Kubernetes node and poll the same Temporal Task
Queue. Durable Session state is external:

```text
PostgreSQL  -> Session/Run/Attempt/events/checkpoint head
S3          -> Pi JSONL segments/manifests and Workspace artifacts
Worker PVC  -> this Worker's boot ledger and unacknowledged event spool only
```

Deleting one Worker Pod never deletes a committed conversation. The replacement
Pod keeps the same Supervisor ID and private state claim, while any healthy
Worker can restore the next Session Run from PostgreSQL/S3.

## Prerequisites

- Kubernetes 1.30 or newer;
- Temporal Server 1.29.1 or newer;
- the exact AgentDock Supervisor image pushed to a registry or preloaded;
- external PostgreSQL and S3-compatible endpoints reachable on the private
  trusted network;
- Control Plane, Sandbox Manager, provider relay, and optional GitHub Gateway
  reachable from the Worker namespace;
- the Worker namespace and trusted service namespaces labeled:

  ```bash
  kubectl create namespace agent-dock-workers
  kubectl create namespace agent-dock-system
  kubectl label namespace agent-dock-workers agent-dock.io/trusted-plane=true
  kubectl label namespace agent-dock-system agent-dock.io/trusted-plane=true
  ```

If `agent-dock-system` already exists, omit its create command and only apply
the label.

The default NetworkPolicy allows only DNS, labeled trusted namespaces on the
closed port list, and explicitly configured external CIDRs.

## Secret

Create one existing Secret; never store these values in a Helm values file:

```bash
kubectl -n agent-dock-workers create secret generic agent-dock-pi-worker-secrets \
  --from-file=database-url=/private/database-url \
  --from-file=aws-credentials=/private/aws-credentials \
  --from-file=supervisor-enrollment-token=/private/supervisor-enrollment-token \
  --from-file=supervisor-management-token=/private/supervisor-management-token \
  --from-file=sandbox-manager-token=/private/sandbox-manager-token \
  --from-file=model-credential-master-key=/private/model-credential-master-key \
  --from-file=github-gateway-token=/private/github-gateway-token \
  --from-file=metrics-token=/private/metrics-token
```

Kubernetes projects these files as decimal mode `288` (`0440`) and assigns the
Pod's private fsGroup. No credential is placed in an environment variable.

## Control Plane enrollment policy

For a release installed in `agent-dock-workers`, configure:

```text
AGENT_DOCK_SUPERVISOR_ID_PREFIX=agent-dock-pi-worker-
AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE=http://{supervisorId}.agent-dock-workers.svc.cluster.local:4100
AGENT_DOCK_SUPERVISOR_MAXIMUM_CAPACITY=16
```

The chart creates one ClusterIP management Service whose name exactly matches
each StatefulSet Pod/Supervisor ID. This keeps one operator-owned URL template
valid for multiple blue/green pools.

## First version

Use an immutable image digest and use the same source/image revision as the
Temporal Build ID:

```bash
revision="$(git rev-parse HEAD)"

helm upgrade --install pi-workers-v1 \
  deploy/helm/agent-dock-pi-worker-pool \
  --namespace agent-dock-workers \
  --set workerPool.name=primary-v1 \
  --set temporal.workerBuildId="$revision" \
  --set image.repository=registry.example/agent-dock/supervisor-host \
  --set image.digest="sha256:..." \
  --set image.pullPolicy=IfNotPresent
```

After the new version is polling successfully, activate it:

```bash
temporal worker deployment set-current-version \
  --address temporal.agent-dock-system.svc.cluster.local:7233 \
  --namespace agent-dock \
  --deployment-name agent-dock-pi-workers \
  --build-id "$revision"
```

The first version is not eligible for new versioned Workflows until it becomes
the Deployment's Current version.

## Scale and upgrade

Bind each release to exactly one immutable execution Cell with
`workerPool.executionCellId` and the Cell's `temporal.taskQueue`. Scale one
unchanged build by changing `workerPool.replicas`. Each added ordinal
gets its own Supervisor ID, management Service, and `ReadWriteOncePod` state
claim.

Do not replace the image/Build ID in place. Install a second Helm release with a
different `workerPool.name`, verify its pollers, set it as Ramping or Current,
and leave the old pool alive until Temporal reports the old pinned Workflow
version drained. Then uninstall the old release. The StatefulSet uses
`OnDelete` specifically to prevent an accidental Helm update from silently
mixing revisions through an automatic rolling restart.

Temporal's Worker Controller was evaluated but is not installed by this chart:
it owns versioned Kubernetes Deployments, while the present AgentDock event
spool requires stable per-replica PVC identity. See
[`ADR-0058`](../../../docs/adr/0058-kubernetes-pi-worker-pool-and-external-conversation-state.md).

## Validation

```bash
npm run helm:check
npm run typecheck --workspace @agent-dock/supervisor-host
npm run test --workspace @agent-dock/supervisor-host
```

The chart gate verifies bounded runtime capacity (four slots by default), Cell
identity and Task Queue, stable identity/PVCs, per-Pod management routing, Build
ID configuration, restricted Secret modes, NetworkPolicy, resource/security
settings, blue/green rendering, and rejects unknown or unsafe values.

A rendered or single-node installation is not a multi-node availability claim.
Before claiming that, run Worker/node-loss, database/object-store failover,
version ramp/rollback, and concurrent real-token tests on the target cluster.
