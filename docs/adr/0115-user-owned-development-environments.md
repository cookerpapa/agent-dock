# ADR-0115: User-owned exclusive development environments

Status: accepted

## Context

CubeSandbox's cluster WebUI is an operator console: it exposes the fleet,
templates, nodes and every Sandbox. PiCloud needs a tenant-aware product
surface where an ordinary user can request one isolated Linux environment and
see only environments they own. Giving browsers Cube credentials or filtering
the Cube inventory in frontend code would not establish an authorization
boundary.

The existing Workspace terminal creates a short-lived Cube for one WebSocket
and destroys it on disconnect. Persistent Agent retention keeps a Run-created
Cube warm, but it is still owned through Run/Attempt authority. Neither is a
user-owned development-environment lifecycle.

## Decision

- Add a PiCloud `DevelopmentEnvironment` resource owned by
  `(tenant_id, owner_user_id)` and bound to exactly one user Workspace.
- PostgreSQL owns the product allocation, idempotency and user visibility.
  Cube owns the live process/memory state; the persistent Workspace Volume
  remains the sole file-byte authority.
- Only Tool Broker may call CubeAPI. The browser uses authenticated PiCloud
  REST and WebSocket endpoints and never receives Cube IDs, traffic tokens or
  control credentials.
- A live allocation has one Cube KVM and one Workspace writer. Ordinary Agent
  Runs for that Workspace remain queued while the exclusive environment is
  provisioning, running, paused or being released. The first release does not
  pretend that a separately fenced Agent Run can safely share the same live
  process world.
- Support explicit `start`, `pause`, `resume` and `release` operations. Pause
  uses Cube's memory/filesystem snapshot lifecycle; resume reconnects the same
  Sandbox identity. Release destroys the VM but preserves the Workspace
  Volume.
- The environment terminal opens a PTY inside the existing KVM. Disconnecting
  kills only that PTY; it does not release the environment.
- One Workspace has at most one live development environment. Tenant and
  Sandbox-Domain capacity accounting includes these environments.
- Tool Broker ownership remains leased. If the owning Broker disappears,
  another Broker fences the stale owner, destroys any ambiguous runtime and
  marks the environment `failed`. The user may start it again on a fresh Cube;
  files survive but PiCloud does not claim process-state recovery across a
  Tool Broker failure.
- Environment templates, resource limits, networking and UID remain
  deployment-owned. Users choose a Workspace, not an arbitrary image, PodSpec
  or privileged runtime policy.

## Consequences

- From the user's perspective the environment behaves like a small managed
  development VM: an independent kernel, persistent files, long-lived
  processes, pause/resume and an interactive terminal.
- It is intentionally not SSH infrastructure, a general cloud-instance API or
  a second Workspace authority.
- A later ADR may define a safe Agent-to-development-environment handoff. Until
  then, explicit exclusivity is safer and easier to explain than silently
  running an Agent in a second Cube against the same Volume.
