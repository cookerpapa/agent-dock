# ADR-0106: Brokered Workspace Web Terminal

## Status

Accepted on 2026-08-15.

## Context

AgentDock Workspaces are durable POSIX directories mounted into disposable
CubeSandbox KVM guests. Users can inspect committed files in the Web UI, but
cannot interactively inspect or operate the live Workspace without asking the
Agent to run a Tool. Exposing SSH or Cube's native data endpoint directly would
leak runtime identity and ingress credentials into the browser, bypass tenant
authorization, and allow a human shell to race an Agent Tool execution against
the same writable Workspace.

CubeSandbox v0.6.0 exposes an envd PTY API on port 49983, but AgentDock
intentionally removes envd from its Tool image. Re-enabling it would add a
second mutable command channel that does not enforce AgentDock's handoff secret
and fencing token. AgentDock's root-owned Cube Tool Service already owns the
authenticated private data-plane boundary and can allocate a guest PTY for an
unprivileged process.

## Decision

1. Add a Web Terminal to the Workspace inspector. The browser connects only to
   an authenticated Control Plane WebSocket. Cube IDs, traffic tokens and
   control-plane credentials never cross the trusted boundary.
2. The Control Plane resolves tenant, user, Session, Workspace, active project
   environment and current Workspace checkpoint server-side, then proxies a
   bounded terminal protocol to the Workspace's Tool Broker.
3. Human terminal authority is distinct from Agent Tool capability. A durable
   terminal lease is bound to tenant, user, Session and Workspace, has a short
   expiry with heartbeat, and is never placed in model context or the guest.
4. PostgreSQL serializes Workspace writers. An Agent activation cannot reserve
   a Workspace with a live terminal lease, and a terminal cannot open while an
   Agent activation is reserved, active, warm, cleaning or unknown. Unknown
   terminal ownership fails closed until a healthy Tool Broker destroys the
   orphaned Cube.
5. The Tool Broker lazily creates one Cube for an accepted terminal lease,
   mounts the existing persistent Workspace Volume, and opens `/bin/bash -i -l`
   as uid/gid 1000 in `/workspace`. Browser input and resize frames are bounded;
   output observes an explicit backpressure limit.
6. Closing or losing the browser connection kills the PTY and destroys the
   terminal Cube. Workspace bytes remain in the persistent Volume; processes,
   memory, sockets and PTY state do not. The terminal is therefore a remote
   development shell, not a promise of persistent virtual-machine state.
7. Extend the existing fenced Cube Tool Service with bounded PTY open, input,
   resize and close routes on private port 49984. Keep envd absent and do not
   expose runtime-native objects through the provider-neutral `SandboxProvider`
   handle.
8. Terminal keystrokes and output are not durably recorded. Audit state stores
   only identity, lifecycle and bounded failure metadata. This avoids creating
   a second conversation/event log containing secrets typed into a shell.
9. Port 22 is not exposed. A real SSH bastion may later reuse the same durable
   lease and broker contract, but it must not become a second execution path.

## Consequences

- a user can open an interactive terminal without pre-creating a Sandbox;
- terminal access reuses Cube's KVM, persistent Volume and network policy;
- humans and Agents cannot concurrently mutate one Workspace;
- a disconnected terminal loses running processes but not Workspace files;
- horizontal Control Plane and Tool Broker replicas remain stateless for live
  byte forwarding while PostgreSQL owns admission and orphan recovery;
- terminal output latency is independent of canonical conversation storage and
  does not add high-frequency PostgreSQL writes.

## Adopt-before-build evidence

The Tool Service uses `script(1)` from the immutable Cube image to allocate the
guest PTY and runs the login shell as UID/GID 1000. Every control request must
present the current activation handoff authority. Cube's upstream PTY API was
reviewed for behavior, but envd is deliberately not part of AgentDock's
production runtime boundary.
