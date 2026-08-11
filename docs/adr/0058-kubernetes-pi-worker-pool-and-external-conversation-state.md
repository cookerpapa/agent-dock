# ADR-0058: Kubernetes Pi Worker pool and external conversation state

- Status: accepted
- Date: 2026-07-26
- Extends: ADR-0054 and ADR-0056

## Context

Temporal already assigns each Run Activity directly to one available Pi SDK
Worker slot. PostgreSQL and S3-compatible storage already let a later Run resume on a
different Worker. The supported deployment nevertheless starts the Workers as
Docker Compose replicas on one host.

Moving the trusted Worker pool to Kubernetes creates four design questions:

1. whether Worker Pods are really stateless and interchangeable;
2. how a Worker keeps its authenticated Supervisor identity and crash-safe
   unacknowledged event spool after Pod replacement;
3. how Workflow code upgrades avoid replay incompatibility;
4. where conversation state lives when Workers span nodes.

Kubernetes Deployment Pods are interchangeable. AgentDock Workers are
replaceable with respect to Sessions, but each live Worker identity owns a
private boot ledger and event spool. Replacing a Pod must reconnect the same
stable Supervisor ID to the same private local recovery state. Those bytes are
not conversation authority, but discarding them can lose owner-stop evidence or
an event that was fsynced before its PostgreSQL ACK.

Temporal's official Worker Controller automates versioned Kubernetes
Deployments, rainbow rollout, and HPA/KEDA scaling. Its Deployment lifecycle
does not provide one stable volume per Worker replica. Adopting it without first
moving AgentDock's local spool to another durable authority would weaken the
current crash contract.

## Decision

1. AgentDock adds a separate `agent-dock-pi-worker-pool` Helm chart for the
   trusted application plane. CubeSandbox remains the untrusted Tool execution
   plane; the Pi Worker chart does not deploy or impersonate Cube.
2. One Kubernetes StatefulSet Pod equals one bounded-capacity Pi SDK Worker
   process. `podManagementPolicy: Parallel` permits horizontal scale-out
   without imposing application ordering between Workers.
3. The StatefulSet Pod name is the stable Supervisor ID. A private
   `ReadWriteOncePod` PVC holds only its boot ledger and unacknowledged/quarantine
   event spool. Scaling down or deleting the StatefulSet retains those claims by
   default.
4. Every Worker Pod receives memory-backed temporary and session directories.
   Its ten-minute immutable-object cache is discardable. No conversation,
   Workspace head, model transcript, or tenant-owned artifact is authoritative
   on the Worker PVC.
5. Kubernetes per-Pod ClusterIP Services give every Worker a management address
   shaped as:

   ```text
   http://{supervisorId}.{workerNamespace}.svc.{clusterDomain}:4100
   ```

   One existing Control Plane URL template can therefore validate multiple
   blue/green Worker pools without trusting a Worker-chosen URL.
6. Worker Pods have no ServiceAccount token, Kubernetes or container-runtime
   socket, host namespace, host mount, or untrusted Tool implementation. They
   run as UID/GID 1000 with a read-only root filesystem, all capabilities
   dropped, default seccomp, bounded resources, topology spreading, preferred
   anti-affinity, a PodDisruptionBudget, and explicit trusted-plane
   NetworkPolicy.
7. Kubernetes Secret projection is group-readable only by the Pod fsGroup. The
   Supervisor secret loader now accepts bounded regular files that are
   owner-private (`0600`/`0400`) or private to one effective group
   (`0640`/`0440`), while continuing to reject every `other` permission,
   executable bit, symlink, unbounded file, or unreadable owner/group.
8. The chart requires an existing Secret and external service endpoints. It
   does not deploy PostgreSQL, object storage, Temporal, the Control Plane,
   Sandbox Manager, GitHub Gateway, or provider relay.
9. Conversation ownership remains split:

   ```text
   PostgreSQL
     Session/Run/Attempt/Turn, durable events, semantic projection,
     compaction audit, usage, checkpoint head and fence/revision CAS

   S3-compatible object storage
     immutable Pi-native JSONL segments/manifests, Workspace snapshots,
     artifacts and large Tool output

   Temporal
     bounded Run Workflow history and Task Queue delivery only

   Worker PVC
     boot ledger and not-yet-ACKed event spool only
   ```

10. Worker Versioning is mandatory in the Kubernetes chart. Each pool reports a
    common Worker Deployment name plus an immutable Build ID tied to the exact
    image revision. Run Workflows default to `PINNED`, because they are bounded
    and should finish on the Workflow code revision where they started.
11. New code is deployed as a second Helm release and Worker pool. Operators
    make the new Temporal Worker Deployment Version current or ramping only
    after its Workers poll successfully. The old pool remains while pinned
    Workflows drain. The StatefulSet itself uses `OnDelete` so a normal Helm
    upgrade cannot silently mix binaries by rolling Pods in place.
12. The Temporal Worker Controller v1.8.0 is not adopted in this slice. Revisit
    it after the private event spool either becomes an external durable service
    or the controller supports the required stable per-replica storage
    contract. Temporal Worker Versioning itself is adopted through the official
    TypeScript SDK and Server 1.29.1.
13. The current Compose profile remains the supported local product. The chart
    makes the Worker contract deployable across nodes, but a multi-node
    availability or throughput claim requires a real multi-node cluster,
    external PostgreSQL/S3 HA, private routing, node-loss tests, and measured
    evidence.

## Consequences

- Adding Kubernetes nodes and increasing a Worker pool's replica count adds
  independent Pi Agent Loop capacity without moving Session state.
- A Worker Pod can be rescheduled to a different node only when its storage
  class can reattach the private state PVC there.
- PostgreSQL connection limits, S3 request capacity, Temporal poller capacity,
  provider egress, and the separate Cube admission limit must all be sized when
  increasing replicas.
- `StatefulSet` is used for private delivery recovery state, not because a
  historical Session is pinned to a Worker.
- PostgreSQL and S3 become explicit shared platform dependencies. Running one
  non-replicated database or MinIO instance beside a multi-node Worker pool
  would preserve functional correctness but not deliver high availability.
- Build-ID routing avoids unsafe in-place Workflow upgrades, but requires an
  operator promotion/drain procedure.

## Evidence

- the Helm schema fixes Worker capacity at one and rejects one-replica,
  over-capacity, invalid-PDB, and unknown-policy configurations;
- the chart gate verifies stable identity, private PVCs, per-Pod management
  Services, no runtime/host authority, secret projection mode, external
  PostgreSQL/S3 configuration, NetworkPolicy, resource limits, PDB, and a
  second immutable Build-ID render;
- Supervisor configuration tests prove versioning is complete-or-rejected and
  private group-readable Kubernetes Secret projection remains accepted;
- runtime tests prove the configured Deployment name and Build ID reach the
  Temporal Worker factory;
- existing real-token Worker-pool evidence proves common-Task-Queue
  distribution, cross-Worker Pi checkpoint restore, native compaction, and
  multi-tenant isolation independently of the container orchestrator.
