# AgentDock collaboration instructions

## Mission

Build a portfolio-quality, cloud-oriented coding-agent runtime around Pi's
native RPC mode. The project must demonstrate reliable agent infrastructure, not merely a
chat UI or a collection of framework integrations.

## Before changing code

Read these files first:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/ROADMAP.md`
4. `docs/BACKLOG.md`

Work on one roadmap item or one vertical slice at a time. If a requested change
alters an architectural invariant, storage ownership, security boundary, or
protocol, record the decision under `docs/adr/` before implementation.

## Engineering rules

- Keep Pi-specific RPC messages inside the trusted runner/sandbox-supervisor adapter; the
  public API and durable domain model must use AgentDock-owned schemas.
- Run the fixed Pi core only in the trusted Agent Runner, never in the API/control-plane
  process. Route every untrusted file or shell operation to a separate Tool Sandbox.
- Load only image-owned trusted infrastructure extensions in the Agent Runner. Future
  user/project extensions require a separately threat-modelled sandbox boundary.
- Use Pi's public tool/extension APIs rather than patching its agent loop.
- Treat unsupported TUI-only extension behavior explicitly in a compatibility matrix.
- Persist commands before acknowledging them.
- Use idempotency keys, leases, and fencing tokens for distributed mutations.
- Preserve per-session ordering without dedicating a process or OS thread to a cold session.
- Treat Pi session JSONL as conversation history, PostgreSQL as control state,
  and object storage as durable artifact/snapshot storage.
- Do not claim exactly-once semantics for arbitrary shell commands or external side effects.
- Do not run untrusted tools in the control-plane or trusted Agent Runner process.
- Do not mount the Docker socket, host home directory, or long-lived provider
  credentials into an agent sandbox.
- Do not add Kafka, Flink, Redis, Temporal, or Kubernetes merely to make the
  architecture look larger. Add infrastructure only with a demonstrated need.
- Pin Pi and other important dependency versions and provide upgrade contract tests.
- Never commit secrets, generated credentials, session transcripts, or user repositories.

## Vibe-coding discipline

The human owner is not expected to hand-write implementation code, but every
change must remain understandable and demonstrable:

1. State the behavior and acceptance criteria before editing.
2. Inspect existing code and tests before choosing an implementation.
3. Implement the smallest complete vertical slice.
4. Add or update automated tests.
5. Run the relevant verification commands.
6. Explain the data flow, failure behavior, and important tradeoffs in plain language.
7. Update `docs/BACKLOG.md` and any affected architecture document.

Avoid generating large placeholder architectures whose components do not yet
communicate end to end.

## Definition of done

A backlog item is complete only when:

- its acceptance criteria pass;
- errors, cancellation, and relevant crash behavior are covered;
- logs do not expose secrets;
- public protocol/schema changes are documented;
- the implementation can be demonstrated from a clean checkout;
- the owner can explain why the design was chosen.
