# Pi extension compatibility matrix

This matrix records what Pi exposes in RPC mode and what AgentDock has actually
verified. It prevents the project from claiming that a browser can reproduce
every terminal-only extension behavior.

Tested baseline: `@earendil-works/pi-coding-agent` `0.80.10`.

| Extension capability | Pi RPC behavior | AgentDock status |
| --- | --- | --- |
| Command registration and discovery | Native; returned by `get_commands` | Verified by `/cloud-check` spike |
| Command invocation | Native through a `/command` prompt | Verified without an LLM call |
| `ui.confirm()` | Blocking request/response | Verified round trip |
| `ui.notify()` | Fire-and-forget request | Verified |
| `ui.select()`, `ui.input()`, `ui.editor()` | Blocking request/response | Adapter-mapped and unit-tested; live Pi round trip pending |
| Status, widget, title, editor text | Fire-and-forget requests | Protocol-supported; not yet mapped to web events |
| Tools, hooks, providers, compaction hooks | Run in Pi's native extension runtime | Planned integration coverage |
| Package/resource discovery | Native Pi behavior | Planned integration coverage |
| `ui.custom()` | Returns `undefined` in RPC mode | Unsupported |
| Custom header/footer/editor components | No-op in RPC mode | Unsupported |
| Working indicator and tool-expanded TUI state | No-op or degraded values | Unsupported/degraded |
| Theme enumeration and switching | Empty/undefined/failure in RPC mode | Unsupported |
| Terminal shortcuts | Terminal-specific and absent from RPC command discovery | Unsupported; requires a web-specific mapping |

An extension executes arbitrary Node.js code with the Pi process's permissions.
Compatibility never implies trust: user and project extensions must remain inside
the sandbox rather than loading into the AgentDock control plane.
