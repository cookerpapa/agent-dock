# Threat model

## Security claim

AgentDock executes model-generated and repository-controlled commands inside a
tenant-bound CubeSandbox KVM microVM. The trusted Agent Loop, provider
credential, database, object store and orchestration credentials remain
outside that guest.

This is a bounded self-hosted multi-tenant design. It is not a claim that one
single-node host can survive compromise of its host kernel, KVM, Cube control
plane or administrator account.

## Assets

- model/provider credentials;
- tenant conversation and Pi Session state;
- Workspace source and artifacts;
- database/object-store credentials;
- Cube and orchestration control authority;
- host and other tenants' compute/data;
- usage, audit and configuration records.

## Trust zones

```text
Untrusted:
  browser input
  prompts/model output
  repositories/dependencies
  commands and processes in Cube

Trusted product:
  Web ingress
  Control Plane
  Temporal
  Pi Workers
  Model Gateway
  Sandbox Manager
  Workspace Data Mover
  Cube egress gateway

Infrastructure TCB:
  PostgreSQL / object storage
  Cube control plane / KVM / host kernel
  deployment administrator
```

## Main threats and controls

### Tenant data access

Every API query is scoped by authenticated tenant identity. Foreign UUIDs
return `404`. Workspace activation identity includes tenant and Workspace.
Cross-tenant tests place canaries in separate Workspaces and attempt direct
reads from the other guest.

### Stale Worker side effects

RunAttempts carry a lease and monotonically increasing fencing token. Tool
execution, checkpoint CAS, terminal commit and runtime handoff validate the
current token. A recovered old Worker cannot regain authority by retaining a
process or network connection.

### Credential theft from user code

Cube receives no model, database, object-store, Temporal, Cube API or platform
credential. Tool capabilities are not included in model messages or persisted
inside `/workspace`. The guest cannot route to platform networks.

### Host discovery and escape

The guest sees its own kernel/process/filesystem environment. KVM reduces the
direct host-kernel syscall surface. The template uses fixed devices, identity
and resources, and exposes no host mount or runtime socket.

Residual risk remains for Cube/VMM/KVM/host vulnerabilities. Production
hardening should place the Cube execution plane on dedicated hosts and keep the
host patched.

### Distributed replacement and partial failure

Web and Control Plane replicas are replaceable because PostgreSQL, Temporal and
object storage remain authoritative. Pi Workers stop Temporal polling before
termination and receive a bounded drain window; a lost Worker cannot commit
after its lease/fence is superseded. Authenticated steer targets the Worker
address recorded with the current PostgreSQL assignment instead of relying on
which Control Plane replica happened to accept the browser request.

Sandbox Managers are deliberately not placed behind random load balancing.
Workspace hashing selects a stable shard across every Session sharing that
Workspace and for the lifetime of each warm activation.
One unavailable shard does not make every API replica unready, but Runs mapped
to it fail retryably until Kubernetes restores that ordinal. A replacement
Manager never adopts ambiguous guest process state: it restores committed Pi
and Workspace authorities and exposes the existing model-visible Sandbox reset
boundary. Changing the ordered shard ring without draining is unsupported.

These controls make the release multi-node-capable; they do not remove the
external PostgreSQL, Temporal, object-storage, RWX filesystem, Kubernetes
control-plane or Cube clusters from the infrastructure TCB.

### Network exfiltration and SSRF

Public Web traffic crosses the trusted egress gateway. The gateway rejects
private, loopback, link-local, metadata, reserved and platform destinations
after DNS resolution. Public egress intentionally permits source/data
exfiltration to public hosts; operators who require stronger confidentiality
must use a domain allowlist policy.

### Resource exhaustion

The Provider bounds CPU, memory, processes, open files, Workspace size,
temporary storage, command time, Run wall-clock time and output. Tenant quotas
and global Tool admission protect shared capacity. Orphan reconciliation and
idle expiry reclaim ordinary runtimes. A user-selected persistent Cube is
excluded from idle/LRU reclamation and therefore consumes an admission slot
until its conversation is archived or the execution plane explicitly destroys
it; when all slots are pinned, later Tool Runs wait rather than evicting another
tenant's persistent process world.

### Path and archive attacks

Tool file APIs normalize paths beneath `/workspace`, reject absolute/traversal
and symlink escape, bound file sizes and validate immutable checkpoint hashes.
The Data Mover never accepts an arbitrary host path from the model or browser.

### Duplicate/ambiguous side effects

HTTP admission and checkpoint commits are idempotent. Arbitrary Bash is not
automatically treated as retry-safe. A Tool operation ID is bound to one frozen
logical Turn context, one current Attempt context, one per-sampling Cloud Step
and one exact request. Short transport reconnects attach to the same
in-memory execution ledger rather than start another command. Conflicting
request reuse fails closed. If the Manager ledger, Tool service or Cube is
lost, the operation is marked unknown and the activation is destroyed and
restored from the last committed Workspace.

### Forged or prematurely visible terminal state

The Worker event channel rejects `turn.completed`, `turn.failed` and
`turn.cancelled`. A Worker can return only a private prepared result. The
Control Plane creates the public terminal event inside the same transaction as
Run/Attempt settlement, checkpoint/Workspace-head CAS and semantic projection.
A crash or notification failure therefore rolls back both the terminal event
and canonical state.

After an uncatchable Worker loss, only canonical public projections newer than
the last Pi checkpoint can enter the hidden recovery suffix. Raw model thinking
is excluded and in-flight Tool outcomes are marked unknown, preventing
untrusted partial output from becoming a claim that a side effect completed.

### Browser/admin confusion

Tenant `owner` grants only tenant authority. A separate
`platformAdministrator` identity controls deployment-wide model and proxy
settings and lands on a dedicated page. The operator tenant ID comes from
deployment configuration.

## Data retention

Conversation deletion is a soft archive. It removes the Session from ordinary
listing/direct conversation reads but retains the durable event, Pi checkpoint
and Workspace audit history for retention/recovery. A future retention worker
must delete those records under explicit policy; the browser delete action does
not silently erase a shared Workspace.

## Required evidence

Before a release:

1. run unit/integration/type checks;
2. run the real Cube template/provider gate;
3. verify no platform credential appears in guest `env` or `/proc`;
4. verify private/platform routes are denied and public proxy egress works;
5. verify cross-tenant Workspace access fails;
6. verify time/output/process limits and cancellation;
7. verify stale fences cannot execute Tools or commit checkpoints;
8. verify completed/failed/cancelled Runs leave the expected warm or destroyed
   runtime state and no orphan resources.

Historical threat models and ADRs describe superseded designs only.
