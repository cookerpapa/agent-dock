# ADR-0112: Run-scoped Tool capability snapshots

Status: accepted

## Context

One Pi Agent Host process multiplexes several independent Agent runtimes. The
current built-in remote tools are registered per runtime, but the accepted Run
does not carry an explicit durable Tool grant and the Tool Broker capability
authorizes an activation without independently checking which Pi Tool produced
an operation.

Future tenant MCP connections and child Agents make an implicit Host-global
Tool set unsafe. Hiding a Tool schema from one model request is also not an
execution authorization boundary.

## Decision

- A Session owns the mutable grant for built-in cloud Tool names.
- Turn admission copies that grant into an immutable Run capability snapshot.
- Every Attempt carries the same Run snapshot to the Agent Host.
- The Host registers only the granted Pi `AgentTool` proxies.
- Every Tool RPC includes the trusted Pi Tool name as well as the low-level
  operation kind.
- Tool Broker binds the short-lived activation capability to the Run snapshot
  and rejects an ungranted Tool or an operation which does not belong to that
  Tool.
- The snapshot contains identifiers only, never credentials or executor
  connection details.

The first version recognizes `read`, `write`, `edit` and `bash`. This is the
foundation for later MCP/session grants; it does not authorize user extension
code inside the trusted Host.

## Consequences

- Two Agent runtimes in one Host can receive different visible Tool sets.
- A forged Tool RPC still fails at Tool Broker even if a caller obtains an
  operation route.
- Policy changes affect later Runs and never mutate an already accepted Run.
- Protocol and database migrations are required, together with Host/Broker
  contract tests.

