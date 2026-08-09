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

### Product state: PostgreSQL

PostgreSQL continues to own Tenant, Workspace, Run, Attempt, Lease, Fence,
terminal settlement and materialized transcript state. Large append-only event
tables use declarative time/hash partitioning; Kafka does not become a second
business database.

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

