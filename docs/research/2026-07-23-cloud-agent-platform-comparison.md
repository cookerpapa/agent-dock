# `maidangzhu/cloud-agent-platform` comparison

Date: 2026-07-23

Source: <https://github.com/maidangzhu/cloud-agent-platform>

## Useful implementation shape

The reviewed repository uses a thin Web/control path to ignite a remote
Sandbox, gives that runtime short-lived access back to trusted model/search
services, streams high-frequency output separately from durable semantic
messages, and persists a compact conversation-facing representation.

Four ideas are worth checking against PiCloud:

1. keep prompt acceptance/control work thin and asynchronous;
2. separate high-frequency transport deltas from semantic conversation reads;
3. move Workspace data by explicit revision/watermark rather than implicit
   mutable process state; and
4. reduce cold starts with clean images/snapshots or prewarmed capacity.

## Existing stronger PiCloud equivalents

PiCloud already implements three of those ideas with stricter boundaries:

- PostgreSQL command mailbox + transactional outbox + Supervisor delivery is
  the durable ignition path;
- immutable Workspace versions, exact source-set snapshots, CAS checkpoint
  commit and exact Session warm reuse provide the revision boundary; and
- single-consumption, never-used gVisor prewarm Pods reduce cold start without
  recycling a Pod that has executed tenant code.

PiCloud also keeps Pi and provider credentials in the trusted Runner, routes
only bounded Tools into a tokenless gVisor Pod, and retains RunAttempt,
lease/fence, cumulative event ACK and capability-scoped egress guarantees.
Those guarantees must not be replaced by placing the Agent runtime or broad
credentials inside the code-execution Sandbox.

## Adopted gaps

The first missing counterpart was a semantic conversation read model. PiCloud
previously reconstructed completed conversations by replaying every durable
delta from sequence zero. ADR-0049 adds a transactionally maintained,
rebuildable per-Turn semantic transcript and lets the browser resume only the
unprojected live suffix.

The result deliberately keeps both layers:

```text
session_events
  complete, fenced, durable, resumable audit log

conversation_turn_projections
  compact, versioned, rebuildable product read model
```

This is the useful part of the reference design adapted to PiCloud's stronger
durability and isolation model.

The second adopted point is an explicit trusted-proxy boundary. PiCloud does
not put a broad proxy token or provider credential in the gVisor runtime.
ADR-0050 instead gives the trusted Model Gateway a fixed, transport-only
CONNECT path:

```text
internal model-egress bridge
  -> private Unix socket
  -> host egress relay
  -> exact provider host
```

The Runner no longer needs a directly routed public network, the relay never
sees the model API key because TLS stays end-to-end, and Tool Pods cannot reach
either relay. This keeps the reference repository's useful “trusted proxy”
shape while preserving PiCloud's stricter separation between Agent Loop,
provider authority and untrusted execution.
