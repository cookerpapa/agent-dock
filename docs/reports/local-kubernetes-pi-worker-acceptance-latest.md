# Local Kubernetes Pi Worker acceptance

- Accepted: yes
- Profile: single-node k3d/K3s trusted Worker pool
- Worker replicas: 2 capacity-one Pi SDK Workers
- Scheduler: Temporal Worker Deployment and Build ID versioning
- Tool runtime: TencentCloud/CubeSandbox v0.6.0 KVM microVMs
- Model: DeepSeek `deepseek-v4-flash`

## Architecture exercised

```text
Browser
  -> Compose Control Plane
  -> Compose PostgreSQL + Temporal + MinIO
  -> single-node k3d/K3s Pi Worker StatefulSet
  -> Compose Sandbox Manager
  -> host K3s / CubeSandbox KVM Tool guest
```

PostgreSQL and MinIO remained the committed conversation authority. The
Kubernetes Worker PVCs held only replica-private boot/spool state.

## Real-model Worker failover

- First Worker: `pi-cloud-pi-worker-local-v1-1`
- Follow-up Worker after scaling out the owner:
  `pi-cloud-pi-worker-local-v1-0`
- Native Pi session artifact restored: yes
- Previous-turn marker recovered: yes
- First/follow-up settlement: 1,547 / 1,784 ms
- Additional concurrent Runs: 4
- Distinct Workers used: 2
- Concurrent settlement range: 4,496–11,345 ms
- Usage: 7 requests, 585 input, 1,407 output and 8,960 cache-read tokens

## Real-model Tool and tenant path

- Pure chat: zero Tool calls and zero Cube activation
- Pure-chat first text / settlement: 1,083 / 1,299 ms
- First and follow-up coding Runs: separate Cube microVMs
- Workspace restored into the follow-up guest: yes
- Workspace versions committed: 2
- Cross-tenant conversation access denied: yes
- Lower-level Cube tenant checks observed: 2
- Temporal Workflow histories: 3, each containing only bounded references
- Residual Session/foreign Cube guests after cleanup: 0 / 0
- Usage: 8 requests, 1,979 input, 1,723 output and 18,944 cache-read tokens

## Native compaction and checkpoint validation

The deterministic SDK integration forced Pi's compaction threshold, committed
the native JSONL checkpoint, opened it in a fresh SDK activation and preserved
the compaction entry. The v2 content-addressed manifest suite also verified
segment reconstruction and integrity checks.

## Boundary

This evidence proves the Kubernetes execution path and Worker replacement on
one machine. The chart, shared-state contract, RuntimeClass-independent Worker
design, topology policy and versioned rollout code are deployable on multiple
nodes, but actual multi-node node loss and external PostgreSQL/S3/Temporal
failover have not yet been measured.
