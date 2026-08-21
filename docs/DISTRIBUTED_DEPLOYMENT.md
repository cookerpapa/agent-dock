# Distributed Kubernetes deployment

The chart deploys replaceable Web, Control Plane, Pi Worker,
Tool Broker and persistent Volume gateway replicas. It does not install the
external durable authorities.

## External requirements

- PostgreSQL HA plus optional PgBouncer;
- one direct PostgreSQL connection for migrations, `LISTEN/NOTIFY` and KEDA;
- ReadWriteMany persistent Workspace storage visible to Cube Volume Plugin and
  trusted Volume gateway replicas;
- Cube control/compute plane;
- KEDA, Metrics API, CNI NetworkPolicy and a node autoscaler.

## Topology

```text
Ingress -> Web / Control Plane
                         │
             PostgreSQL ready Run queue
                         │
                shared Pi Worker replicas
                         │
               replicated Tool Broker
                         │
                     Cube API
                         │
                 Cube KVM compute nodes
                         │
              persistent Workspace storage

Worker events -> PostgreSQL group commit -> LISTEN/NOTIFY -> SSE
```

There are no execution Cells or Worker-affinity queues. A Workspace binds to a
Sandbox Domain for Cube/storage locality; any Pi Worker may execute its next
Run.

Do not confuse a live RunAttempt's `worker_id` with affinity. It identifies the
replica that currently heartbeats and executes that one fenced Attempt. It does
not influence placement of the Session's next Run, and no private Worker queue
or durable preferred-Worker record exists after the current migrations finish.

## Deploy

Copy the example outside the repository and replace endpoints, images, UUIDs
and CIDRs:

```bash
cp deploy/helm/pi-cloud-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:render -- --values values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

The platform Secret must contain database URLs, API/bootstrap credentials,
Cube/Tool credentials and metrics tokens.
No S3 or Temporal credential is required.

## Scaling

- Control Plane/Web scale by CPU;
- Pi Workers scale by PostgreSQL ready Run backlog;
- Tool Broker and Volume gateway scale independently;
- Cube compute and underlying nodes scale from active Sandbox demand.

KEDA is not a queue authority. If it or its metric is unavailable, the
configured minimum Workers continue polling PostgreSQL.

## Rollout and failure

Workers use rolling replacement and a long termination grace so active Runs can
settle or lose authority safely. Correctness does not depend on a stable Worker
ordinal or local Session cache. A replacement reconnects to PostgreSQL and may
claim any ready Run.

Before claiming high availability, test on the actual storage/network stack:

- Worker and node loss during model and Tool calls;
- PostgreSQL/PgBouncer failover and notification reconnect;
- PostgreSQL hot-event retention and SSE reconnect;
- Tool Broker/Volume gateway owner loss;
- Cube compute-node drain and persistent Volume reattachment;
- KEDA and node-autoscaler scale-up/down under real backlog.
