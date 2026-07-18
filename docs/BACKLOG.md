# Initial backlog

Only the current phase should contain implementation work. Later phases remain
in `ROADMAP.md` until their prerequisites are complete.

## Phase 0

- [x] ADR-0001: TypeScript runtime language, sandbox boundary, and RPC-first Pi integration
- [x] ADR-0003: state ownership across PostgreSQL, Pi JSONL, object storage, and the event spool
- [x] ADR-0004: command idempotency, event sequence, lease, and fencing model
- [x] Research existing application-state, sandbox, and process-hibernation runtimes
- [x] ADR-0005: pluggable execution and recovery tiers
- [x] ADR-0006: single-user v0 scope, model profiles, and credential ownership
- [x] Create `spikes/pi-extension-compat/`
- [x] Pin a Pi version and start `pi --mode rpc --no-session` from a TypeScript supervisor
- [x] Add an unchanged sample extension with a `/cloud-check` command
- [x] Assert that `get_commands` discovers `/cloud-check`
- [x] Make `/cloud-check` call `ctx.ui.confirm()` and `ctx.ui.notify()`
- [x] Proxy `extension_ui_request` to a test client and return `extension_ui_response`
- [x] Verify clean cancellation and complete Pi child-process termination
- [ ] Run the spike inside a non-root Docker container
- [x] Publish the initial extension compatibility matrix
- [x] Define the public AgentDock event envelope
- [x] Define supervisor registration, command, event, ACK, and heartbeat messages
- [x] Prove SDK rehydration of Pi messages and `appendEntry` extension state
- [x] Prove same-session FIFO and bounded cross-session SDK activations
- [x] Record that Pi JSONL becomes durable only after an assistant message exists
- [x] Add an explicit opt-in real-provider rehydration probe, including SDK HTTP
  bootstrap, excluded from CI
- [x] Model session, turn, sandbox, approval, and agent-node states
- [x] Create initial PostgreSQL schema and Kysely migrations
- [ ] Create local Docker Compose topology
- [x] Implement deterministic fake model server
- [x] Script fake text streaming and tool-call scenarios
- [x] Script 429, timeout, malformed response, and stream-disconnect scenarios
- [ ] Add CI for formatting, unit tests, and secret scanning

## First vertical-slice story

As a user, I can import a sample Java repository, create a session, ask the Pi
agent to repair a failing test, observe text and tool events in real time, cancel
the turn, and inspect the final Git diff.

Acceptance criteria:

- [ ] The command is durably accepted before execution starts
- [ ] The supervisor uses a pinned Pi RPC process through an AgentDock adapter
- [ ] The workspace and all extensions run outside the NestJS control-plane process
- [ ] Text and tool events carry session, turn, agent, and sequence identifiers
- [ ] SSE reconnect resumes from the last acknowledged event
- [ ] Cancellation stops the model request and complete tool process tree
- [ ] No provider credential appears in logs or the workspace
- [ ] A clean-checkout command reproduces the demo
