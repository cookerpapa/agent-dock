# ADR-0030: Pluggable sandbox provider boundary

Concrete runtime update: ADR-0038 retains this provider-neutral Manager
boundary but removes the ordinary-Docker implementation and runtime selector
described historically below. The product now has one gVisor/KVM Provider.

- Status: accepted
- Date: 2026-07-20
- Extends: ADR-0029

## Context

ADR-0029 separated trusted Pi execution from untrusted tools, but its first
implementation placed activation capabilities, worker RPC, and Docker lifecycle
inside one `DockerToolSandboxManager` class. The HTTP boundary was narrow, yet a
second runtime such as gVisor or a managed microVM would have to copy Manager
authorization and lifecycle logic or change the Pi Runner contract.

The supported deployment still uses Docker. This decision introduces an
internal provider seam without claiming that an untested provider works.

## Decision

### Manager and provider responsibilities

1. `ToolSandboxManager` owns activation IDs, one-time capability generation and
   digest storage, capability revocation, request/assignment authorization, and
   the stable HTTP-facing Manager contract.
2. `SandboxProvider` owns runtime creation, operation transport, snapshotting,
   inspection, stop/destroy, orphan inventory, exact removal confirmation, and
   controlled repository import. It never receives the Manager service token or
   per-activation bearer capability.
3. The first implementation is `DockerSandboxProvider`. Provider handles expose
   only opaque runtime identity and AgentDock metadata; they never expose Docker
   client objects, sockets, host paths, or arbitrary runtime arguments to the
   Runner.
4. The Provider is selected from a closed deployment configuration. An unknown
   provider fails startup. Future `docker_gvisor` and managed-microVM providers
   must implement and pass the same contract before they can be selected or
   documented as supported.

### Identity and policy

5. Every handle is immutable and bound to provider, activation, tenant,
   session, turn, and attempt identity plus the complete existing
   supervisor/boot/sandbox/command/lease/fence assignment. ADR-0031 replaced the
   initial lease-as-attempt alias with independent durable `Run` and
   `RunAttempt` UUIDs without changing the provider contract.
6. The Manager chooses a versioned `SandboxPolicy`; callers cannot submit
   images, mounts, runtime classes, networks, resource limits, or host paths.
7. Network policy is a closed union with `deny_all`, GitHub import, package
   registry, and explicit-host shapes. Docker Tool Sandboxes implement only
   `deny_all`. Unsupported policies fail closed rather than attaching a sandbox
   to an internal platform network.
8. The default Tool policy fixes CPU, memory, PID, file-descriptor, workspace,
   temporary-storage, command-output, command-timeout, and turn-time limits.
   Effective Docker inspection and integration tests are evidence that the
   configured boundary reached the runtime.

### Lifecycle semantics

9. `create` returns a provider-neutral handle only after the worker is ready and
   its runtime identity is inspected. `exec`, `readFile`, `writeFile`, and
   `snapshot` require that exact handle.
10. `stop` requests graceful worker shutdown but still confirms runtime absence.
    `destroy` is the forceful idempotent cleanup primitive. Completion, failure,
    cancellation, timeout, Manager shutdown, and orphan reconciliation all end
    at confirmed absence.
11. Manager capabilities are zeroed before provider teardown begins. A Provider
    error cannot make an old capability valid again.
12. Provider inspection returns a closed, provider-neutral summary used by
    security tests and operations. Raw Docker inspection JSON remains inside the
    Docker implementation.

## Consequences

- Pi and the Control Plane continue to depend only on the existing Manager RPC;
  adding a provider does not change Agent Loop code or public APIs.
- Authorization is implemented once above all providers.
- Docker remains the only supported Tool Sandbox provider and the production
  claim remains private/single-host/shared-kernel.
- gVisor can later reuse the Docker image and OCI lifecycle with a different
  runtime class, but compatibility and performance require separate tests.
- A managed provider may have different runtime IDs and persistence behavior;
  the opaque handle and explicit inspection contract accommodate that without
  leaking its SDK into trusted Runner code.

## Rejected alternatives

### Treat the existing Docker Manager class as the provider interface

That would force every provider to reimplement capability authentication and
would make provider replacement affect the trusted RPC boundary.

### Put provider selection in each Run request

That would let untrusted or tenant-controlled input choose a weaker runtime.
Provider selection remains deployment policy until a separately authorized
tenant policy exists.

### Advertise gVisor or Vercel before an executable integration exists

An interface is not compatibility evidence. These remain planned providers,
not supported providers.
