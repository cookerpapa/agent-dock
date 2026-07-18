# Pi embedded rehydrate spike

This spike tests the lowest-cost execution tier proposed by ADR-0005. It embeds
the pinned Pi SDK inside an execution-side worker, creates a short-lived
`AgentSession` for one activation, and disposes the complete runtime at the end.
It never calls an LLM and never starts a Pi child process.

## What it proves

- multiple logical sessions execute in the same Node worker process;
- every logical session has a FIFO lane, while different sessions share a
  bounded global activation pool;
- Pi JSONL is sufficient to reconstruct persisted assistant messages;
- a portable extension can reconstruct closure state during `session_start`
  after writing it through `pi.appendEntry()`;
- a fresh backend object with no session cache can continue from a durable
  checkpoint path;
- `AgentSessionRuntime.dispose()` emits extension shutdown and releases active
  capacity after success or failure.

Run it with:

```bash
npm run spike:embedded
```

An opt-in density probe activates and cools 1,000 logical sessions, then wakes
10 concurrently and reports measured heap/RSS instead of adding a slow benchmark
to every CI run:

```bash
npm run spike:density
```

Two recorded local runs cooled 1,000 sessions in 2.701–2.875 seconds, reached
exactly 10 active runtimes when 10 were requested, and returned to zero active
runtimes. Forced-GC heap growth after 1,000 idle sessions was 3.55–3.59 MB.
RSS grew by 135–168 MB but is reported only as allocator/module high-water
evidence, not as live per-session runtime memory. This no-model probe is not a
production capacity promise.

The Vitest suite also covers same-session concurrent submission, cross-session
concurrency, a failing extension command, and rejection of a checkpoint outside
the backend-owned session directory.

## What it does not prove

- safety for arbitrary or untrusted extensions in a shared process;
- restoration of JS heap, child processes, sockets, browsers, or in-flight tool
  calls;
- process-crash recovery, distributed leases, fencing, or durable command ACKs;
- production memory density or horizontal routing;
- compatibility with every Pi extension and future Pi version.

The inline counter is intentionally trusted and portable. User/project
extensions remain assigned to an isolated process or sandbox until a policy and
security boundary explicitly permit otherwise.

Pi deliberately does not create a session JSONL before the first assistant
message. Because this spike spends no model tokens and runs extension commands
only, it inserts one clearly labelled, zero-token synthetic assistant marker to
reach a settled persistence boundary. A production LLM turn creates the real
assistant message and must not insert this marker.
