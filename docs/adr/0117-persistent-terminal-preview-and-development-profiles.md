# ADR-0117: Persistent terminal handoff, private preview and development profiles

## Status

Accepted.

## Context

The first development-environment UI allocated one fixed Cube template. The
conversation terminal also destroyed an idle warm Cube before opening a second
terminal-only VM. That preserved the single-writer rule but violated the user
meaning of a persistent sandbox: background processes and `$HOME` disappeared
merely because the owner opened a terminal.

CubeProxy already routes HTTP services by Sandbox ID and port and issues a
per-Sandbox traffic token when public traffic is disabled. Cube does not expose
a tenant-safe raw SSH endpoint for ordinary Sandboxes.

## Decision

- An idle persistent conversation Cube is rebound to a short-lived human
  terminal authority, not replaced. The previous Agent capability stays
  revoked. Closing the PTY snapshots the boundary, returns the same physical VM
  to the persistent warm pool and preserves background processes.
- Every Agent-to-warm, warm-to-terminal and terminal-to-warm handoff advances
  the Session fence. A sealed Tool Service `/rekey` rotates Broker authority
  without starting a Tool Worker or killing user processes. Old Supervisor
  cleanup requests therefore fail identity validation instead of deleting the
  current warm VM.
- Broker-owned warm runtimes are excluded from Supervisor assignment inventory.
  Terminal-Run orphan cleanup measures its grace period from durable settlement,
  avoiding a race with normal checkpoint/release.
- A Workspace still has one writer. New Agent Runs remain queued while the
  terminal owns the Cube.
- Browser previews use a PiCloud-authenticated path. Control Plane verifies the
  tenant/user target, Tool Broker resolves the live handle, and the Cube
  provider injects the private Cube traffic token. Neither CubeAPI credentials,
  Sandbox IDs nor traffic tokens reach the browser.
- Preview supports bounded HTTP bodies and response sizes. WebSocket ingress and
  raw TCP are separate future contracts. Cube allows three custom exposed ports;
  the Tool Service consumes one, so only application ports 3000 and 8000 are
  accepted. The product does not call the Web terminal "SSH".
- User-owned development environments select one deployment-owned profile:
  starter (1 vCPU/2 GiB/8 GiB), standard (2 vCPU/4 GiB/16 GiB), or performance
  (4 vCPU/8 GiB/32 GiB). Each profile maps to an immutable Cube template built
  from the same trusted tool image. The user cannot supply a template ID or
  arbitrary VM resources.
- The development-environment page is an independent product route and remains
  available when no Agent Run is active. A running environment can also be
  opened from its Workspace panel in chat.

## Consequences

Persistent conversations now preserve a process world across Agent Turns and
owner terminal reconnects, but not across Tool Broker/Cube loss. Persistent
Workspace bytes remain the stronger durability boundary.

PiCloud's public HTTP binding remains loopback by default. Operators may bind it
to a LAN address or publish it behind an authenticated TLS reverse proxy. Cube
management endpoints remain private in either mode.
