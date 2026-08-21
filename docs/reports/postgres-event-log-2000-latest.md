# PostgreSQL durable event-log capacity

Generated: 2026-08-21T15:32:10.407Z

This test writes 8,000 durable events for 2,000 active Sessions through the real PiCloud DurableEventStore.

- Result: PASS
- Throughput: 1,348.62 events/s
- Batch ACK p50/p95/p99: 176 / 262.01 / 288.15 ms
- WAL: 13,251,949 bytes (1656.49 bytes/event)
- Decision: postgresql_remains_the_single_durable_event_authority
