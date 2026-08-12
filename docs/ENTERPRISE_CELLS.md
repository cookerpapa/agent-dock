# Enterprise execution Cells and Sandbox Domains

AgentDock separates capacity sharding from sandbox control:

```text
Global plane
  PostgreSQL / Temporal / Kafka / Valkey / S3 / Web / Control Plane

Sandbox Domain
  Tool Broker replicas / Workspace Data Mover replicas / Cube cluster / RWX storage

Execution Cell
  versioned Temporal Activity Task Queue / Pi Worker pool
```

Several Cells may share one Sandbox Domain. Adding Pi Worker capacity therefore
does not clone Cube credentials, Tool Broker ownership processes or Kopia Data
Movers. Add another Domain only when Cube capacity, storage locality, compliance
or failure isolation requires a separate boundary.

The checked-in profiles are capacity envelopes, not benchmark claims:

| Profile | Cells | Worker replicas per Cell | Slots per Worker | Maximum admitted Run slots | Sandbox Domains |
| --- | ---: | ---: | ---: | ---: | ---: |
| `stage1-8-cells` | 8 | 64 | 4 | 2,048 | 1 |
| `stage2-32-cells` | 32 | 80 | 4 | 10,240 | 1 |

An Active Run occupies one Pi SDK slot. Sustainable throughput still depends
on model latency, repository size, Tool concurrency, Cube compute capacity,
PostgreSQL/event throughput and workload shape. Domain admission limits bound
the total live Cube activations independently from per-Broker protection.

The enterprise event plane uses Kafka for accepted high-frequency Worker
batches. PostgreSQL remains the Run/fence/sequence authority; Event Gateway
projects a bounded Valkey replay suffix and canonical terminal records for SSE.
KEDA scales Pi Workers from Temporal backlog and Event Gateways from Kafka lag.

## Deployment roles

The same Helm chart supports three explicit roles:

- one global release with `globalPlaneEnabled=true`;
- one Sandbox Domain release with `sandboxPlaneEnabled=true`;
- one release per execution Cell with `piWorkers.enabled=true`.

The deployment script rolls them out in this order:

1. install the Sandbox Domain Tool Broker and Data Mover;
2. install or upgrade the global plane;
3. install or upgrade every Cell's Pi Worker pool.

The Domain namespace contains the Cube credential and shared RWX Workspace
claim. Cell namespaces contain Worker credentials but no Cube management key or
Workspace filesystem. Every Cell route records a `sandboxDomainId` in
PostgreSQL, while the Domain record supplies the stable Tool Broker URL and
storage authority.

Cube owns generic microVM scheduling and lifecycle. AgentDock's Tool Broker is
deliberately narrower: it validates tenant/Workspace identity, Lease and Fence,
records Tool operation outcomes, coordinates Workspace CAS and calls Cube. The
Data Mover is an independent, horizontally replaceable service; PostgreSQL
advisory locks serialize restore/capture work for one Workspace across replicas.

## Commands

Inspect the capacity envelope without Kubernetes:

```bash
npm run enterprise:stage1:describe
npm run enterprise:stage2:describe
```

Render all releases and validate Helm schemas:

```bash
npm run enterprise:stage1:render
npm run enterprise:stage2:render
```

For a real cluster, copy the distributed values example outside the repository,
replace image and external authority endpoints, create the required Secrets and
Domain RWX claim, then run:

```bash
node scripts/enterprise-cells.mjs preflight \
  --profile deploy/enterprise/stage1-8-cells.yaml \
  --values /private/agent-dock-values.yaml

node scripts/enterprise-cells.mjs deploy \
  --profile deploy/enterprise/stage1-8-cells.yaml \
  --values /private/agent-dock-values.yaml
```

`preflight` requires KEDA, the Kubernetes Metrics API, a Ready Kafka bootstrap
service, namespace-scoped credentials and the Domain RWX Workspace claim.
Deployment is atomic per Helm release.

## Placement, draining and recovery

PostgreSQL is the durable Cell and Domain directory. New Workspaces are placed
in an active Cell; that Cell resolves to exactly one Sandbox Domain. Ordinary
bootstrap reconciliation cannot silently move an existing Workspace across
either boundary.

Cross-Cell movement is checkpoint based and never transfers a live Cube VM.
The source Cell is drained, unsettled Runs and live activations are allowed to
finish, and the Workspace route changes under a row-version fence. The current
implementation permits this operation only when source and target Cells share a
Sandbox Domain. Cross-Domain movement requires an explicit storage migration
workflow and is rejected rather than copying from an ambiguous live source.

```bash
npm run production:cell-admin -- drain \
  --source cell-0003 \
  --target cell-0007 \
  --actor 00000000-0000-4000-8000-000000000001
```

The next Run can use the committed Workspace checkpoint through any healthy
Tool Broker/Data Mover replica in that Domain. Worker affinity is only a cache
optimization and is never required for correctness.
