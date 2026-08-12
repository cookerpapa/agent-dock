# ADR-0097: Shared Temporal Worker capacity

## Status

Accepted on 2026-08-12.

## Context

AgentDock previously gave every Pi Worker a private Temporal Activity Task
Queue in addition to its Cell queue. A PostgreSQL reservation attempted to
route a later Session Run back to the Worker that had cached its Pi checkpoint.
The optimization added a second poller per process, reservation state, a
private-queue timeout and a local slot counter shared outside Temporal. The
measured checkpoint objects are small and the cache is never needed for
correctness, while two pollers advertising the full process capacity can
produce avoidable deferred Activities.

## Decision

1. Every Pi Worker polls only its Cell Activity Task Queue.
2. `maxConcurrentActivityTaskExecutions` is the process-wide Agent runtime
   capacity limit. Work above that limit remains in Temporal task matching
   rather than starting an Activity that immediately reports a busy process.
3. PostgreSQL Worker-affinity reservations, Session affinity columns and
   Worker-private Task Queues are removed.
4. A legitimate database-authority deferral uses Workflow-level exponential
   backoff capped at five seconds. `continueAsNew` still bounds Workflow
   history.
5. Pi checkpoint caches remain local opportunistic read-through caches. Any
   Worker can restore the Session from the shared object store.

## Consequences

- Worker capacity is represented once, by Temporal's Worker slot limit.
- A Worker restart or scale-down cannot strand a Session on a private queue.
- One small cache-locality hint is lost, but no correctness or multi-turn
  recovery behavior changes.
- Cell Task Queue backlog becomes a direct autoscaling signal.
