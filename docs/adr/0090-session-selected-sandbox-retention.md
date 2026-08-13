# ADR-0090: Session-selected Sandbox retention

- Status: Accepted
- Date: 2026-08-10
- Refines: ADR-0068

## Context

ADR-0068 keeps an eligible Cube process world warm for fifteen idle minutes.
That is appropriate for ordinary conversations, but it cannot represent a
developer environment whose server, watcher or database should remain running
while the user changes focus for longer than the warm-cache window.

A browser-only switch would be misleading. The choice must be durable business
state and must reach the Sandbox release boundary of every Run.

## Decision

Every Session stores one immutable `sandbox_retention_policy`:

- `ephemeral` uses the existing bounded warm lifecycle. A successful Tool Run
  may reuse its Cube during the fifteen-minute idle window, but TTL and LRU
  admission may reclaim it.
- `persistent` remains lazy: pure chat creates no Cube. After the first
  successful Tool Run, its exact-Session Cube is retained across Runs and is
  excluded from idle-TTL and ordinary warm-LRU eviction.

A persistent Cube still rotates Tool capability, Attempt ownership and fencing
at every Run boundary. Keeping user processes alive never keeps an old Worker
authorized to execute another command.

One persistent Session requires an otherwise unused Workspace. While it is
live, another conversation cannot be created on that Workspace, and an
archived persistent Session cannot be unarchived after another conversation
has claimed the Workspace. This preserves the existing invariant that one
Workspace has at most one live process world and avoids hidden cross-transcript
process state.

Archiving/deleting the Session makes its warm activation retired. The owning
Sandbox Manager discovers this from PostgreSQL and stops the Cube; creation
also performs the retired-activation reconciliation so the Workspace can be
reused without waiting for the periodic reaper.

`persistent` is a runtime-retention policy, not a claim of VM-state durability.
Cancellation, ambiguous Tool completion, failed checkpoint, environment or
Workspace revision mismatch, Manager shutdown, Cube/node failure and operator
cleanup may destroy the Cube. The persistent POSIX Workspace and Pi-native
Session remain recoverable, and the existing reset harness makes the changed
execution world visible to the model. Process memory, sockets and PTYs are not
restored after those failures.

The policy does not add SSH access or an externally reachable Preview ingress.
Those require separate authentication, network and lifecycle decisions.

## Consequences

- Users can select ordinary auto-reclaim or a long-running development
  environment when creating a conversation.
- Persistent Cubes consume admission capacity while idle. Once capacity is
  pinned, later Tool activations wait rather than evicting them.
- The choice is visible in conversation resources and is frozen into every Run
  command before it reaches a Pi Worker.
- Workspace files remain durable independently of either retention policy.

## Acceptance

1. The create-session API, conversation reads and browser all preserve the
   selected policy.
2. A persistent activation survives idle-TTL reaping and exact-Session rebind
   reuses the same physical Cube.
3. Ordinary warm LRU and another Session cannot displace it.
4. Archiving its conversation releases the retained activation.
5. An ephemeral Session retains the existing lazy activation and bounded warm
   behavior.
