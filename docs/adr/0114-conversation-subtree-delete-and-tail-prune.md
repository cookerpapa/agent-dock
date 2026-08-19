# ADR-0114: conversation subtree delete and tail prune

Status: accepted

## Context

PiCloud presents human conversation forks and delegated Subagent Sessions as a
tree. Deleting only one parent row leaves visible child branches and can leave
internal Child Sessions blocking Workspace cleanup. Users also need to discard
an unsuccessful continuation while keeping an earlier settled answer and using
that answer as the next model-context boundary.

Pi Session entries are immutable and parent linked. Physical deletion of a
middle range would destroy audit evidence and make concurrent recovery unsafe.

## Decision

- Deleting a human Session recursively archives its whole human descendant
  subtree and every Subagent Session produced by those branches in one
  transaction. Any unsettled descendant makes the operation fail closed.
- “删除此消息之后的内容” is available only on a settled final Assistant entry
  owned by the selected Session. The anchor entry itself remains visible.
- Tail pruning marks later product Turns as pruned, rewinds Pi's `main` lane to
  the anchor entry and appends the corresponding native lane fact. Immutable Pi
  entries, Runs, events and projections remain as unreachable audit evidence.
- Human branches forked from the anchor or a later Turn are recursively
  archived. Subagent Sessions produced by pruned Turns or archived human
  branches are archived as well. Subagents that contributed to the retained
  anchor Turn remain visible.
- The prune operation is idempotent. Session locking, target validation, Turn
  visibility changes, lane movement and descendant archival commit in one
  PostgreSQL transaction.

## Invariants

1. Active or unsettled work is never truncated or recursively archived.
2. The selected entry must be the final Assistant entry of a completed visible
   Turn on the current Pi `main` branch.
3. A pruned Turn never appears in transcript/tree projections or future model
   context.
4. Arbitrary Tool effects and Workspace bytes are not rolled back. The UI must
   not describe conversation pruning as Workspace rollback.
5. Cross-tenant Sessions, Turns and Pi entries remain invisible.

## Consequences

Conversation deletion and Workspace deletion now agree on what counts as live
user history. Tail pruning is cheap and auditable, but does not reclaim the
immutable historical rows immediately; retention/GC remains a separate policy.
The Workspace continues from its current bytes, so users who need historical
files must use a future Workspace snapshot/rollback feature rather than this
conversation operation.
