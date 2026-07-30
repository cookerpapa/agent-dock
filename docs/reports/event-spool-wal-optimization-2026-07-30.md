# Worker event spool WAL optimization

Checked at: 2026-07-30

Command:

```bash
npm run benchmark:event-spool
```

The benchmark creates one assignment, durably appends 500 representative
`assistant.text.delta` events, applies one cumulative ACK and performs no model
calls.

| Metric | File per event | Append-only WAL |
| --- | ---: | ---: |
| append wall time | 6,719.831 ms | 3,265.512 ms |
| durable appends/second | 74.4 | 153.1 |
| cumulative ACK | 40.011 ms | 24.298 ms |
| filesystem entries after drain | 3 | 1 |

The final entry count understates the peak difference: before ACK, the original
layout had an assignment directory, manifest, events directory and 500 event
files. The replacement has one WAL.

Validation covers:

- restart replay of a contiguous pending suffix;
- commit-with-lost-ACK duplicate delivery;
- truncation of only an incomplete final record;
- checksum corruption and sequence-gap failure;
- conflicting duplicate and capacity rejection;
- cumulative ACK and assignment fencing;
- stale-fence quarantine;
- crash after rejection fsync but before quarantine rename;
- the end-to-end Control Plane duplicate ACK path.

The replacement keeps the public invariant unchanged: the Worker does not
publish an event until its WAL record is fsynced, and it does not discard the
delivery copy until PostgreSQL returns a valid cumulative ACK.
