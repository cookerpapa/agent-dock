# ADR-0040: Demand-activated warm Sandboxes and batched events

- Status: accepted, amended for CubeSandbox
- Date: 2026-07-21

## Context

An early implementation created a physical Sandbox before Pi knew whether a
tool was needed and synchronously persisted each small text delta. A measured
chat-only Run paid about 4.1 seconds of unused Sandbox activation, while serial
event acknowledgements continued after model streaming had ended.

## Decision

1. A Run receives logical Tool authority without creating Cube. The first real
   Tool call performs a fenced, single-flight activation.
2. Chat-only Runs save Pi conversation state and never touch the execution
   plane.
3. One live Cube may remain warm for the exact Session and Workspace. Reuse
   requires matching identity, policy and committed Workspace revision plus a
   higher fence and rotated handoff secret. ADR-0068 defines the current
   session-resident lifecycle.
4. Failed, cancelled, ambiguous, stale or mismatched execution destroys Cube;
   idle retention is bounded by deployment TTL and reconciliation.
5. Pi event production is decoupled from remote persistence by the Worker WAL.
   Adjacent deltas are coalesced, batches are committed atomically, and
   cumulative acknowledgements permit safe replay and de-duplication.
6. The first visible delta is flushed promptly; message/tool/terminal boundaries
   force a flush. A final canonical message is persisted independently of UI
   delta coalescing.

## Consequences

- Pure conversation latency is independent of Cube cold start.
- Multi-turn coding can retain a warm environment without making it durable
  authority.
- PostgreSQL remains the public event source of truth after ACK; the local WAL
  protects the Worker-to-Control-Plane delivery gap.
- Batching improves throughput without weakening lease, fence or checkpoint
  correctness.
