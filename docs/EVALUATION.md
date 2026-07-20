# Evaluation

AgentDock keeps infrastructure correctness separate from model intelligence.
All checked-in `latest` reports are machine-readable JSON plus a short Markdown
rendering and include the methodology and exclusions.

## Deterministic coding loop

```bash
npm run eval:coding -- --register
```

Ten isolated Calculator repairs exercise durable acceptance, Pi RPC, streamed
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
and orphan-runtime cleanup. Each case names the protected invariant. This is a
deterministic fault suite; `npm run production:check` adds live container
restart/reconnect evidence.

## Sandbox security

```bash
npm run sandbox-provider:check
```

This source-build gate runs the Provider contract and a real Pi remote-tool
repair. It validates cgroups, namespaces, offline networking, `/proc` and
credential isolation, tenant-separated workspaces, traversal/symlink denial,
output bounds, cancellation, and exact resource cleanup.

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

On 2026-07-20, the checked-in reports recorded:

- deterministic coding loop: 10/10 successful, concurrency 2, p50 9.168 s,
  p95 10.224 s;
- targeted fault injection: 10/10 invariants preserved, p50 2.529 s, p95
  5.762 s;
- Control Plane load: 320/320 successful requests; at 100 simultaneous requests,
  Session creation was 114.20 requests/s with 831 ms p95, and reads were 236.81
  requests/s with 408 ms p95;
- post-load RSS: Control Plane 200,962,048 bytes, Trusted Runner 167,043,072
  bytes, Sandbox Manager 119,164,928 bytes;
- all three Prometheus targets were up and Jaeger contained cross-service traces
  from all three trusted services.

These numbers describe this single-host Docker Desktop run, not a service-level
objective or generalized hardware claim.
