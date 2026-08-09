# PostgreSQL durable event-log capacity

Generated: 2026-08-09T13:30:52.895Z

This test writes 128,000 durable events for 2,000 active Sessions through the real AgentDock DurableEventStore.

- Result: FAIL
- Throughput: 3,223.04 events/s
- Batch ACK p50/p95/p99: 2253.98 / 3592.39 / 4068.21 ms
- WAL: 132,842,576 bytes (1037.83 bytes/event)
- Decision: postgresql_profile_failed_slo_evaluate_kafka_cutover
