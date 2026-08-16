# PiCloud deterministic fault evaluation

Generated: 2026-08-16T12:31:15.763Z

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 11
- Invariants preserved: 11/11 (100.0%)
- p50 / p95: 3046 ms / 8129 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 2976 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 3046 ms |
| event-ack-loss | pass | A lost acknowledgement causes safe replay rather than event loss. | 2930 ms |
| worker-process-sigkill-after-wal-sync | pass | A real Worker process death after local WAL sync cannot erase the durable delivery suffix. | 1878 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 3041 ms |
| control-plane-recovery-ack-loss | pass | A Control Plane death with an in-flight recovery ACK cannot wedge Worker reconnection or discard the WAL suffix. | 3224 ms |
| corrupt-event-spool | pass | Corrupt durable events are rejected rather than silently skipped. | 2880 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 7538 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 7886 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 8129 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 7611 ms |
