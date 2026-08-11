# ADR-0094: Cross-component time and retention budgets

## Status

Accepted on 2026-08-12.

## Context

AgentDock crosses several independently configured failure detectors and
durability windows. A value can be locally valid while still making the whole
path incorrect. For example, a five-minute Tool command behind a five-minute
HTTP timeout can finish in Cube but lose its response at the Manager boundary,
and a Worker grace period shorter than Run settlement can kill a healthy
checkpoint commit during rollout.

These values are therefore ordered budgets rather than unrelated tuning knobs.

## Decision

The production profiles enforce these relationships at startup or in CI:

1. A Worker-to-Manager request outlives the maximum remote Tool execution by at
   least one minute. The current order is `Tool 5m < Tool RPC 6m`.
2. Model transport timeouts nest inside Pi: `provider upstream 120s <= Pi model
   request 150s <= Pi Turn 10m`.
3. A model Capability outlives the Pi Turn by at least one minute. The current
   Capability TTL is 15 minutes; expiry can revoke a stale Run but cannot race
   an otherwise valid Turn boundary.
4. A Pi Worker process receives enough graceful-shutdown time for the bounded
   Turn, one Manager request, the five-minute settlement allowance and a final
   process margin. The current deployment grace is 22 minutes.
5. Repository-import waiting cannot expire before its ownership lease.
6. Sandbox Manager ownership uses a five-second heartbeat and a fifteen-second
   lease. Two missed heartbeat intervals still leave failure-detection margin;
   invalid custom ratios fail startup.
7. Worker Control Channel health uses a ten-second heartbeat, thirty-second
   timeout and sixty-second assignment lease. A transport timeout alone does
   not authorize Tool replay or Workspace commit.
8. The one-hour Valkey live-replay window is shorter than raw Kafka retention:
   24 hours in the single-host profile and seven days in the enterprise
   baseline. Kafka can therefore rebuild a lost live read model before the
   canonical transcript fallback is required.

Browser-login TTL, Cube warm-idle TTL, Pi checkpoint-cache TTL and Temporal
history retention do not extend execution authority. Expiry of one of these
cache/product windows may reduce convenience or cause a cold restore, but it
must not make a stale lease valid or delete the committed Pi/Workspace head.

## Consequences

- Boundary values fail fast instead of producing intermittent `UNKNOWN` Tool
  outcomes or rollout-only checkpoint loss.
- Compose and both Worker Helm profiles share a CI policy check so their
  budgets cannot drift independently.
- Increasing one upstream timeout may require increasing downstream deadlines
  and deployment termination grace. Operators should change the chain as one
  reviewed policy, not override one value in isolation.
- Retention remains layered: Kafka/Valkey contain live delivery data,
  PostgreSQL contains canonical Turns and cursors, and S3/Kopia contain Pi and
  Workspace checkpoints.
