# PiCloud collaboration instructions

## Mission

Build a portfolio-quality, cloud-oriented coding-agent runtime around Pi's
public embedded SDK. The project must demonstrate reliable agent
infrastructure, not merely a chat UI or a collection of framework integrations.

## Before changing code

Read these files first:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/ROADMAP.md`
4. `docs/BACKLOG.md`

Those four files describe the maintained architecture. Treat
`docs/IMPLEMENTATION_LOG.md`, `docs/discussions/`, superseded ADRs and earlier
database migrations as historical evidence, not as current topology. In
particular, historical Cell, Temporal and Worker-affinity names must never be
inferred back into the active runtime without confirming current production
code and the latest accepted ADR.

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
- Treat Pi's PostgreSQL `SessionStorage` as conversation authority and
  PostgreSQL as the sole Run/control authority. The stable JSONL adapter is a
  temporary upstream-compatibility boundary backed by PostgreSQL, not S3.
- Treat the persistent Cube Volume as the sole Workspace byte authority. Do
  not add a second per-Run archive/checkpoint head without measured recovery
  requirements and a new ADR.
- Do not claim exactly-once semantics for arbitrary shell commands or external side effects.
- Do not run untrusted tools in the control-plane or trusted Agent Runner process.
- Keep activation authorization and identity fencing in the provider-neutral
  ToolSandboxManager; a SandboxProvider may own runtime mechanics but must not
  receive Manager bearer credentials or expose its native SDK to the Runner.
- Provider selection is trusted deployment policy. Do not claim a planned
  gVisor, microVM, Kubernetes, or managed Provider until its shared acceptance
  suite passes.
- Do not mount the Docker socket, host home directory, or long-lived provider
  credentials into an agent sandbox.
- Do not add Kafka, Flink, Redis, Temporal, or Kubernetes merely to make the
  architecture look larger. Add infrastructure only with a demonstrated need,
  then apply the adopt-before-build policy below.
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
