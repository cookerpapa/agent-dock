# AgentDock Web UI

This workspace contains the Phase 1 Pi-`/export`-inspired React session page. It
uses only the public control-plane REST and SSE contracts; it never reads Pi
JSONL, launches a process, talks to Docker, or receives a provider credential.

## Behavior

- creates the sample project/session and durably submits Java repair turns;
- streams ordered assistant/tool/approval/terminal events;
- reconnects with explicit `Last-Event-ID` and suppresses replay duplicates;
- exposes cancellation only after the execution start event;
- renders the bounded final unified diff;
- displays session, turn, connection, sandbox, and sequence state in text as
  well as color;
- provides a keyboard-resizable desktop tree and mobile sidebar overlay.

All API resources and events are validated with `@agent-dock/protocol`. Markdown
raw HTML is disabled by default, remote images are replaced with inert labels,
and unknown tool values are rendered as bounded text. The client does not write
request bodies, events, tokens, or credential references to the console.

## Run and verify

From the repository root, the complete zero-token flow is:

```bash
npm run demo
```

For frontend-only work, start a compatible API on `127.0.0.1:3100` and run:

```bash
npm run dev --workspace @agent-dock/web-ui
```

The production bundle, strict type check, and deterministic tests are:

```bash
npm run build --workspace @agent-dock/web-ui
npm run typecheck --workspace @agent-dock/web-ui
npm run test --workspace @agent-dock/web-ui
```

The Phase 2 checkpoint slice permits a second turn on the same session. It
rehydrates Pi JSONL and the bounded sample workspace into a new disposable
container before the follow-up runs. Session discovery after page reload,
approval responses, arbitrary repository import, and a production S3/MinIO
adapter remain deferred.
