# AgentDock deterministic fake model server

This package is a loopback-only, OpenAI Chat Completions compatible test server.
It makes model streams and provider failures reproducible without spending
tokens or putting provider credentials into test fixtures.

The server implements `POST /v1/chat/completions` with `stream=true`. Select a
scenario through the `x-agent-dock-scenario` request header:

| Scenario | Deterministic behavior |
| --- | --- |
| `text` | Two text deltas, a stop chunk, usage, and `[DONE]` |
| `tool_call` | A fragmented `inspect_workspace({"path":"src"})` tool call; after a tool-result message, a final text response |
| `java_repair` | Successive `bash`, `edit`, and `bash` calls driven by prior tool-result count, followed by final text |
| `rate_limit` | OpenAI-style HTTP 429 with `Retry-After` |
| `timeout` | Withholds HTTP response headers until timeout/abort closes the request |
| `malformed` | Sends invalid SSE JSON |
| `disconnect` | Sends partial text and destroys the stream before a finish reason |

Request observations deliberately contain only request ID, scenario, model,
message/tool counts, status, and completion mode. Authorization values and
message contents are neither retained nor logged.

## Run locally

```bash
npm run fake-model:start
```

The default endpoint is `http://127.0.0.1:4010/v1` and the fixed local-only API
key is `agent-dock-test-key`. The server rejects non-loopback bind addresses.
This credential has no value outside the fake server and must never be reused
for a real provider.

## Verify the Pi contract

```bash
npm test --workspace @agent-dock/fake-model-server
```

The contract suite sends real HTTP/SSE requests through the pinned Pi `0.80.10`
OpenAI adapter. It checks text deltas, fragmented tool arguments, the follow-up
after a tool result, the complete Java repair loop, provider error mapping,
request timeout, explicit abort, malformed SSE, and mid-stream disconnect.
