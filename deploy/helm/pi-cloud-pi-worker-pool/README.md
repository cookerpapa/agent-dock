# PiCloud trusted Pi Worker pool

This chart deploys a stateless, horizontally scalable Pi SDK Worker pool. All
replicas consume the same PostgreSQL-backed Run queue. `LISTEN/NOTIFY` is only a
latency hint; PostgreSQL remains the queue and Run/Attempt authority.

Workers never execute model-generated code. `read/write/edit/bash` cross the
Tool Broker and execute in CubeSandbox. A Worker PVC contains only its boot
ledger; Pi SessionStorage in PostgreSQL is the conversation authority and Kafka
is the browser-visible live-event durability boundary.

## Required Secret

Create one Secret in the Worker namespace:

```bash
kubectl -n pi-cloud-workers create secret generic pi-cloud-pi-worker-secrets \
  --from-file=database-url=/private/pgbouncer-url \
  --from-file=database-notification-url=/private/direct-postgresql-url \
  --from-file=supervisor-enrollment-token=/private/supervisor-enrollment-token \
  --from-file=supervisor-management-token=/private/supervisor-management-token \
  --from-file=tool-broker-token=/private/tool-broker-token \
  --from-file=model-credential-master-key=/private/model-credential-master-key \
  --from-file=metrics-token=/private/metrics-token \
  --from-file=worker-event-ingest-token=/private/worker-event-ingest-token
```

The regular database URL may use PgBouncer transaction pooling. The notification
URL must target PostgreSQL directly because `LISTEN` is connection-scoped.

## Install and scale

```bash
helm upgrade --install pi-workers \
  deploy/helm/pi-cloud-pi-worker-pool \
  --namespace pi-cloud-workers \
  --set image.repository=registry.example/pi-cloud/supervisor-host \
  --set image.digest=sha256:...
```

Manual scaling changes `workerPool.replicas`. With KEDA installed, enable
`autoscaling.enabled`; the PostgreSQL scaler reads only the ready Run backlog
and targets `targetQueuedRunsPerReplica`. Every Worker still revalidates the
Run/Attempt lease and fence before effects, so duplicate wakeups are harmless.

The default NetworkPolicy allows DNS and the configured trusted ports only.
Validate rendered manifests with `npm run helm:check` before deployment.
