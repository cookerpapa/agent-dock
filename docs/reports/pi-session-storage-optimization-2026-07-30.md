# Pi Session storage optimization decision

Checked at: 2026-07-30

## Question

The architecture review proposed replacing content-addressed Pi JSONL segments,
immutable manifests and the Worker-local object cache with one immutable object
per settled Run. The current production sample was small:

- 5,695 bytes average checkpoint download;
- 18,500 bytes p95;
- two segments on average;
- direct MinIO restore p50/p95 of 4.488/10.375 ms;
- cached restore p50/p95 of 0.073/0.278 ms.

For those sessions, neither segmentation nor caching is required for latency.

## Long-session benchmark

`npm run benchmark:pi-session-storage` generated 120 settled Pi turns with no
model calls. The final native JSONL was 560,167 bytes.

| Layout | Cumulative bytes written | Objects |
| --- | ---: | ---: |
| full immutable JSONL per Run | 33,897,660 | 120 |
| content-addressed segments plus manifests | 1,439,612 | 241 unique |

The segmented layout reduced cumulative storage by 95.75%. The final manifest
referenced 26 segments after three bounded consolidations. Reconstructing it
100 times was byte-identical and measured:

- p50: 6.057 ms;
- p95: 13.268 ms;
- 27 immutable object reads.

## Decision

Retain both behaviors:

1. Pi-native JSONL remains the recovery authority, including Pi compaction,
   branches and Session tree records.
2. Content-addressed segments remain because their benefit grows with the
   long-running Sessions the product is designed to preserve.
3. The ten-minute cache remains because it is bounded to 512 entries/32 MiB,
   has measured 83.33% production hit rate and avoids repeated immutable object
   reads without caching the PostgreSQL head.

The implementation is simplified structurally instead: the cache is moved
from the already-large checkpoint persistence module into
`checkpoint-object-cache.ts`, with its existing focused crash/copy/TTL tests.

This is a measured non-removal decision. Replacing the layout with one object
would make the common small-session path cosmetically simpler while producing
roughly 23.5 times more cumulative checkpoint data in the long-session
benchmark.
