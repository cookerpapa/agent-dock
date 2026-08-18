# Coder Agents `chatd` and Pi Cloud

Date: 2026-08-18

## Sources

- Coder Agents architecture: <https://coder.com/docs/ai-coder/agents/architecture>
- Coder source at the reviewed revision `062c0fdd3bb31235985f6486b91e26bc082ac08e`:
  <https://github.com/coder/coder/tree/062c0fdd3bb31235985f6486b91e26bc082ac08e/coderd/x/chatd>
- The local source review covered `ARCHITECTURE.md`, `chatstate/`,
  `runner_manager.go`, `messagepartbuffer/`, `dynamictool.go`, `subagent.go`
  and `mcpclient/`.

## Shared direction

Coder Agents and Pi Cloud share the same important trust split:

```text
trusted Agent Loop and model credentials
                 │
          mediated Tool calls
                 ▼
untrusted/persistent development environment
```

Both keep conversation state outside the Workspace, lazily connect to compute
only when a Tool needs it, compact model context without deleting the original
history, queue follow-up messages, and let several runtime instances compete
for database-owned work.

## Ideas worth adopting

### Execution state is not metadata

Coder's state machine explicitly separates status, message/queue versions,
retry state and transient runner ownership from title, labels, model choice and
Workspace binding. Pi Cloud should keep the same discipline: only fields which
decide the next Run transition belong to the execution protocol.

### Tool registry, grant and runtime snapshot are different objects

Coder freezes MCP entitlements for delegated Explore chats and treats dynamic
tools as an explicit `requires_action` state instead of loading arbitrary code
into the Agent process. Pi Cloud needs the corresponding cloud invariant:

```text
platform Tool registry
       ↓
Session grant
       ↓
immutable Run capability snapshot
       ↓
AgentTool[] for one Agent runtime
       ↓
Tool Broker authorization at execution time
```

The first production slice covers the four built-in remote tools. MCP and
administrator-managed connections can later use the same contract without
injecting untrusted extension code into the trusted Pi Host.

### Multi-agent is a durable delegation graph

Coder creates child chats with independent context windows and parent/root
links. Pi Cloud should likewise map `spawn_agent` to child Session + child Run,
not to a local `pi` subprocess. Its first version should forbid nested children
and make Workspace semantics explicit:

- `shared_readonly` for bounded exploration;
- `shared_serialized` for coordinated access to the real Workspace;
- `isolated` only for speculative implementation branches.

Creating two ordinary user Sessions over one Workspace must continue to share
that Workspace; a conversation fork is not automatically a filesystem fork.

### Organization-owned raw history remains distinct from runtime context

Coder retains original messages after compaction. Pi Cloud already does the
same through PostgreSQL Pi SessionStorage: active recovery reads the newest
compaction plus suffix, while older parent-linked entries remain tenant-owned
records. Sessions are tenant resources rather than bytes owned by a Worker or
an employee laptop.

## Ideas not to copy

- Coder streams uncommitted parts from a bounded in-memory, best-effort buffer.
  Pi Cloud's Kafka durability barrier before browser visibility is stronger.
- Coder documents at-least-once Tool execution after a replica crash. Pi Cloud
  must retain its explicit unknown-effect outcome and never blindly replay an
  ambiguous shell mutation.
- Coder's workers greedily race without fairness. Pi Cloud keeps tenant-aware
  admission and bounded candidate selection.
- Coder general subagents share the parent Workspace. Pi Cloud must preserve
  its single-writer rule and use explicit isolated branches for parallel
  speculative coding.
- Coder embeds the worker in every API/control-plane replica. Pi Cloud keeps Pi
  and provider credentials in a separately scalable trusted Agent Host pool.

## Resulting implementation order

1. Freeze and enforce built-in Tool capabilities per Run.
2. Add administrator-owned Tool/MCP connections and Session grants.
3. Introduce a child Session/Run delegation graph with read-only children.
4. Add an isolated Workspace branch provider before parallel mutating children.
5. Treat a persistent Cube as the default dedicated Linux environment; add a
   second VM provider only after a concrete compatibility or lifecycle gap is
   measured.

