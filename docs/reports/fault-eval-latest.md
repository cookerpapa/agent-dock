# AgentDock deterministic fault evaluation

Generated: 2026-08-08T08:40:32.207Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 15
- Invariants preserved: 15/15 (100.0%)
- p50 / p95: 2653 ms / 7231 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| checkpoint-commit-failure | pass | A Run cannot become completed before its settled checkpoint commits. | 2612 ms |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2454 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2472 ms |
| event-ack-loss | pass | A lost acknowledgement causes safe replay rather than event loss. | 2510 ms |
| worker-process-sigkill-after-wal-sync | pass | A real Worker process death after local WAL sync cannot erase the durable delivery suffix. | 1663 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 2369 ms |
| control-plane-recovery-ack-loss | pass | A Control Plane death with an in-flight recovery ACK cannot wedge Worker reconnection or discard the WAL suffix. | 2653 ms |
| corrupt-event-spool | pass | Corrupt durable events are rejected rather than silently skipped. | 2577 ms |
| object-store-outage | pass | A temporary object-store outage remains retryable and does not expose credentials. | 3539 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 6721 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 6572 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 6737 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 6530 ms |
| attempt-rewind-boundary | pass | Rewind restores the explicit committed bases, supersedes the old projection, and creates one idempotent replacement Run. | 7231 ms |
| immutable-review-bundle | pass | A completed Run's content-verified Review Bundle cannot be updated or deleted. | 3447 ms |
