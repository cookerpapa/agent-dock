# Local Kubernetes Pi Workers

This development profile moves the trusted Pi Worker pool from Compose into a
single-node k3d cluster while leaving the rest of the one-host topology in
Compose.

```text
k3d Pi Workers -> bridged Control Plane/PostgreSQL/Event Gateway/Tool Broker
```

Workers consume the same PostgreSQL Run queue as Compose Workers. The cutover
refuses to proceed while a Run is active, switches Control Plane management
routes, deploys the Helm pool and verifies enrollment/readiness. No Temporal
Build ID or S3 checkpoint route is involved.

```bash
npm run kubernetes:pi-workers:up
npm run kubernetes:pi-workers:status
npm run kubernetes:pi-workers:check
npm run kubernetes:pi-workers:down
```

Each Worker receives a pooled database URL plus a direct notification URL.
Conversation correctness remains in PostgreSQL; local Worker PVCs contain only
boot identity and unacknowledged event WAL.

This profile validates packaging and horizontal Worker behavior, not
multi-node availability. Use the distributed chart for external PostgreSQL,
Kafka, Valkey, Workspace storage and Cube failure testing.
