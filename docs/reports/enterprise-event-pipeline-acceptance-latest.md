# Enterprise event-pipeline acceptance

- Measured: 2026-08-21T13:28:37.774Z
- PostgreSQL: real server
- Kafka: real single broker
- Valkey: real server
- Projected events: 5
- Invalid service token rejected: yes
- Duplicate projection rows: 0
- Projector stop/restart recovery: passed
- Terminal commit independent of live projection: passed
- PostgreSQL payload Outbox present: no

- PostgreSQL raw streaming rows: 0

This is a single-node functional acceptance, not a multi-broker HA, failover, or capacity claim.
