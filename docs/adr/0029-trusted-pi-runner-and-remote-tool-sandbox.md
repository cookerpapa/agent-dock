# ADR-0029: Trusted Pi runner and remote tool sandbox

- Status: accepted
- Date: 2026-07-20
- Supersedes: ADR-0010's whole-Pi activation boundary and ADR-0027 section 9
- Extends: ADR-0023's trusted host topology and ADR-0027's model gateway

## Context

The production Supervisor currently starts Pi, its session state, its built-in
`bash`/`edit` tools, and the workspace in one hardened Docker container. This
protects the host from the combined runtime, but it does not protect the trusted
Pi agent loop from a prompt-controlled shell. Pi receives a turn-scoped model
gateway capability in its process environment and the built-in bash tool
inherits that environment. A shell command can therefore discover and spend
the capability, inspect Pi session files, or interfere with the Pi process.

Pi supports a second, upstream-compatible boundary: keep Pi and provider
authentication in a trusted process and replace its built-in local operations
with tools whose asynchronous operations execute in another sandbox. The
Gondolin example supplied with the pinned Pi package demonstrates this routing
for `read`, `write`, `edit`, and `bash` without forking Pi.

The production topology must also stop giving the credential-bearing Agent
Runner direct Docker authority. A Docker socket is effectively host-root
authority and belongs behind a small, closed management service.

## Decision

### Trust domains

1. The Control Plane remains authoritative for tenant/session/turn state,
   queues, leases, fencing, and event history. It has no Docker socket.
2. The Supervisor Host becomes the Trusted Agent Runner. It starts pinned Pi
   RPC, owns Pi JSONL, communicates with the Model Gateway, and holds only the
   current tool-sandbox capability needed by its fixed trusted extension. It
   has no Docker socket and no user workspace mounted into its filesystem.
3. A separate Sandbox Manager is the only application service with the Docker
   socket. The Agent Runner authenticates to its narrow internal HTTP API with a
   private service credential. The Manager accepts closed schemas rather than
   caller-controlled images, mounts, networks, capabilities, or raw Docker
   arguments.
4. Each active turn receives a disposable Untrusted Tool Sandbox. It contains
   the workspace, shell, Git, JDK, and other fixed toolchain components, but no
   Pi package, model endpoint, model capability, database/S3 credential,
   control-plane credential, Manager credential, or Docker socket. It always
   starts with Docker network mode `none`.

### Pi tool routing

5. Pi runs with built-in local tools disabled and automatic extension discovery
   disabled. One image-owned, explicitly selected trusted extension registers
   `read`, `write`, `edit`, and `bash` using Pi's public tool-operation APIs.
6. The trusted extension calls the Sandbox Manager with a random activation
   capability. It never forwards Pi's process environment to bash. In
   particular, the model gateway capability and Agent Runner credentials cannot
   become Tool Sandbox environment variables, request fields, Docker arguments,
   labels, files, or output.
7. Tool requests carry an activation ID, unique operation ID, operation kind,
   bounded arguments, and deadline. The Manager validates capability and
   activation state, then forwards a closed JSONL operation to the already
   attached Tool Sandbox worker. The worker returns bounded output and an exit
   code. Abort and timeout terminate the tool process group; turn cancellation
   additionally destroys and confirms absence of the complete container.
8. File operations accept only workspace-rooted paths. The Tool Sandbox rejects
   lexical escape and final-component links; the Manager never exposes host
   paths or volume identifiers through this API. All file and shell operations
   act on the same sandbox-owned workspace.

### Lifecycle and durability

9. A tool sandbox exists only for one active turn. The Trusted Agent Runner
   loads the immutable workspace seed and latest settled checkpoint, asks the
   Manager to create an activation, then starts Pi. At `agent_settled`, the
   Runner asks the Manager for a bounded workspace snapshot and Git patch,
   combines that snapshot with trusted Pi JSONL, and commits the existing fenced
   checkpoint before publishing `turn.completed`.
10. Completion, failure, cancellation, lease revocation, and Runner shutdown all
    revoke the activation capability and require exact-identity container
    absence. A cold session retains neither a Pi process nor a Tool Sandbox.
11. The existing assignment labels and reconciliation contract remain the
    authority after crashes. Inventory and termination are proxied through the
    Sandbox Manager; the Trusted Agent Runner no longer invokes Docker directly.
12. Public GitHub import remains a separate credential-free one-shot container,
    but its Docker lifecycle also moves behind the Sandbox Manager so the Agent
    Runner owns no Docker socket. Imported bytes still cross the existing
    bounded snapshot and S3 verification boundary.

### Network and extension policy

13. The Trusted Agent Runner joins the internal Model Gateway and Sandbox
    Control networks. The Sandbox Manager joins only Sandbox Control and owns the
    Docker socket. Tool Sandbox containers join no network. Provider egress,
    database, object storage, and Control Plane networks are unavailable to
    tools.
14. Offline toolchains and image-owned dependencies are the supported first
    boundary. A future dependency-download mode must use a separate allowlisted
    egress proxy; it may not attach Tool Sandboxes to Model Gateway or internal
    service networks.
15. Only the fixed image-owned routing extension executes in the Trusted Agent
    Runner. Project/user extensions remain disabled until a separate policy can
    run untrusted extension code without granting access to Pi/model
    credentials.

## Executable acceptance criteria

This decision is complete only when tests prove:

1. the production Agent Runner has no Docker socket, Docker CLI requirement, or
   user workspace mount, while the Sandbox Manager alone owns the socket;
2. Pi runs outside the Tool Sandbox with local built-in tools disabled and its
   fixed extension completes the deterministic `bash/edit/bash` repair loop;
3. `env`, `/proc/self/environ`, and filesystem scans inside bash cannot discover
   model, Manager, database, S3, Supervisor, or tenant credentials;
4. the Tool Sandbox uses `--network none`, cannot reach the Model Gateway or
   Control Plane, has no host binds/socket/ports/devices, and retains the
   existing non-root/read-only/capability/resource limits;
5. malformed capabilities, cross-activation requests, replayed operation IDs,
   escaping paths, oversized input/output, timeout, cancellation, and stale
   fencing identity fail closed;
6. settled Pi JSONL and workspace snapshots restore into a fresh Runner and a
   fresh Tool Sandbox for a same-session follow-up;
7. Supervisor retirement can list, terminate, and confirm absence through the
   Manager without Docker authority in the Runner; and
8. deterministic and explicit live-model production checks complete with no
   model capability appearing in tool environment, events, patch, checkpoint,
   Docker configuration, or logs.

## Consequences

- A prompt-controlled shell is now outside the model-authentication and Pi
  session boundary. A Tool Sandbox compromise is constrained to the current
  disposable workspace and fixed offline tool image.
- The Sandbox Manager becomes a small but critical trusted-computing-base
  component. Compromise of it is equivalent to Docker-host compromise, so its
  API and deployment surface must remain narrow and private.
- Pi upgrades remain contract-tested against public RPC and tool-operation
  interfaces rather than a fork. A breaking upstream tool API change fails the
  pinned build/tests before deployment.
- Docker remains a shared-kernel MVP boundary for private/self-hosted use.
  Firecracker, Kata, gVisor, Gondolin, or a managed backend can later implement
  the same Manager contract without changing Pi or the Control Plane.

## Rejected alternatives

### Keep Pi and bash together but shorten the gateway capability

Expiry and request limits reduce cost exposure but do not create a credential
boundary. Bash can still spend the current capability and inspect Pi state.

### Mount the Docker socket into the Agent Runner

That combines provider/session authority with host-root container authority and
turns a Runner code-execution flaw into a host compromise.

### Parse or allowlist shell command text in the Agent Runner

Shell parsing is not an isolation boundary and would break normal coding-agent
workloads. Commands remain arbitrary inside a resource- and network-constrained
Tool Sandbox.

### Fork Pi to replace its tool loop

Pi already exposes explicit extension and pluggable operation APIs. A fork would
increase upgrade cost without improving the boundary.
