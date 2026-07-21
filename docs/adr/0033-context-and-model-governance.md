# ADR-0033: Context construction and transactional model governance

- Status: accepted
- Date: 2026-07-20
- Extends: ADR-0006, ADR-0027, ADR-0031, ADR-0032
- Amended by: ADR-0041 (the cumulative per-Run token budget is removed; usage,
  tenant daily tokens and per-Run cost/request governance remain)

## Context

A durable Run can still exhaust provider quota or lose useful context if every
model request is forwarded independently. Counting usage after a response is
too late to enforce concurrent budgets, mutable price configuration makes old
cost records unreconstructable, and truncating a large command result without
preserving it loses debugging evidence. Pi already owns transcript restoration
and native compaction, so replacing its message algorithm in the Control Plane
would create a second, incompatible conversation implementation.

## Decision

1. The accepted Turn receives an immutable budget snapshot covering model
   requests, tokens, cost, tool calls, tool-result bytes and Run wall-clock.
   Tenant day/month budgets remain live policy and are checked at every model
   reservation.
2. The Model Gateway serializes reservation decisions by locking the tenant
   runtime policy. Completed usage and unexpired reservations are summed before
   any provider egress. A denial is durably audited as `budget_denied`; it does
   not contact the provider.
3. Token reservations use a bounded prompt estimate plus the requested maximum
   output. Cost reserves the more expensive of the configured primary and
   eligible fallback. Provider-reported usage settles the reservation and
   writes one linked UsageLedger record.
4. Prices are tenant-owner configuration expressed as integer micro-USD per
   million tokens. Every completed request snapshots the four rates actually
   used as well as its calculated integer cost. AgentDock does not present the
   seeded zero rate as a provider price.
5. One fallback model may be configured. It is attempted only for the selected
   rate-limit, server-error or timeout classes and reuses the existing
   reservation; arbitrary errors and a second fallback are not retried.
6. Pi remains the context authority. AgentDock supplies an ordered construction:
   Pi/platform system instructions, a bounded repository `AGENTS.md` when
   present, Pi's durable summary, recent transcript messages, bounded tool
   results and the current accepted task. Repository instructions are clearly
   delimited as repository-controlled content.
7. Pi's native compaction thresholds are written to the activation-local
   settings. Native start/end events become durable compaction records with
   token counts, first-kept entry, summary format version and only a SHA-256 of
   the summary. The summary text remains in the protected Pi checkpoint and is
   not copied into public events or ordinary audit tables.
8. Tool calls are rejected in the trusted extension before Tool RPC when the
   Run allowance is exhausted. Large read/bash results are truncated before
   entering Pi context, while the full bounded bytes are passed through a
   trusted temporary directory to the fenced checkpoint store. The resulting
   tenant/run-scoped `tool_output` Artifact is committed before its public event
   reference.

## Reservation semantics

```text
lock tenant policy
-> expire abandoned reservations
-> verify current RunAttempt
-> load primary/fallback rate
-> aggregate completed + active reservations
-> insert reserved | budget_denied
-> provider request (only when reserved)
-> complete/failed/aborted settlement
-> linked immutable usage record
```

This is admission control, not a promise that a provider can never report more
tokens than estimated. A completed request records actual values; later
requests see those values. Reservation expiry prevents a crashed gateway from
blocking a budget forever.

## Security and privacy

- Provider keys remain only in the trusted Gateway/Runner path.
- Cost configuration and usage queries are tenant-scoped; only an owner can
  mutate limits, routes or rates.
- Full tool output never enters the public event stream. Public events contain a
  bounded preview and an opaque Artifact ID/hash/size.
- Tool Artifact persistence revalidates current Run/Attempt/lease/fence before
  publishing object metadata.
- Compaction summary content is not duplicated into PostgreSQL; its hash and
  version are sufficient to correlate native Pi behavior without exposing it.

## Consequences

- Concurrent model requests cannot each observe the same unused budget.
- Fallback attribution and cost remain inspectable after price settings change.
- Long sessions keep Pi compatibility while exposing measurable compaction
  behavior.
- The Model Gateway and Tool Artifact store are now part of the Run commit
  boundary and require deterministic failure tests.

## Rejected alternatives

### Count usage only after the provider responds

Concurrent requests can overspend before any ledger row exists.

### Reimplement Pi messages and compaction in the Control Plane

It would fork upstream semantics and make Pi upgrades and checkpoint restore
unsafe. AgentDock configures and observes the native mechanism instead.

### Put full command output in SSE or Pi JSONL

It expands context and database rows, increases secret-exposure risk and makes
browser replay unbounded. Full bytes belong in the tenant-scoped artifact store.
