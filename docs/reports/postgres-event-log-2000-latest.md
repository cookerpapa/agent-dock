# PostgreSQL durable event-log capacity

Generated: 2026-08-21T16:06:42.813Z

This test writes 8,000 durable events for 2,000 active Sessions through the real PiCloud DurableEventStore.

- Result: PASS
- Throughput: 1,361.19 events/s
- Batch ACK p50/p95/p99: 172.09 / 274.61 / 320.99 ms
- WAL: 13,409,456 bytes (1676.18 bytes/event)
- Decision: postgresql_remains_the_single_durable_event_authority
