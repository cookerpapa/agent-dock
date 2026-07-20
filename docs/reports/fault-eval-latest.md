# AgentDock deterministic fault evaluation

Generated: 2026-07-20T08:52:18.272Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 10
- Invariants preserved: 10/10 (100.0%)
- p50 / p95: 2529 ms / 5762 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| checkpoint-commit-failure | pass | A Run cannot become completed before its settled checkpoint commits. | 3115 ms |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2175 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2345 ms |
| event-ack-loss | pass | A lost acknowledgement causes safe replay rather than event loss. | 2314 ms |
| corrupt-event-spool | pass | Corrupt durable events are rejected rather than silently skipped. | 2312 ms |
| object-store-outage | pass | A temporary object-store outage remains retryable and does not expose credentials. | 2529 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 5587 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 5554 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 5762 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 5494 ms |
