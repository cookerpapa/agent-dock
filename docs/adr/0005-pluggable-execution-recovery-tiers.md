# ADR-0005: Pluggable execution and recovery tiers

- Status: Accepted
- Date: 2026-07-18

## Context

ADR-0001 selected a pinned Pi RPC child process as the first integration path
and deferred direct SDK embedding until process overhead or an RPC limitation
justified it. A source-level survey of OpenClaw, Microsoft Agent Framework,
Flink Agents, OpenHands, E2B, Agent Substrate, Kubernetes Agent Sandbox, Google
AX, and agentserver now shows that cloud execution has several distinct recovery
levels. No single backend provides low idle cost, arbitrary extension
compatibility, portable upgrades, and full process recovery at the same time.

Treating one Pi process as the durable identity of one AgentDock session would
make cold sessions consume live resources and would couple control state to a
replaceable execution mechanism. Treating a shared SDK worker as universally
safe would instead violate the sandbox boundary for untrusted extension code.

## Decision

AgentDock sessions remain durable control-plane objects independent from any
Pi process, AgentSession object, container, or virtual machine.

The execution layer will expose a replaceable backend boundary with three
recovery tiers:

1. `embedded-rehydrate`: recreate a Pi SDK `AgentSession` from durable session
   state for each activation. This tier is permitted only inside an execution
   worker/sandbox and only for trusted, portable extensions.
2. `isolated-process`: run pinned Pi RPC in an isolated process or sandbox,
   restore Pi JSONL and workspace state, and terminate it after a safe idle
   boundary. This remains the baseline compatibility backend.
3. `hibernate`: delegate process/RAM and filesystem checkpointing to an external
   sandbox implementation such as E2B or Agent Substrate. This is optional and
   must still obey AgentDock command, lease, fencing, and event semantics.

The NestJS control-plane process must never load Pi or extension code. A shared
SDK worker must never load arbitrary untrusted user/project extensions. Backend
selection is a policy decision based on extension compatibility, trust, and
recovery requirements.

Recovery claims must name their level: event replay, semantic session restore,
workflow-step restore, workspace restore, or process-memory restore. No backend
may claim exactly-once execution for arbitrary shell commands or external side
effects.

The first SDK work is an isolated executable spike. It must prove same-session
serialization, bounded cross-session concurrency, per-activation teardown,
message/session rehydration, and `appendEntry` extension-state restoration
without making the embedded backend the production default.

## Consequences

- The current Pi RPC supervisor and protocol work remain valid as one backend.
- Session mailboxes, durable events, leases, and fencing live above all backends.
- Cold sessions do not require a process, thread, sandbox, or AgentSession.
- Portable extensions can use a lower-cost backend; process-bound extensions
  require stronger isolation or hibernation.
- Supporting multiple tiers adds contract tests and policy complexity, but
  prevents one experimental optimization from becoming a permanent constraint.
- Full process snapshots remain subject to kernel/runtime compatibility, stale
  credentials, external connections, snapshot size, and upgrade invalidation.

## Rejected alternatives

### One permanent Pi process per session

Simple, but idle resource use scales with stored sessions and horizontal
ownership becomes tied to process lifetime.

### Replace Pi RPC with a shared SDK worker everywhere

Efficient for portable trusted extensions, but cannot safely isolate arbitrary
extension code or preserve process-bound state.

### Adopt Flink or Kubernetes before measuring the local runtime

Both may become useful infrastructure, but neither answers the Pi SDK recovery
and extension compatibility questions by itself. The smallest experiment should
establish those facts first.
