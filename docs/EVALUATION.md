# Evaluation

AgentDock keeps infrastructure correctness separate from model intelligence.
All checked-in `latest` reports are machine-readable JSON plus a short Markdown
rendering and include the methodology and exclusions.

## Deterministic coding loop

```bash
npm run eval:coding -- --register
```

Ten isolated Calculator repairs exercise durable acceptance, the Pi SDK, streamed
tool calls, offline Tool Sandboxes, failed-then-passed focused Java tests,
Workspace checkpoint commit, file restoration, trace identity, and cleanup.
The fake model emits a fixed action sequence, so this measures the platform's
Agent Loop, not model reasoning. The latest result is
`docs/reports/coding-eval-latest.json`.

## Fault injection

```bash
npm run eval:faults
```

The manifest in `eval/fault-cases.json` targets checkpoint commit failure,
duplicate delivery, stale fencing, ACK loss, corrupt spool, object-store
outage, checkpoint corruption/CAS, cancel-complete race, stale dispatch claim,
orphan-runtime cleanup, a real Worker `SIGKILL` after WAL sync and replacement
of a `SIGKILL`ed Control Channel server. Each case names the protected
invariant. The suite distinguishes process-level faults from simulated
dependency failures; `npm run production:check` adds live container
restart/reconnect evidence.

## Streaming durability

Streaming text is coalesced before it enters the Worker WAL, then delivered as
contiguous batches with cumulative ACK. The Control Plane integration suite
includes a mixed redelivery/new-suffix case and proves that one batch performs
one event-table insert and one cursor/Session advance. SSE still reads only
committed PostgreSQL rows, and Pi recovery tests prove that committed text and
Tool facts appear in Pi's effective next model context after hard-crash
recovery.

This removes per-token transactions and per-event cursor updates. It is not yet
a PostgreSQL saturation claim; the active-stream capacity experiment remains in
the backlog and must measure transaction rate, WAL, pool wait and SSE lag on the
deployment being described.

For the end-to-end Control Plane boundary, deploy the current revision and run:

```bash
AGENT_DOCK_LIVE_CONTROL_PLANE_RESTART_CHECK=1 \
  npm run production:control-plane-restart-check
```

The check starts one real-model streaming Run, sends `SIGKILL` to the Control
Plane container after the first committed text event, starts a replacement and
requires SSE replay plus terminal completion with the original single Attempt.

## Sandbox security

```bash
npm run cubesandbox:live-check
npm run production:check
```

The live gate attests the Cube KVM guest and runs the Provider contract plus a
real Pi remote-tool repair. It validates resources, public-proxy/private-denied
networking, credential isolation, tenant-separated Workspaces,
traversal/symlink denial, output bounds, cancellation, checkpoint restore and
exact resource cleanup.

## Control Plane load

```bash
npm run eval:load
```

The benchmark creates and reads tenant-scoped cold Sessions using 10, 50, and
100 simultaneous loopback HTTP requests. It samples process RSS, CPU, and event
loop lag from Prometheus after the run. It deliberately does not claim 100
simultaneous LLM/Sandbox Runs: active Run capacity is bounded independently by
tenant policy, Supervisor capacity, memory, provider quota, and latency.

## Current reproduced result

The checked-in reports currently record:

- deterministic coding loop: 10/10 successful, concurrency 2, p50 9.168 s,
  p95 10.224 s;
- targeted fault injection (2026-08-08): 15/15 invariants preserved, including
  real Worker and Control Plane process `SIGKILL` boundaries;
- Control Plane load: 320/320 successful requests; at 100 simultaneous requests,
  Session creation was 114.20 requests/s with 831 ms p95, and reads were 236.81
  requests/s with 408 ms p95;
- post-load RSS: Control Plane 200,962,048 bytes, Trusted Runner 167,043,072
  bytes, Sandbox Manager 119,164,928 bytes;
- all three Prometheus targets were up and Jaeger contained cross-service traces
  from all three trusted services.

These numbers describe this single-host Docker Desktop run, not a service-level
objective or generalized hardware claim.
