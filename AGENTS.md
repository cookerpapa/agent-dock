# PiCloud collaboration instructions

## Mission

Build a portfolio-quality, cloud-oriented coding-agent runtime around Pi's
public embedded SDK. The project must demonstrate reliable agent
infrastructure, not merely a chat UI or a collection of framework integrations.

## Before changing code

Read these files first:

1. `README.md`
2. `docs/README.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`
5. `docs/BACKLOG.md`

Those files and the indexed ADRs describe the maintained architecture. Treat
the implementation-log history, `docs/discussions/`, research and earlier
database migrations as historical evidence, not as current topology. In particular,
historical Cell, Temporal and Worker-affinity names must never be inferred back
into the active runtime without confirming current production code and the
current architecture ADR.

Work on one roadmap item or one vertical slice at a time. If a requested change
alters an architectural invariant, storage ownership, security boundary, or
protocol, record the decision under `docs/adr/` before implementation.

## Engineering rules

- Keep Pi-specific runtime events inside the trusted
  runner/sandbox-supervisor adapter; the public API and durable domain model
  must use PiCloud-owned schemas.
- Run the fixed Pi core only in the trusted Agent Runner, never in the API/control-plane
  process. Route every untrusted file or shell operation to a separate Tool Sandbox.
- Load only code-owned trusted infrastructure tools in the Agent Runner.
  User/project extensions are outside the current product boundary.
- Use Pi's public tool/extension APIs rather than patching its agent loop.
- Persist commands before acknowledging them.
- Use idempotency keys, leases, and fencing tokens for distributed mutations.
- Preserve per-session ordering without dedicating a process or OS thread to a cold session.
- Treat Pi's PostgreSQL `SessionStorage` as conversation authority,
  PostgreSQL as the sole Run/control authority and Accepted Kafka as the
  bounded hot-stream authority. Any Pi JSONL compatibility
  object must remain a bounded PostgreSQL-backed upstream adapter; it is never
  a lifetime transcript or a second conversation authority.
- Treat the persistent Cube Volume as the sole Workspace byte authority. Do
  not add a second per-Run archive/checkpoint head without measured recovery
  requirements and a new ADR.
- Do not claim exactly-once semantics for arbitrary shell commands or external side effects.
- Do not run untrusted tools in the control-plane or trusted Agent Runner process.
- Keep activation authorization and identity fencing in Tool Broker; the
  `SandboxProvider` adapter owns Cube mechanics but must not receive Broker
  bearer credentials or expose its native SDK to the Worker.
- CubeSandbox KVM is the only supported Tool runtime. Adding an alternate
  runtime requires a new current ADR and the same security/recovery acceptance
  suite; it must not enter as a silent fallback.
- Do not mount the Docker socket, host home directory, or long-lived provider
  credentials into an agent sandbox.
- Do not add a second event broker, cache, workflow scheduler or cluster layer
  merely to make the architecture look larger. Kafka, PostgreSQL and Kubernetes have
  bounded current roles; additions require a demonstrated gap and the
  adopt-before-build policy below.
- Pin Pi and other important dependency versions and provide upgrade contract tests.
- Never commit secrets, generated credentials, session transcripts, or user repositories.

## Adopt before build

Infrastructure is not a creativity contest. Before implementing a distributed
queue, workflow engine, scheduler, event store, sandbox runtime, identity
system, policy engine, telemetry pipeline, or storage protocol:

1. Survey actively maintained open-source implementations using official
   documentation, source, releases, license, and failure semantics.
2. Prefer a well-supported project from an established company, standards body,
   or neutral foundation when it satisfies PiCloud's measured requirements.
   Fit, security boundaries, operational cost, and exit strategy matter more
   than GitHub stars or vendor reputation alone.
3. Record build-versus-adopt evidence in a research note or ADR. A custom
   implementation is allowed only when no candidate preserves the required
   invariants, or when integration would create more correctness and
   operational risk than the bounded code being retained.
4. Put adopted infrastructure behind an PiCloud-owned port/adapter, pin its
   version or image digest, add contract and failure tests, and document
   rollback/export. Do not leak a vendor SDK into the public API or core domain.
5. Assign exactly one durable authority to each concern. Never run a framework
   and a home-grown replacement as competing schedulers, workflow histories, or
   checkpoint heads after cutover.
6. Keep large transcripts, tool output, Workspace bytes, credentials, and model
   payloads out of queue rows. PostgreSQL queue records carry bounded command
   references; PostgreSQL SessionStorage and persistent Cube Volumes own the
   corresponding durable data.

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
