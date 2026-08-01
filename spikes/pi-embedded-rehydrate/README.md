# Pi embedded rehydrate spike

This spike tests the production Pi SDK activation contract. It embeds
the pinned Pi SDK inside an execution-side worker, creates a short-lived
`AgentSession` for one activation, and disposes the complete runtime at the end.
The default spike never calls an LLM and never starts a Pi child process. A
separate, explicitly authorized live-provider probe is documented below.

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

The production execution path is verified independently by the Supervisor
image-closure and CubeSandbox template gates. This spike remains a zero-token
contract probe for Pi's public embedded SDK and native session rehydration.

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

## Optional live ChatGPT-subscription probe

The live probe verifies the boundary that the zero-token tests intentionally do
not exercise: a real assistant turn creates the JSONL checkpoint naturally, a
fresh backend restores it, and a second model turn sees the first turn's
context. It uses `openai-codex/gpt-5.4-mini` with thinking disabled, enables no
tools or extensions, stores the temporary transcript outside the repository,
and deletes it on exit.

It is excluded from `npm run check` and refuses to start unless quota use is
explicitly authorized:

```bash
AGENT_DOCK_ALLOW_SUBSCRIPTION_USAGE=1 npm run spike:live-model
```

The owner must already have completed Pi's `/login` ChatGPT-subscription flow.
Only token counts and pass/fail assertions are printed; OAuth values and
conversation text are not. Direct SDK use bypasses Pi's CLI bootstrap, so the
embedded backend installs its own pinned Undici HTTP runtime before the first
model-enabled activation. It honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
from the worker environment without returning or logging their values. The
probe pins transport to SSE so a separate WebSocket proxy limitation cannot mask
the rehydration result. This local probe's access to the owner's Pi credential
directory is not the production credential-distribution design described in
ADR-0006.

## What it does not prove

- safety for arbitrary or untrusted extensions in a shared process;
- restoration of JS heap, child processes, sockets, browsers, or in-flight tool
  calls;
- process-crash recovery, distributed leases, fencing, or durable command ACKs;
- production memory density or horizontal routing;
- production OAuth storage or credential brokering;
- compatibility with every Pi extension and future Pi version.

The inline counter is intentionally trusted and portable. User/project
extensions remain assigned to an isolated process or sandbox until a policy and
security boundary explicitly permit otherwise.

Pi deliberately does not create a session JSONL before the first assistant
message. Because this spike spends no model tokens and runs extension commands
only, it inserts one clearly labelled, zero-token synthetic assistant marker to
reach a settled persistence boundary. A production LLM turn creates the real
assistant message and must not insert this marker.
