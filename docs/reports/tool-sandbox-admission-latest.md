# Tool Sandbox admission and Worker capacity acceptance

- Checked at: 2026-07-26T00:04:44+08:00
- Host memory: 15,830 MiB
- Pi Workers: eight Docker Compose replicas, capacity one each
- Cube template: 2,000 millicores and 2,000 MB per guest
- Global Cube admission: two

Four independent real-model Coding Runs were submitted concurrently. Each
model emitted one Bash Tool Call that slept for 12 seconds inside its own
CubeSandbox KVM guest. The Runs were assigned by the common Temporal Task Queue
to four distinct capacity-one Pi Workers.

Authenticated Sandbox Manager metrics were sampled 86 times and observed:

```text
maximum admitted = 2
maximum waiting  = 2
configured limit = 2
```

All four Runs completed in one Attempt with four `tool.started` and four
`tool.completed` events. The first admitted pair settled in 17,669 and
17,799 ms; the queued pair settled in 32,959 and 33,199 ms. This is the
expected bounded-admission shape: excess Runs waited without creating more
than two heavy guests, then continued when the first pair released capacity.
The complete wall-clock time was 33,415 ms.

The gate made eight real provider requests and consumed 1,108 input, 625 output
and 10,752 cache-read tokens. After completion the Manager reported zero
admitted and zero waiting activations. The temporary owner-tenant concurrency
increase was restored from four to two.

In a post-test snapshot, the eight trusted Pi Worker containers used about
2,350 MiB in total (257–316 MiB each), while the host had 5,135 MiB available.
Pi replicas therefore have a meaningful baseline cost, but each admitted Cube
guest has a much larger 2,000 MB configured ceiling. Worker count and Tool
guest count must remain independent controls: scale Workers for model/Agent
Loop concurrency, and size Cube admission from host memory/CPU headroom.
