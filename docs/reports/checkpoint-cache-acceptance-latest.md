# Worker-local checkpoint cache acceptance

- Checked at: 2026-07-25T22:45:21+08:00
- Cache policy: 10 minutes, 512 entries and 32 MiB per Pi Worker
- Current v2 Pi checkpoint download: 5,695 bytes average, 18,500 bytes p95 and 18,669 bytes maximum
- Current v2 Pi segments: 2 average
- Production cache reads per Worker: 20 hits / 4 misses (83.33% hit rate)
- Production cache residency: 28 entries and 30,999–31,376 bytes per Worker
- Completed follow-up restores: 6 per Worker; every restore fell below the 25 ms Prometheus bucket
- Direct MinIO restore p50/p95: 4.488 / 10.375 ms
- Cached restore p50/p95: 0.073 / 0.278 ms

The direct benchmark reconstructed the same current v2 Pi session 20 times,
including manifest and content-addressed segment integrity validation. The
cached benchmark used the production `TtlCheckpointObjectStore` wrapper.
PostgreSQL head resolution was deliberately not cached and is outside this
object-transport microbenchmark.

The multi-tenant production run independently exercised six first turns and
six follow-up restores across two capacity-one Workers. The cache mainly
eliminated repeated reads between restore and incremental checkpoint save; it
does not depend on Temporal sending the next Run to the same Worker.
