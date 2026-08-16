# Enterprise Worker event log

Phase 2 uses an external Kafka cluster for high-frequency Worker events. Install
the Strimzi operator first, label the namespace that runs the operator according
to local policy, and then apply these manifests:

```bash
kubectl apply -f deploy/enterprise/kafka/namespace.yaml
kubectl apply -f deploy/enterprise/kafka/cluster.yaml
kubectl -n pi-cloud-eventing wait kafka/pi-cloud-kafka \
  --for=condition=Ready --timeout=20m
```

The checked-in capacity is the Stage 2 baseline: six brokers, 256 partitions,
replication factor three and `min.insync.replicas=2`. Its internal listener is
TLS-only on port 9093 and requires SCRAM-SHA-512. The checked-in `KafkaUser`
limits the Event Gateway to the Worker-event topic, projector consumer group
and idempotent producer operation. Storage-class selection and any additional
dedicated-node labels remain operator-specific. Do not expose the listener
outside the trusted cluster network.

The production manifest deliberately requires three Kubernetes availability
zones and separate hosts for members of each node pool. Label Kafka worker
nodes with `topology.kubernetes.io/zone` and provide at least three controller
hosts plus six broker hosts before applying it. Strimzi rack awareness uses the
same zone label so replicas are distributed across failure domains instead of
only across processes on one machine.

Strimzi creates the user password in
`pi-cloud-eventing/pi-cloud-event-gateway` and the CA in
`pi-cloud-eventing/pi-cloud-kafka-cluster-ca-cert`. Before the global plane
is deployed, synchronize those values into the global namespace's existing
platform Secret under these keys:

```text
kafka-username = pi-cloud-event-gateway
kafka-password = generated Secret key `password`
kafka-ca.crt    = generated Secret key `ca.crt`
```

Use the organization's External Secrets/secret replication controller for
continuous synchronization. PiCloud's enterprise preflight fails closed when
any of the three keys is absent. Neither value is copied to a Pi Worker or Cube
sandbox.

PiCloud uses Kafka as the enterprise Worker stream's first shared payload
durability boundary. Pi Workers call an authenticated internal Event Gateway
endpoint and never receive Kafka credentials. A cumulative Worker ACK means
Kafka accepted the ordered Session-keyed batch; the consumer group then
projects it idempotently into Valkey before committing its consumed offset and
projected high-water mark to PostgreSQL. Browser SSE reads only that covered
Valkey prefix plus PostgreSQL terminal Turn rows. Terminal Run commits wait for
the projected cursor and complete canonical transcript, so a completed Turn
never overtakes its visible text or Tool events.

The global platform Secret must also contain the independent
`worker-event-ingest-token` key configured by
`external.eventIngest.tokenSecretKey`. This credential is shared only by
trusted PiCloud Workers, Control Plane and Event Gateway; it must not be
copied into Cube guests.

The same Secret must contain `live-event-store-url`, pointing to an HA Valkey
deployment with persistence and `noeviction`. Valkey is a rebuildable read
model, not a business-state authority. Keep Kafka topic retention longer than
PiCloud's live replay window. Configure an explicit data-memory ceiling below
the Pod/container limit; retain `noeviction` so saturation is visible rather
than silently removing replay data. Event Gateway startup checks the retained
live range and automatically rebuilds missing streams from Kafka under a
PostgreSQL advisory lock. It will not become ready if Kafka can no longer cover
that range.

For controlled maintenance, disable automatic repair, stop the normal Event
Gateway projector, point its configuration at a fresh empty Valkey instance,
and run the same rebuild implementation manually. From a source checkout:

```bash
npm run events:rebuild-live
```

It replays only sequences above each Session's PostgreSQL replay floor and at
or below its Kafka-accepted cursor. Restart Event Gateway after the rebuild; do
not run manual rebuild concurrently against a non-empty live read model during
traffic.
