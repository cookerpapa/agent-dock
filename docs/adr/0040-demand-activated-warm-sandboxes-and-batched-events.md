# ADR-0040: Demand-activated warm Sandboxes and batched event delivery

- Status: Accepted
- Date: 2026-07-21
- Supersedes: the per-Run eager Pod lifecycle in ADR-0039 and the synchronous
  one-publication/one-ACK execution path in ADR-0008/ADR-0012

## Context

The Kubernetes/gVisor execution plane established the intended security
boundary, but it placed two expensive operations directly in every Run's
synchronous path:

1. the Runner created and restored a Tool Pod before Pi could decide whether a
   tool was needed; and
2. Pi waited for a local spool fsync, a WebSocket round trip and a PostgreSQL
   transaction for every small text delta.

A measured production chat-only Run took 13.4 seconds. It called no tool, yet
spent 4.1 seconds creating/restoring a gVisor Pod. Its 174 output tokens became
152 public text-delta events; the provider stream had finished 3.9 seconds
before the final delta drained through the serial durable event path.

The existing RunAttempt, lease, fencing, Workspace-version CAS, Pod UID
precondition and reconciliation rules are sound. The latency is caused by
lifecycle granularity and synchronous backpressure, not by a need to weaken
those rules or replace gVisor.

## Decision

### Logical reservation and physical activation are separate

1. A Run reserves a short-lived Tool capability before Pi starts, but the
   reservation does not create a Pod. The fixed Pi extension continues to see
   normal `read`, `write`, `edit` and `bash` tools.
2. The Sandbox Manager materializes a physical gVisor Pod only when the first
   authenticated Tool operation arrives. Concurrent first operations share one
   creation promise; provider creation remains idempotently fenced by the
   activation identity.
3. A chat-only Run releases its unused reservation, saves only Pi conversation
   state and performs no Kubernetes create/attach/delete operation.
4. Tool identity remains server-derived. The model cannot choose an activation,
   Pod, namespace, image, RuntimeClass, network policy or resource policy.

### Warm reuse is a bounded cache, not durability

5. After a successful tool-using Run has captured and staged its checkpoint and
   locally spooled its terminal event, the Manager may retain the Pod as a warm
   activation for the exact `(tenant, project, workspace, session)` key. Warm
   state is not canonical merely because it was retained.
6. A later Run may reuse it only when its committed Workspace checkpoint
   revision exactly matches the warm activation's revision. The Manager revokes
   the previous capability, rotates to the new RunAttempt/fencing identity and
   the Provider updates and re-verifies the Pod annotations under the existing
   UID.
7. A failed, cancelled, timed-out, stale or revision-mismatched Run destroys the
   Pod. Graceful Manager/Provider shutdown destroys warm Pods. After an abrupt
   loss, uncertain Pods are never adopted and are removed by Supervisor-boot
   retirement/reconciliation.
8. Warm activations have a deployment-owned maximum count and idle TTL. LRU/TTL
   eviction captures no new authority: the committed object-store checkpoint
   remains the recovery source. A Pod that executed one tenant's code is never
   reassigned to another tenant/workspace/session.
9. `activationId` identifies the physical generation, the Kubernetes Pod UID
   fences destructive runtime operations, and the existing monotonically
   increasing session fencing token is the writer fence. No redundant
   user-controlled generation or fence is introduced.

### Conversation and Workspace commits are independent

10. A staged conversation checkpoint records the settled Pi JSONL independently
    from a Workspace version. Chat-only Runs advance the conversation pointer
    while retaining the current Workspace version and create no Workspace
    snapshot/version.
11. Tool-using Runs stage both the conversation checkpoint and, when bytes
    changed, an immutable Workspace version. Terminal Run settlement advances
    both pointers in one PostgreSQL transaction under the current Attempt and
    fence. Failed Attempts abandon staged rows and cannot alter either head.
12. The current memory-backed Workspace remains supported. Warm reuse removes
    repeated restore from the common interactive path; immutable object-store
    snapshots remain the cold/restart/rollback authority. A future PVC backend
    is optional and is not required for this decision.

### Streaming production is decoupled from remote persistence

13. The Runner immediately emits the first text delta, then coalesces only
    adjacent compatible text deltas within a bounded time/byte window. Tool,
    thinking, message and terminal boundaries force a flush.
14. Coalesced public events are appended to the existing crash-safe local spool
    before remote delivery. An asynchronous bounded publisher sends contiguous
    batches, and the Control Plane commits each batch in one PostgreSQL
    transaction and returns one cumulative ACK.
15. The producer waits only when the bounded unacknowledged window is full. A
    terminal result is not returned until all events through the terminal
    sequence are durably ACKed. PostgreSQL remains the replay source of truth;
    `NOTIFY` remains only a high-water wake hint.
16. Batch redelivery is at least once. Exact existing prefixes are verified,
    new suffixes are inserted contiguously, sequence/event uniqueness provides
    deduplication, and ACK means that every sequence through the cursor is
    durable. Arbitrary shell execution is still never blindly retried.

## Failure and cancellation rules

- Cancellation revokes the Tool capability/fence before waiting for creation or
  execution cleanup. A Pod that finishes materializing after revocation is
  destroyed without executing the requested Tool.
- Rebinding re-checks the RunAttempt identity after the Kubernetes metadata
  update. Old capabilities cannot operate on the reused Pod.
- An ambiguous tool outcome is reported as ambiguous/failed; warm reuse is not
  allowed after an unconfirmed command or process-tree teardown.
- A dropped batch ACK causes exact batch replay. A permanently stale fence
  retains the existing quarantine behavior.

## Consequences

- Pure chat pays no Kubernetes/gVisor lifecycle cost.
- The first actual Tool call pays one cold activation; later Runs in the same
  active coding Session normally reuse the Pod until the bounded idle eviction.
- Dependencies, build caches and background processes can survive across warm
  Runs, but correctness never depends on that survival.
- Event durability retains its commit-before-ACK property without applying a
  database/network round trip to every provider token.
- The Manager and wire protocol become more stateful and require explicit tests
  for concurrent first use, stale rebinding, cancellation during creation,
  revision mismatch, batch replay and bounded backpressure.

## Rejected alternatives

### Prompt classification before Sandbox creation

It adds another model/heuristic decision and can misclassify a request that
later chooses a Tool. The actual first Tool call is the exact demand signal.

### Keep every Session Pod permanently

It makes stored conversations consume live resources and turns a cache into a
durability dependency. Reuse is bounded by TTL/count and always recoverable from
the committed checkpoint.

### Replace gVisor with runc to reduce startup time

It trades away the selected untrusted-code boundary while still doing needless
work for chat-only Runs.

### ACK deltas before PostgreSQL commit

It can discard the only replay copy. Batching changes transaction granularity,
not the durable ACK meaning.
