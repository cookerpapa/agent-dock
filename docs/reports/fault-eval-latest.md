# AgentDock deterministic fault evaluation

Generated: 2026-08-01T05:14:38.264Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 12
- Invariants preserved: 12/12 (100.0%)
- p50 / p95: 3695 ms / 8442 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| checkpoint-commit-failure | pass | A Run cannot become completed before its settled checkpoint commits. | 3204 ms |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2999 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 3074 ms |
| event-ack-loss | pass | A lost acknowledgement causes safe replay rather than event loss. | 3015 ms |
| corrupt-event-spool | pass | Corrupt durable events are rejected rather than silently skipped. | 3153 ms |
| object-store-outage | pass | A temporary object-store outage remains retryable and does not expose credentials. | 3695 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 7288 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 8442 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 8199 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 7404 ms |
| attempt-rewind-boundary | pass | Rewind restores the explicit committed bases, supersedes the old projection, and creates one idempotent replacement Run. | 8039 ms |
| immutable-review-bundle | pass | A completed Run's content-verified Review Bundle cannot be updated or deleted. | 4372 ms |
