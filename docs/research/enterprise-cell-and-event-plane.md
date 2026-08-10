# Enterprise Cell and Event Plane Survey

Date: 2026-08-09

## Requirement

AgentDock must grow from the current bounded single logical execution plane to
an installation that can admit 2,000 active coding Runs and can be extended by
adding capacity cells toward 10,000 active Runs. The following invariants may
not change:

- Temporal remains the only Run scheduler;
- PostgreSQL remains the authority for product and fencing state;
- Pi native JSONL remains the conversation authority;
- browser-visible events must cross a durable acknowledgement first;
- Cube remains the only untrusted execution runtime;
- arbitrary Tool side effects are never blindly replayed.

## Adopted building blocks

### Execution orchestration: Temporal

Temporal already owns deterministic Run workflows, retries, cancellation and
Activity matching. A Cell uses a separate versioned Activity Task Queue; it
does not introduce a second scheduler. KEDA's maintained Temporal scaler can
scale each Cell's Worker pool from Activity backlog.

- <https://docs.temporal.io/>
- <https://keda.sh/docs/2.20/scalers/temporal/>

### High-frequency durable event log: Apache Kafka

Kafka is the preferred enterprise event-log candidate because a Session key
maps all of that Session's events to one ordered partition while many
partitions provide independent write and consumer parallelism. Production
adoption requires `acks=all`, idempotent production, replication and a bounded
retention/export contract.

- <https://kafka.apache.org/documentation/>
- <https://kafka.apache.org/35/configuration/producer-configs/>

Kafka is not adopted merely from a projected capacity number. AgentDock first
ships a repeatable PostgreSQL event-ingest benchmark. Kafka becomes the sole
high-frequency event-log authority only when the measured PostgreSQL profile
cannot satisfy the selected deployment SLO. The application-facing contract is
an AgentDock-owned `DurableEventLog` port so storage semantics remain testable
without leaking a client SDK into domain code.

The gate was run on 2026-08-09 against the real PostgreSQL adapter with 2,000
Sessions, 8,000 acknowledged batches and 128,000 logical events. PostgreSQL
preserved every sequence but reached 3,223 events/s and 3,592ms batch-ACK p95,
failing the 10,000 events/s and 500ms p95 target. The exact report is
[postgres-event-log-2000-latest.md](../reports/postgres-event-log-2000-latest.md).

The production Kafka deployment uses KRaft through the maintained Strimzi
operator, replicated partitions, `acks=all`, idempotent production and the
Session ID as the record key. Confluent's maintained MIT-licensed JavaScript
client is isolated behind the AgentDock `DurableEventLog` adapter. PostgreSQL
stores only bounded sequence/position and semantic projection state after the
cutover; it does not remain a second raw event authority.

- <https://strimzi.io/docs/operators/latest/deploying.html>
- <https://docs.confluent.io/kafka-clients/javascript/current/overview.html>

The initial adapter used a transactional PostgreSQL payload Outbox before
Kafka. That pattern is appropriate when a business-state update and an emitted
event must commit atomically, but the high-frequency Worker stream had no such
source mutation: the Worker WAL was already the retry source and PostgreSQL
later stored the same payload as the browser projection. ADR-0091 therefore
replaces the transfer table with an authenticated Event Gateway ingest. The
gateway validates Session/lease/fence state, waits for the idempotent Kafka
producer ACK, and persists only bounded cursor metadata. This removes the
second payload copy while preserving fail-closed terminal ordering.

- <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>
- <https://kafka.apache.org/40/configuration/producer-configs/>

### Live replay read model: Valkey Streams

Kafka is optimized for retained ordered transport, while browser SSE needs a
cheap Session-and-sequence range read. Event Gateway therefore projects the
acknowledged Kafka prefix into Valkey Streams with explicit sequence IDs.
Valkey is bounded and rebuildable; PostgreSQL stores the projected high-water,
terminal canonical Turn and replay floor. The projector must append Valkey
before advancing that high-water, so a browser cannot observe an uncommitted
or missing range. `noeviction`, persistence and HA are deployment requirements.

- <https://valkey.io/topics/streams-intro/>
- <https://valkey.io/topics/persistence/>

### Product state: PostgreSQL

PostgreSQL continues to own Tenant, Workspace, Run, Attempt, Lease, Fence,
terminal settlement and materialized transcript state. Streaming text and Tool
deltas do not become a lifetime PostgreSQL table; Kafka/Valkey do not become a
second business database.

- <https://www.postgresql.org/docs/current/ddl-partitioning.html>

### Sandbox scheduling: CubeSandbox

CubeMaster and Cubelet already schedule microVMs across Cube compute nodes.
AgentDock must not recreate that scheduler. AgentDock's Sandbox Manager is a
policy, identity, lease and checkpoint gateway. Its durable activation
directory is externalized so several Manager replicas in one Cell can recover
or reject an ambiguous operation rather than relying on a fixed process-local
hash ring.

- <https://github.com/TencentCloud/CubeSandbox>
- <https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.6.0>

Cube's Kubernetes deployment is preview in v0.6.0. It must be pinned and pass a
multi-node acceptance suite before an AgentDock release claims production HA.

### Kubernetes scaling and availability

HPA scales stateless HTTP/event services, KEDA scales Temporal Worker pools,
and a provider-specific node autoscaler supplies machines. Topology spread and
PodDisruptionBudgets reduce voluntary disruption but do not replace application
recovery from node loss.

- <https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/>
- <https://kubernetes.io/docs/concepts/workloads/pods/disruptions/>
- <https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/>

## Build-versus-adopt decision

AgentDock builds only the bounded glue that no adopted component owns:

- a Workspace-to-Cell directory;
- Cell-aware Task Queue and Sandbox routing;
- a durable activation/operation state adapter around Cube;
- the exact event envelope, settlement barrier and Pi recovery bridge;
- capacity/fairness policy and product-specific observability.

AgentDock does not build a workflow engine, distributed log, KVM scheduler,
database replication system, Kubernetes autoscaler or distributed filesystem.

## Exit and rollback

- Cell assignment is stored explicitly on each Workspace; adding a Cell does
  not remap existing Workspaces.
- The event log is behind `DurableEventLog`; every retained event can be
  exported by Session and sequence to PostgreSQL/object storage.
- A deployment may remain on the PostgreSQL implementation while it meets its
  measured SLO. A migration to Kafka is a one-way authority cutover at a
  recorded sequence barrier, not dual active publication.
- Cube handles and activation metadata contain no Cube management credential,
  so another Manager replica can reconcile committed identity without moving
  credentials into a Worker or guest.
