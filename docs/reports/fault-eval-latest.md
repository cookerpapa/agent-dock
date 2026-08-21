# PiCloud deterministic fault evaluation

Generated: 2026-08-21T20:37:51.107Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 14
- Invariants preserved: 14/14 (100.0%)
- p50 / p95: 5757 ms / 6455 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2525 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2230 ms |
| stale-kafka-event-authority | pass | A stale Worker may reach Raw Kafka but cannot publish browser-visible Accepted events. | 6234 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 4017 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 3868 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 4325 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 6310 ms |
| accepted-projection-ahead-of-worker-ack | pass | An Accepted projector that commits before the Worker observes its ACK cannot strand terminal Run settlement. | 6232 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 2395 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 5757 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 5920 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 6321 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 6455 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 6079 ms |
