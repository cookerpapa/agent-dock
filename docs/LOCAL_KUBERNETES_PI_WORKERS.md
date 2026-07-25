# Local single-node Kubernetes Pi Workers

This profile moves only the trusted Pi Worker pool into a Docker-managed,
single-node k3d/K3s cluster:

```text
Browser
  -> Compose Control Plane
  -> Compose PostgreSQL + Temporal + MinIO
  -> k3d/K3s Pi Worker StatefulSet
  -> Compose Sandbox Manager
  -> retained host K3s / CubeSandbox KVM Tool guest
```

It deliberately does not move conversation state into Kubernetes. PostgreSQL
stores product/control state, MinIO stores Pi JSONL segments/manifests, and a
Worker PVC stores only that Worker replica's boot ledger and unacknowledged
event spool.

## Prerequisites

- the existing production Compose stack and Cube plane are healthy;
- Docker is available to the current user;
- no Run is active during the short cutover;
- at least 4 GiB of Docker memory is available for the k3d server and two
  capacity-one Workers.

No root K3s credential or passwordless sudo is required. The pinned k3d binary
is fetched from the official release and checksum-verified automatically.

## Cut over

```bash
npm run kubernetes:pi-workers:up
```

The command:

1. refuses a dirty source tree or non-terminal Run;
2. creates the pinned single-node cluster and private kubeconfig, imports the
   version-matched K3s system images through Docker's configured registry
   transport, and waits for DNS, storage and private ingress readiness;
3. joins the k3d server to the narrow Compose networks;
4. creates selector-free Services and EndpointSlices for trusted dependencies;
5. builds and imports an exact-revision Supervisor image;
6. saves the current Control Plane Worker policy;
7. stops/removes Compose Workers and recreates only the Control Plane;
8. installs two Kubernetes Worker replicas and explicitly waits for both
   application readiness probes;
9. waits until Temporal observes the exact Worker Build ID, then makes it
   current;
10. verifies Control Plane management reachability, enrollment and Temporal
    version metadata.

The explicit system-image import matters on developer machines whose Docker
daemon can reach public registries through a desktop proxy but whose nested
k3d node cannot. A Helm release being accepted is not treated as readiness:
the cutover does not commit until the Kubernetes system plane, Worker Pods and
Temporal registration are all ready.

The operator also migrates the immutable StatefulSet claim template emitted by
the first local chart revision. It recreates only the drained controller and
Pods; retained Worker PVCs and all external conversation state remain intact.

Inspect without exposing credentials:

```bash
npm run kubernetes:pi-workers:status
npm run kubernetes:pi-workers:check
```

The local kubeconfig and switch state are private runtime files under
`deploy/production/runtime/kubernetes/` and are excluded from Git.

## Roll back

Wait for all Runs to settle, then:

```bash
npm run kubernetes:pi-workers:down
```

This restores the saved Compose enrollment policy, starts two Compose Workers
and deletes the disposable k3d cluster. Committed conversations and Workspaces
remain in PostgreSQL/MinIO.

## Scope

Passing this profile proves the Kubernetes control/data path on one machine. It
does not prove:

- node-loss rescheduling;
- multi-node `ReadWriteOncePod` storage attachment;
- PostgreSQL, S3 or Temporal high availability;
- cross-zone networking or capacity.

Those remain separate multi-node acceptance evidence.
