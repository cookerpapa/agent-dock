# ADR-0113: Cloud-native Pi subagents

Status: accepted

## Context

Pi intentionally keeps subagent orchestration outside its core. The official
repository contains an example, while `nicobailon/pi-subagents`—maintained by
the original example contributor—provides the established community contract
for agent profiles, foreground/background execution, workflow composition,
steer, resume and bounded capability inheritance.

Running that package's local `pi` child processes inside one Agent Host would
bypass PiCloud's PostgreSQL Run queue, make child Session data local to one
Worker and route child Tools outside the fenced Cube boundary. Replacing it
with a new PiCloud-specific model-visible protocol would lose upstream
compatibility and create a second subagent design.

Conversation forks and delegated execution also have different product
semantics. A human conversation branch belongs in the visible Session tree; a
subagent child is an execution relation and must not silently appear as a
normal user conversation.

## Decision

- Pin and adapt the public `pi-subagents` contract; do not patch Pi's Agent
  Loop or invent a competing agent-profile/workflow language.
- Replace only the package's leaf execution backend. Each leaf is admitted as
  a durable Child Session and Child Run, then claimed by the existing shared
  Pi Agent Host pool.
- PostgreSQL owns the parent/child execution relation, child Run state and all
  Pi Session entries. A local child process, local JSONL file or Worker cache is
  never authoritative.
- Keep human conversation ancestry separate from `subagent_executions`.
- Freeze the child's Tool set as an intersection with the parent Run
  capability snapshot. A child can never widen its parent's grant.
- Support explicit Workspace modes:
  - `none`: no Cube Tool capability;
  - `shared_serialized`: the parent and child use one Workspace and one
    serialized Tool execution world;
  - `isolated`: the child receives a Volume fork at a declared parent
    Workspace revision and uses a different Cube.
- A provider job identity is idempotent across Worker loss. Recovery reattaches
  to the same Child Run and never redispatches the prompt merely because a
  parent Worker disappeared.

## Consequences

- Subagent Runs consume the same tenant quota and Worker capacity as ordinary
  Runs and can scale by adding Agent Host replicas.
- Worker admission reserves a child lane so waiting parents cannot consume
  every local slot. A future durable parent-wait boundary may reclaim the
  waiting slot as an optimization, but correctness does not depend on it.
- Shared mode preserves live files, dependencies and processes but must retain
  a single writer. Isolated mode permits parallel mutations but requires a
  trusted Volume fork and an explicit result/merge contract. Isolated children
  intentionally use fresh model context so inherited orchestration requests
  cannot become executable child instructions.
- Project-controlled agent or extension code remains outside the trusted Host.
  Only deployment-owned profiles are enabled until a separate extension trust
  policy is accepted.
- Parent cancellation is propagated to durable Child Runs. The package's
  cross-invocation management actions (including standalone steer/resume UI)
  remain intentionally unavailable until their local run registry is replaced
  by a PostgreSQL control contract; PiCloud does not pretend local process IDs
  survive Worker replacement.
