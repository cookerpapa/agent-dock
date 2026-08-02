# Codex interrupted-turn harness

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

The adopted change makes both paths carry the same next-Turn policy:

- execution and process state are uncertain;
- if the new request depends on interrupted work, inspect the Workspace and
  process state before changing it further;
- never blindly repeat an uncertain side effect;
- a newer unrelated user request supersedes the interrupted task.

This is deliberately stronger than a local-only harness: AgentDock can carry
the warning across Worker and node replacement. It still does not claim to
restore process memory or prove an arbitrary shell command executed exactly
once.
