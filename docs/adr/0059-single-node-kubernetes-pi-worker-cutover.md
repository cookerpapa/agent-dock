# ADR-0059: single-node Kubernetes Pi Worker cutover

- Status: accepted
- Date: 2026-07-26
- Extends: ADR-0058

## Context

ADR-0058 makes the trusted Pi Worker pool deployable across Kubernetes nodes,
but the current interactive product still runs its Workers as Docker Compose
services. The retained host K3s is an execution-plane cluster administered by
root and used by Cube/gVisor. Its Sandbox Manager credential is intentionally
limited to untrusted execution resources and must not be expanded or abused to
install trusted application workloads.

The owner wants to exercise the Kubernetes Worker architecture on one machine
before a multi-node cluster and external high-availability stores are
available.

## Decision

1. The local cutover uses pinned k3d `v5.9.0` with K3s
   `v1.35.5-k3s1`. It creates a separate `agent-dock-workers` cluster for
   trusted Pi Workers. CubeSandbox remains on the retained host K3s/KVM plane.
2. The repository downloads k3d from its official release and verifies the
   pinned Linux AMD64 SHA-256 before installation under `.cache/tools`.
3. The existing Compose PostgreSQL, MinIO, Temporal, Control Plane, Sandbox
   Manager, GitHub Gateway, provider relay and Jaeger remain authoritative.
   The k3d server joins only their narrow Docker networks.
4. Selector-free Kubernetes Services plus operator-owned EndpointSlices bridge
   each required Compose endpoint into `agent-dock-system`. Exact endpoint
   `/32` addresses are added to the Worker NetworkPolicy. Worker Pods do not
   receive Docker access or discovery credentials.
5. Traefik exposes each Worker's management and metrics Services only through
   the k3d load-balancer container. That container joins the Compose management
   or observability network with exact per-Worker aliases; no public ingress is
   opened.
6. The Control Plane accepts only the Kubernetes Worker prefix and exact
   management URL template after cutover. Compose Worker services are
   profile-gated, stopped and removed before Kubernetes Workers begin polling.
7. The switch refuses to run while any Run is non-terminal. It persists the
   previous deployment mode, prefix, URL template and Control Plane image
   revision. A failed deployment restores the Control Plane and two Compose
   Workers automatically.
8. The Kubernetes profile uses two capacity-one StatefulSet replicas,
   `ReadWriteOnce` local-path claims and Temporal Build ID routing. The local
   storage downgrade from `ReadWriteOncePod` is explicit because this is a
   single-node fixture, not the multi-node storage profile.
9. Conversation state does not move into k3d. PostgreSQL remains the product
   authority and MinIO retains Pi-native JSONL manifests/segments. Deleting the
   local Worker cluster must not delete a committed conversation.

## Consequences

- The browser product can exercise real Kubernetes Worker scheduling while
  retaining the already validated Cube tool plane.
- The machine temporarily contains two Kubernetes clusters with different
  trust roles; their credentials and workloads are not interchangeable.
- Compose container addresses can change after recreation. Re-running the
  cutover command reconciles EndpointSlices and exact NetworkPolicy CIDRs.
- Local-path PVCs cannot prove cross-node rescheduling. Multi-node evidence
  still requires a CSI storage class, external PostgreSQL/S3 availability and
  node-loss tests.
- The local management ingress is private transport integration, not a public
  Worker API.

## Rollback

`npm run kubernetes:pi-workers:down` refuses active Runs, uninstalls the Worker
release, restores the saved Control Plane enrollment policy, starts two Compose
Workers and deletes the k3d cluster.
