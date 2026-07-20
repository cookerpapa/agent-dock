# AgentDock control-plane load evaluation

Generated: 2026-07-20T09:12:11.382Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 36.59/s | 84 ms | 271 ms | 271 ms |
| read_conversation | 10 | 10 | 0 | 100.39/s | 24 ms | 98 ms | 98 ms |
| create_cold_session | 50 | 50 | 0 | 82.2/s | 336 ms | 592 ms | 600 ms |
| read_conversation | 50 | 50 | 0 | 272.87/s | 95 ms | 176 ms | 177 ms |
| create_cold_session | 100 | 100 | 0 | 114.2/s | 560 ms | 831 ms | 853 ms |
| read_conversation | 100 | 100 | 0 | 236.81/s | 318 ms | 408 ms | 410 ms |
