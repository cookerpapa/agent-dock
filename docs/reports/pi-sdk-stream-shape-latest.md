# Pi SDK stream-shape acceptance

Generated: 2026-08-21

Pi 0.84.1 and DeepSeek `deepseek-v4-flash` executed a real coding task that
read an existing Python implementation, wrote `binary_search.py`, ran both
programs and returned a final Chinese summary. Raw reasoning content and model
credentials are deliberately excluded from this report.

## Observed event counts

| Pi event | Count | PiCloud treatment |
| --- | ---: | --- |
| `message_update.toolcall_delta` | 580 | ignored; complete validated input arrives at Tool start |
| `message_update.thinking_delta` | 116 | private; not part of the public event stream |
| `message_update.text_delta` | 72 | coalesced for 100 ms/4 KiB, persisted, then streamed |
| `tool_execution_update` | 5 | ignored; partial Tool output is not public |
| `tool_execution_start` | 4 | one durable `tool.started` Item per Tool |
| `tool_execution_end` | 4 | one durable `tool.completed` Item per Tool |
| `turn_start` / `turn_end` | 4 / 4 | low-frequency lifecycle boundaries |
| `agent_end` / `agent_settled` | 1 / 1 | Run settlement boundaries |

The Run used three model responses with `stopReason=toolUse`, followed by one
response with `stopReason=stop`. This demonstrates why a `text_delta` cannot be
classified as final while it is arriving: Pi learns the authoritative stop
reason only when the complete Assistant message ends.

## Resulting public contract

- Assistant text is the only high-frequency public payload.
- Provider Tool-call JSON fragments never leave the trusted Worker.
- Tool stdout/stderr fragments never enter the public stream.
- Tool input and output become public only as complete `tool.started` and
  `tool.completed` Items.
- PostgreSQL acknowledgement precedes every SSE-visible event.
