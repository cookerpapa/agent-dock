# Cursor Cloud Agent lessons and AgentDock adoption map

- Date: 2026-07-22
- Scope: official Cursor engineering material only
- Purpose: turn useful product and infrastructure lessons into testable
  AgentDock work, without copying proprietary implementation details or
  weakening AgentDock's fail-closed security boundary.

## Sources

- [What we've learned building cloud agents](https://cursor.com/blog/cloud-agent-lessons),
  published 2026-06-02.
- [Development environments for cloud agents](https://cursor.com/blog/cloud-agent-development-environments).
- [Bootstrapping Composer with autoinstall](https://cursor.com/blog/bootstrapping-composer-with-autoinstall),
  published 2026-05-06.
- [Self-hosted cloud agents](https://cursor.com/blog/self-hosted-cloud-agents).
- [The third era of AI software development](https://cursor.com/blog/third-era).

The observations below are paraphrases of those sources. Performance numbers
published by Cursor describe Cursor's system and are not AgentDock evidence.

## What AgentDock already has

| Cursor lesson | Existing AgentDock implementation |
| --- | --- |
| Full development environment materially affects output quality | Append-only Project environment versions, immutable Run snapshots, in-gVisor toolchain validation, and exact-environment warm reuse under ADR-0042 |
| Agent, machine, and conversation state must be independent | Pi JSONL, immutable Workspace versions, and demand-activated gVisor Pods have independent lifecycles under ADR-0011/0032/0040 |
| Long-running work requires durable execution | Durable Run/RunAttempt, mailbox, lease, fencing, checkpoint CAS, event spool, reconciliation, and explicit ambiguous-side-effect handling under ADR-0031 |
| Machines should survive interactive follow-ups but not cold conversations | Exact-Session warm Pod reuse with bounded TTL/LRU; cold Sessions own no Pod or Pi process under ADR-0040 |
| Streaming state must not be the only durable conversation state | Append-only PostgreSQL event log, cumulative batch ACK, SSE replay, and terminal Pi checkpoint |
| Tools need controlled network and credential boundaries | Default-deny Tool Pods, credential-free subprocesses, isolated model/GitHub gateways, and a fixed-purpose public repository importer |
| Results should be more than an assistant message | Workspace versions, files, structured diff, test history, artifacts, usage, Runs/Attempts, and GitHub PR delivery |
| Self-hosted workers should connect outward and be replaceable | Authenticated outbound Supervisor WebSocket, fresh boot identity, owner-stop proof, and no inbound Runner port |

These are not reimplemented in the new milestone. New work extends their
existing contracts.

## Adopt now

### 1. Environment configuration is a versioned product surface

Add a bounded configuration-as-code document that describes workspace-level
setup and verification, not infrastructure policy. It may name multiple exact
repository roots and commands that execute only inside the existing untrusted
Tool Sandbox. RuntimeClass, image, mounts, ServiceAccount, resources, and
network policy remain deployment-owned and cannot be selected by a repository,
model, or browser.

The Project environment surface must expose immutable history, expected-current
CAS activation/rollback, validation evidence, and actor audit. A broken new
version fails closed; it never silently falls back to a generic image.

### 2. Self-diagnosing and repairable environments

Implement a two-stage environment check inspired by Cursor autoinstall:

1. discovery records bounded candidate setup, verification, and start goals
   derived from repository-owned configuration and deterministic project
   inspection;
2. validation executes an owner-approved subset in a fresh gVisor Sandbox and
   records structured outcomes.

The system may produce repair suggestions or a proposed configuration version.
It must not invent credentials, weaken network policy, inject fake production
data, or promote a version without an explicit tenant-owner action. A future
model-assisted proposal is a normal auditable Run, not a trusted control-plane
shortcut.

### 3. Multi-repository development environments

One Workspace may contain several immutable exact-commit repositories mounted
under distinct validated relative roots. Import remains credential-brokered and
content-addressed. A source cannot overwrite another source, escape its root,
or smuggle a symlink/submodule. Workspace snapshots and patches preserve the
repository-root identity.

### 4. Controlled dependency egress

Add a dedicated egress proxy and an immutable per-environment hostname policy.
Tool Pods may reach only that proxy; the proxy resolves names itself, rejects
private/link-local/loopback/cluster destinations after every resolution, limits
methods, ports, redirects, bytes, and duration, and emits redacted audit
records. Platform/model/database/object-store/GitHub credentials never enter
the Tool Pod.

### 5. Safe clean prewarming

Maintain an optional pool of environment-only Pods that have never processed a
tenant Workspace or secret. The first assignment binds and consumes a clean
Pod; a used Pod can remain warm only for the exact Session and is never returned
to the clean pool. Pooling is enabled only when measured cold-start data
justifies its resource cost.

### 6. Attempt-aware rewind and review artifacts

On retry, the durable event history remains append-only, but the product marks
the failed Attempt's visible stream as superseded and starts the replacement
Attempt from an explicit boundary. Browser reconnect reconstructs the same
canonical view without deleting audit history.

Add an immutable Review Bundle that links the final message, patch, changed
files, tests, relevant bounded command logs, artifacts, environment evidence,
usage, and Attempt history. The bundle is a review surface; it never embeds
untrusted HTML or exposes object-store keys.

### 7. Reproducible Kubernetes worker deployment

Package the execution-plane resources as a versioned Helm chart with explicit
gVisor RuntimeClass, node scheduling, scoped RBAC, Pod Security, NetworkPolicy,
resource limits, reconciliation and rolling-upgrade values. Preserve the
outbound-only Runner topology and validate the chart in CI. Multi-node claims
require a real external CSI/CNI acceptance environment and are not inferred
from rendering a chart.

## Adopt later only after measured demand

- Browser/computer-use Sandbox and VNC/screen recordings. They require a new
  network, media, input-control, artifact, and takeover threat model.
- Interactive local-to-cloud process handoff. Durable conversation and files
  can already fork; live local process state is neither portable nor trusted.
- Agent-generated arbitrary Dockerfiles and custom base images. They require a
  separately isolated image-build plane, registry provenance, build-secret
  isolation, vulnerability policy, cache ownership, and artifact signing.
- Multi-agent fan-out. It remains a separate roadmap capability with explicit
  workspace ownership and budgets; environment work must not smuggle it in.

## Deliberately not copied

### Temporal migration

Cursor reports that Temporal solved failures in its system. AgentDock already
implements the required task-scoped durable semantics through PostgreSQL
RunAttempts, leases, fencing, an outbox, a crash-safe spool, reconciliation,
and fault tests. Replacing this with Temporal now would duplicate state
ownership and invalidate proven failure semantics without a measured need.

### Silent fallback to a base environment

Cursor describes a fallback environment when custom setup fails. AgentDock
rejects that behavior: an accepted Run snapshots an exact environment identity,
so silently running another image would make results irreproducible and could
bypass policy. Validation failure remains visible and fail-closed.

### Reusing a machine after tenant code

Only a never-used clean Pod may enter the shared prewarm pool. Sanitizing and
reassigning a used Pod is not treated as a safe tenant boundary.

## Acceptance evidence required

The milestone is complete only when automated and live tests prove:

- exact environment history and CAS rollback under concurrent updates;
- a failed recipe cannot become active or silently fall back;
- deterministic environment diagnosis and fresh-Sandbox verification;
- exact-root multi-repository restore and cross-root traversal rejection;
- permitted dependency traffic works while internal, private, metadata,
  unlisted, rebinding, redirect, and credential-leak paths fail;
- clean prewarm consumption reduces measured first-tool activation and never
  recycles a used Pod;
- retry UI reconstruction shows one canonical Attempt while retaining complete
  audit history;
- Review Bundles are immutable, tenant-scoped, content-verified and safe to
  preview;
- Helm rendering and policy tests retain gVisor-only, least-privilege defaults;
- a real provider completes a two-turn coding task through the production
  topology with token usage, warm reuse, review evidence, and exact cleanup.
