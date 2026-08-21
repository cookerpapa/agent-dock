# PiCloud deterministic fault evaluation

Generated: 2026-08-21T19:41:43.934Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 12
- Invariants preserved: 12/12 (100.0%)
- p50 / p95: 4359 ms / 6555 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2176 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2154 ms |
| stale-kafka-event-authority | pass | A stale Worker may reach Raw Kafka but cannot publish browser-visible Accepted events. | 5966 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 4243 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 4294 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 4359 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 6208 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 2489 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 5770 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 6317 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 6526 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 6555 ms |
