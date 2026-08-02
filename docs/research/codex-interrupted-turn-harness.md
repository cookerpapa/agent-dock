# Codex interrupted-turn harness

This focused note is complemented by the broader
[Codex Agent Harness lessons](codex-agent-harness-lessons.md), which covers
Turn lifecycle, Step context, Tool execution, retry, Compaction and recovery.

- Date: 2026-08-02
- Upstream inspected: `openai/codex` commit
  `2b5bdcf67547860f2e5c5a605009a70026796b2b`
- Decision: adopt the model-visible interruption boundary, not Codex's local
  process-lifetime assumptions.

## Upstream behavior

Codex TUI maps the interrupt shortcut (`Esc` by default) to `Op::Interrupt`.
The Core then:

1. cancels the active Task token;
2. allows a short graceful-settlement window;
3. aborts the remaining Task;
4. appends a hidden, model-visible `<turn_aborted>` history item;
5. flushes the rollout before emitting `TurnAborted` to clients.

The marker says the prior Turn was deliberately interrupted, commands may
have partially executed and background unified-exec processes may still be
running. The next model call receives that item as conversation context. The
`agents.interrupt_message` configuration defaults to enabled.

Changing to full access is a separate session-configuration action. If the
user presses `Esc` first, the interruption boundary is already recorded; the
new permission profile applies to subsequent work. The permission change is
not what reconstructs prior execution state.

Codex App Server exposes the same lifecycle as `turn/interrupt` followed by a
terminal `turn/completed` notification with interrupted status. It explicitly
does not claim that interrupting a Turn terminates all background terminals.

Relevant upstream sources:

- `codex-rs/core/src/context/turn_aborted.rs`
- `codex-rs/core/src/tasks/mod.rs`
- `codex-rs/core/src/session/handlers.rs`
- `codex-rs/tui/src/keymap.rs`
- `codex-rs/app-server/README.md`

## AgentDock mapping

AgentDock already had two durable interruption paths:

- catchable cancellation/failure appends `agent-dock.run_interrupted` to Pi's
  native Session JSONL and commits an interrupted Pi checkpoint;
- `SIGKILL`, OOM or node loss uses PostgreSQL's durable public events to append
  one bounded semantic recovery item after the last committed Pi checkpoint.

The first implementation made both paths carry a detailed next-Turn policy.
That was rejected after comparing the exact upstream model-visible payload:
Codex records uncertainty but does not tell the model how to recover. AgentDock
therefore adopts the same separation:

- trusted metadata retains exact reason, Run/Attempt and durable sequence data;
- model context receives a short `<turn_aborted>` factual boundary;
- the hard-crash bridge retains only user-visible durable semantics and marks
  in-flight Tool completion as unknown;
- no fixed inspection or replay procedure is injected into the next prompt.

AgentDock adds one cloud-specific distinction. The Sandbox Manager reports
whether the exact Session Cube is warm-reused or cold-restored. Pi stores the
last active activation in a non-model custom entry; a confirmed loss emits one
short `<sandbox_reset>` fact and records an unavailable state so pure-chat Runs
do not repeat it. This does not claim to restore process memory or prove an
arbitrary shell command executed exactly once.
