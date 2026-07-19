# ADR-0023: Production Supervisor host and self-hosted topology

- Status: accepted
- Date: 2026-07-19
- Amended by: ADR-0025 replaces the single-user public-token/runtime-tenant
  assumptions; the Supervisor-host and deployment trust boundaries remain.

## Context

ADR-0022 composes REST/SSE, the outbound Supervisor WebSocket, durable event
ingestion, bounded dispatch lanes, and retirement maintenance in one reusable
control-plane runtime. It deliberately stops short of a deployment entry point:
the existing development bearer authorizer binds one static boot, the owner
boundary and assignment inventory are injected test doubles, and there is no
trusted Supervisor host executable that composes Docker, PostgreSQL checkpoint
metadata, S3 objects, a crash-safe event spool, and reconnect.

Those gaps cannot be filled with deployment flags alone. Reusing a boot ID after
a process restart loses the in-memory assignment set while leaving an
acknowledged database turn under apparently healthy same-boot authority. Starting
to accept new commands before replaying the durable event spool can also create a
sequence gap. Treating WebSocket loss as process death can return capacity while
an old tool still writes. Finally, putting a Docker socket or S3 credentials in
the one-shot Pi container would collapse the sandbox boundary.

This decision defines a complete production deployment for the feature set that
is implemented today: ADR-0006's single-user, self-hosted topology and the
bounded deterministic Java-repair/follow-up path. It does **not** rename that
path into a generic repository service, a multi-tenant SaaS, or a real-provider
deployment. Generic repository import, policy-approved extensions, and a
request-scoped model gateway remain Phase 3 product work and must be reported as
such.

## Decision

### Process and boot ownership

1. Add a separate trusted `@agent-dock/supervisor-host` process. It is the only
   service allowed to invoke the Docker CLI for one-shot Pi workers and the only
   service that receives checkpoint object-store credentials. The NestJS
   control plane never runs Pi or an extension, and the one-shot worker receives
   neither the Docker socket, database URL, object-store credential, owner
   credential, nor Supervisor connection credential.
2. A stable `supervisorId` names one exclusively deployed host. Every operating
   system process start generates a fresh `bootId`, `sandboxId`, connection
   credential ID, and connection secret. Network reconnect inside that process
   keeps the boot. A process restart never reuses it.
3. A private, fsynced boot ledger records the current and bounded recent boot
   generations. On startup, the new process marks the previously active
   generation exited before recording its own generation. The supported Docker
   Compose topology runs exactly one host process for a stable `supervisorId` and
   stores this ledger on a private volume. An owner request for an unknown
   generation fails closed.
4. The host first starts its authenticated management endpoint, provisions the
   fresh boot, and then connects the Supervisor WebSocket in drain mode. It
   replays every valid pending event spool suffix and receives cumulative durable
   ACKs before changing `acceptingAssignments` to true. Recovery failure leaves
   the host unready and accepting no work.
5. An exact-boot stop request permanently drains that generation, closes its
   reconnect loop, revokes all assignments, waits for local runtime settlement,
   records the generation stopped, and only then returns proof. It cannot make
   that boot active again. The separate assignment-inventory phase removes any
   exact-labelled Docker remnants before PostgreSQL releases leases/capacity.

### Provisioning and credentials

6. Add an authenticated internal boot-provisioning endpoint. The host presents a
   long-lived enrollment secret read from a file and sends its generated IDs,
   capacity, a generated credential ID, and only the SHA-256 digest of a random
   connection secret. The configured single-host provisioner allowlists the
   stable supervisor ID and maximum capacity; request JSON cannot grant another
   identity or larger capacity.
7. PostgreSQL atomically creates the `provisioning` sandbox row and a bounded,
   expiring boot credential. An idempotent retry of the exact request returns the
   same result; changed reuse of any boot, sandbox, or credential ID is rejected.
   Provisioning revokes prior credentials for the same logical supervisor but
   does not release its sandbox or assignments.
8. The WebSocket bearer format is `<credential-id>.<secret>`. A production
   authorizer validates syntax, loads one unexpired/unrevoked credential by ID,
   hashes the supplied secret, compares fixed-length digests in constant time,
   and returns the stored boot identity. Plaintext per-boot connection secrets
   are never stored by the control plane.
9. The public `/v1` API uses a separate single-user bearer secret read from a
   file. Internal enrollment, owner, and Supervisor credentials are not accepted
   by the public API. Liveness endpoints contain no dependency or secret detail;
   readiness is available to the private deployment network.

### Owner and assignment management

10. The trusted host exposes a bounded JSON management protocol for exact-boot
    stop and assignment list/terminate/absence operations. It authenticates a
    distinct management bearer secret, validates every identity, and returns only
    closed safe error codes. The route is not published by the production
    ingress.
11. The control plane uses a fixed, operator-configured host management URL and
    secret. It never follows redirects and never accepts an owner URL from a
    provisioning request or database row. This prevents the retirement queue
    from becoming an SSRF mechanism. Plain HTTP requires an explicit private-
    network opt-in; HTTPS is the default outside the bundled isolated Compose
    network.
12. The HTTP assignment adapter preserves the existing
    `SandboxAssignmentInventory` contract. The host itself uses
    `DockerSandboxAssignmentInventory`, including exact labels and re-inspection
    immediately before removal. Unknown, changed, or missing authority fails
    closed.

### Storage, health, and deployment

13. The Supervisor host composes `DockerSandboxTurnRunner`,
    `LocalSandboxSupervisor`, `FileSupervisorEventSpool`,
    `PostgresSandboxCheckpointStore`, and `S3CheckpointObjectStore`. The spool
    and boot ledger use separate private persistent-volume roots. Within the
    spool volume, each boot has separate active and permanent-quarantine roots as
    specified by ADR-0024. PostgreSQL remains checkpoint metadata authority and
    S3-compatible storage remains byte authority. The bundled MinIO bootstrap
    creates a distinct checkpoint application identity limited to bucket
    location/list and object get/put for the configured bucket; MinIO root
    credentials stay out of the Supervisor and the application policy has no
    delete action.
14. Liveness means the process event loop and management server are alive.
    Control-plane readiness requires a successful database probe, initialized
    schema/bootstrap rows, and a running remote worker runtime. Supervisor-host
    readiness additionally requires a successful Docker probe, object-store
    probe, provisioned current boot, completed spool recovery, and registered
    WebSocket. Readiness turns false before graceful drain.
15. Configuration is parsed once and fails fast with bounded safe messages.
    Long-lived bearer values, database passwords, and S3 credentials are read
    from mounted secret files or standard SDK credential providers, never CLI
    arguments. Logs expose component, state, safe code, and opaque IDs only.
16. The supported self-hosted deployment contains persistent PostgreSQL and
    S3-compatible object storage, an explicit migration/bootstrap job, one
    control-plane replica, one trusted Supervisor host, the isolated Pi worker
    image, and an ingress/static Web UI service. Only ingress publishes host
    ports; `/internal/*`, PostgreSQL, object storage, Docker ownership, and host
    management stay on private networks.
17. Shutdown order is observable and idempotent. Ingress stops routing new work;
    the control plane drains claims and sockets before closing its database; the
    Supervisor advertises drain, closes reconnect, revokes assignments, confirms
    Docker absence where possible, and then closes storage/database clients.
18. Images are version-pinned, run non-root where their duties allow, have
    read-only roots and bounded tmpfs/resources, use health checks, and persist
    only declared volumes. The trusted Supervisor host may receive the Docker
    socket in this Docker-only topology; that makes it root-equivalent to the
    Docker host and is documented as a deliberate trusted-computing-base tradeoff.
    The socket is never propagated to a Pi worker.

## Executable acceptance criteria

The production slice is complete only when one clean-checkout command can:

1. create secret files, build pinned images, migrate and bootstrap PostgreSQL,
   create the checkpoint bucket, and start the private topology;
2. prove unauthenticated public and internal calls are rejected while liveness
   reveals no secret;
3. observe control-plane and Supervisor readiness and one provisioned, active
   fresh boot;
4. submit the supported Java repair through the authenticated public API, stream
   its durable events, verify its settled checkpoint in PostgreSQL/S3, submit a
   follow-up, and prove the second fresh container sees prior conversation and
   workspace state;
5. cancel an active turn and prove its exact one-shot container is absent;
6. interrupt the Supervisor connection and prove same-process reconnect drains,
   permanently quarantines the exact stale event suffix, and resumes future
   capacity without replaying an ambiguous committed command;
7. restart the Supervisor host and prove a different boot/sandbox identity is
   provisioned, the old boot is fenced, exact-labelled old assignments are
   reconciled, and a later turn restores from S3;
8. restart the control plane and prove persisted intake/events/checkpoints remain
   usable;
9. finish with no managed one-shot containers, no secrets in inspected worker
   environment/arguments/events, and all health checks passing;
10. run formatting, build, typecheck, unit/contract tests, dependency audit, and
    the production deployment test from documented commands.

## Consequences

- A process generation, not a conversation, owns a Supervisor connection and a
  bounded set of asynchronous lanes. Cold sessions still consume no process,
  thread, socket, timer, or Pi runtime.
- The control plane can safely retire a disconnected boot without direct Docker
  access, while the trusted host remains the only Docker owner.
- A complete self-hosted deployment now has more explicit secrets and lifecycle
  state, but each secret has one purpose and a narrow process boundary.
- A host that is unreachable cannot provide owner proof. Retirement remains
  pending and capacity quarantined until that host (or a new process with its
  persisted ledger) can confirm the generation; availability never overrides
  writer safety.
- Docker Compose demonstrates the supported single-host topology. Kubernetes
  requires a different exclusive-host identity/owner implementation and is not
  implied by this ADR.
- ADR-0024 refines reconnect recovery: a current socket can receive one exact
  permanent `stale_fence` delivery rejection and quarantine that immutable copy
  without restarting the healthy process. It does not weaken any owner, lease,
  fencing, or persist-before-ACK rule in this ADR.
- “Production deployable” describes operational completeness of the currently
  supported deterministic slice. It does not imply generic repositories, real
  provider credentials, arbitrary Pi extensions, multi-tenancy, or internet-
  facing hardening beyond the documented topology.

## Rejected alternatives

### Reuse a static boot ID from environment variables

A restarted process has lost its assignment map and cannot honestly resume the
old generation. A healthy same-boot heartbeat would strand acknowledged work
instead of triggering retirement.

### Accept assignments immediately after WebSocket registration

Pending event files may contain the durable suffix needed to close a turn.
Starting another command before replay can create sequence conflicts and hide a
recoverable result.

### Treat socket close as owner-stop proof

The tool or Docker worker can continue after the transport disappears. Releasing
the lease at that point permits concurrent writers.

### Mount the Docker socket in the control plane or Pi worker

The control plane does not need host-root authority, and a Pi/tool process is
untrusted. A dedicated trusted host keeps that capability out of both paths.

### Store a reusable Supervisor bearer token in an environment variable

It would bind process restarts to one credential and increases accidental
exposure through process/container inspection. Enrollment is long-lived and
file-backed; connection credentials are random, per boot, memory-only, and
stored server-side only as digests.

### Call the deterministic sample a generic production coding agent

The current worker has a closed fixture and fake model runtime. Renaming it would
conceal missing repository import, extension policy, and request-scoped provider
gateway work rather than completing it.
