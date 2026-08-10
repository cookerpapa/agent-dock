# Enterprise event-pipeline acceptance

- Measured: 2026-08-10T15:43:28.162Z
- PostgreSQL: real server
- Kafka: real single broker
- Valkey: real server
- Projected events: 5
- Invalid service token rejected: yes
- Duplicate projection rows: 0
- Projector stop/restart recovery: passed
- Terminal projection barrier: passed
- PostgreSQL payload Outbox present: no

- PostgreSQL raw streaming rows: 0

This is a single-node functional acceptance, not a multi-broker HA, failover, or capacity claim.
