# PiCloud deterministic fault evaluation

Generated: 2026-08-21T15:42:53.020Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 10
- Invariants preserved: 10/10 (100.0%)
- p50 / p95: 5680 ms / 8826 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 3546 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 3228 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 5680 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 5583 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 8342 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 3349 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 8447 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 8512 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 8826 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 8203 ms |
