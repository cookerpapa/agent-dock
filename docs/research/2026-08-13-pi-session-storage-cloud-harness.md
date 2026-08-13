# Pi SessionStorage Cloud Harness investigation

Date: 2026-08-13

## Question

Can AgentDock stop restoring a complete `session.jsonl` for every Run, and can
the Run lease/fence become an internal Harness concern instead of application
plumbing?

## Upstream boundary

Pi 0.84.1 publishes the right storage and execution primitives:

- `SessionStorage` and `Session` store entries, branch pointers, operation
  records, facts and a monotonic append log;
- bounded branch reads stop at the latest compaction entry;
- `Agent` and the low-level agent loop can execute against a caller-provided
  transcript, model stream and Tool set;
- the SQLite backend has a fenced single-writer lease.

The public `AgentHarness` class is not yet an executable replacement for the
coding-agent runtime. In 0.84.1 its central `prompt`, `resume`, `compact`, Tool
drive and recovery methods still throw `HarnessNotImplemented`. Upstream's
durable Harness design also treats arbitrary external hook/Tool effects as an
application responsibility; a storage writer lease does not by itself fence a
Cube command that has already crossed the network.

Therefore AgentDock must not claim that Pi already supplies a distributed
cross-resource lease/fence. Pi supplies the storage model and a concrete
SQLite single-writer implementation. AgentDock supplies the PostgreSQL Run
authority and extends it to the remote Tool effect boundary.

Primary upstream references:

- <https://github.com/earendil-works/pi/blob/main/packages/agent/docs/agent-harness.md>
- <https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md>
- <https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts>
- <https://github.com/earendil-works/pi/tree/main/packages/session-backends/sqlite-node>

## Implemented experiment

`@agent-dock/pi-session-postgres` now contains an executable
`DurableAgentHarness` built only from Pi's public primitives. It:

1. acquires one opaque `DurableAgentExecutionAuthority` for a Run;
2. closes an unfinished prior operation with an interruption result;
3. reads the current branch directly from PostgreSQL, stopping at the latest
   compaction;
4. reconstructs the in-memory model context from Pi-native Entries;
5. persists every completed user, assistant and Tool-result message as a new
   Pi Entry;
6. writes `operation_started`, `tool_started` and `operation_finished` records;
7. checks the same authority before Session mutation and before/after every
   Tool effect;
8. aborts the active agent loop when the authority provider observes expiry or
   takeover.

The PostgreSQL branch walk was also changed from one point query per ancestor
to one recursive CTE. Network round trips are now constant per restore query;
the returned bytes are only the active compacted branch rather than an entire
historical JSONL object.

The reviewed remote `read/write/edit/bash` implementation is shared with the
new Harness through `createTrustedRemoteAgentTools`; it does not duplicate or
weaken the Tool RPC policy.

Automated evidence covers:

- a second Harness instance restores a prior multi-round Session directly from
  PostgreSQL;
- after a compaction, pre-compaction messages are absent from the restored
  provider context;
- revoking authority between Tool intent and Tool execution prevents the Tool
  implementation from running;
- the authority is closed at every terminal path.

## Production migration boundary

The experiment is intentionally not yet the default production Pi adapter.
The current coding adapter still has behavior that must be moved before the
switch is honest: automatic compaction/overflow recovery, interrupted-turn and
world-state projections, settled Workspace commit coordination, active steer,
model sampling identity and the full production event mapping.

The migration gate is feature parity plus a real-model/Cube acceptance run,
not merely compiling a new class. Until that gate passes, production continues
to use Pi's stable coding-agent SDK JSONL entrypoint. This avoids trading lower
restore traffic for weaker crash or Tool semantics.

## Intended final shape

```text
PostgreSQL Run claim
        ↓
DurableAgentHarness.acquireAuthority()
        ├── Pi SessionStorage writes (same transaction checks)
        ├── model/agent cancellation signal
        └── Cube Tool effect admission

Session restore
        ↓
one bounded recursive branch query
        ↓
Pi-native active context in Worker memory
```

No lease ID or fencing token enters model context. The Harness and providers
hold opaque authority; PostgreSQL and Tool Broker remain the components that
validate the concrete claim/fence at their true effect boundaries.

