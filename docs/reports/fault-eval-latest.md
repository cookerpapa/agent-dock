# PiCloud deterministic fault evaluation

Generated: 2026-08-21T13:12:45.519Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 10
- Invariants preserved: 10/10 (100.0%)
- p50 / p95: 4197 ms / 6316 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2223 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2239 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 4132 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 4197 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not read or wait for Kafka/Valkey projection state. | 6108 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 2432 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 5958 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 6163 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 6316 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 6105 ms |
