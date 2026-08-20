# Threat model

## Scope

PiCloud is a self-hosted multi-tenant Coding Agent for controlled enterprise
or private deployments. Model-generated commands and repository code are
untrusted. Platform operators, trusted Worker images and external durable
services are inside the administrative trust boundary.

It is not claimed as a hostile public-SaaS boundary without additional abuse,
identity recovery, billing and incident-response controls.

## Primary boundaries

### Trusted Agent versus untrusted execution

Pi, model credentials, PostgreSQL access and Tool capabilities remain in the
trusted Worker. CubeSandbox KVM executes `read/write/edit/bash` and receives no
platform credential. The Worker has no Cube API credential; the Tool Broker has
no model credential.

### Tenant and stale-Worker isolation

Every product read/write includes tenant ownership. Tool and Session mutation
boundaries additionally validate current Run, Attempt, claim lease and fencing
token. A paused or partitioned old Worker cannot resume useful effects after a
new Attempt takes ownership.

### Durable authorities

PostgreSQL owns Runs and Pi Sessions, Kafka owns retained live events, and the
persistent Cube Volume owns Workspace bytes. Valkey and Worker caches are
rebuildable. There is no competing workflow or checkpoint head.

## Key threats and controls

| Threat | Control |
| --- | --- |
| shell escapes container boundary | Cube KVM hardware boundary and hardened template |
| Cube reads platform secrets | no secret mounts/service account/platform route |
| cross-tenant Workspace access | stable tenant/Workspace Volume identity and broker checks |
| browser forges terminal identity | Control Plane derives tenant/Workspace/Session; browser frames carry only input/resize/control |
| user enumerates another user's development environment | every list, lifecycle and Terminal lookup binds tenant plus authenticated owner user; no Cube ID is public |
| terminal races an Agent writer | PostgreSQL-backed human-terminal lease and shared Workspace writer exclusion |
| exclusive environment races an Agent writer | PostgreSQL Worker admission excludes every live development-environment state for that Workspace |
| stale Worker mutation | transaction-scoped authority and monotonically increasing fence |
| duplicate queue delivery | idempotent command plus transactional RunAttempt claim |
| ambiguous shell result | `UNKNOWN`; no automatic replay |
| SSRF/data exfiltration to internal network | governed egress proxy and deny network policy |
| path/symlink escape | rooted/O_NOFOLLOW trusted Volume operations |
| infinite output/process/resource use | byte, timeout, PID, CPU, memory and disk limits |
| browser observes non-durable output | Kafka ACK and projected watermark before SSE |
| Valkey loss | rebuild from retained Kafka |
| Cube loss | process world reset marker plus same persistent Workspace Volume |
| secret leakage in events | bounded schemas and redaction; credentials never enter model context |

Public network mode can still upload the current tenant's code to public
destinations. KVM isolation protects the platform and other tenants; it is not
a data-loss-prevention system. Enterprise deployments should add explicit
destination allowlists and audit.

Workspace Web Terminal access does not expose SSH or Cube envd to the public;
the PiCloud image does not run envd at all. It uses the logged-in user's
tenant role, the fenced Cube Tool Service, a separate Control
Plane-to-Tool-Broker credential and bounded WebSocket frames. Terminal output
is intentionally not a durable conversation record; ordinary Workspace file
persistence and platform audit metadata remain authoritative.

## Not guaranteed

- exactly-once arbitrary shell or external side effects;
- process/memory/socket survival after Cube destruction;
- historical Workspace rollback without a storage-backend snapshot policy;
- safety from a Cube/KVM/hypervisor escape vulnerability;
- multi-node disaster recovery unless PostgreSQL, Kafka and Workspace storage
  are deployed and tested for it.
