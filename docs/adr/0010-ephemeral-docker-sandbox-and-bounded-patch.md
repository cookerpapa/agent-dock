# ADR-0010: Ephemeral Docker sandbox activation and bounded final patch

- Status: Accepted
- Date: 2026-07-19

## Context

The durable Phase 1 path currently starts pinned Pi as a local child process and
resolves a temporary host directory as its workspace. That proves command,
lease, event, SSE, and cancellation semantics, but it does not prove the main
security boundary of a cloud coding agent: model-directed tools and project code
must not execute in the NestJS control-plane process or its host workspace.

The Phase 0 Compose services already prove several Docker `HostConfig` controls,
but they are one-shot zero-token probes with no writable project workspace and
no model/tool loop. Reusing their result as evidence for coding execution would
therefore be misleading.

A real provider connection introduces a separate credential and egress design.
Giving an untrusted tool process a long-lived provider token, arbitrary outbound
network, the Docker socket, or a host bind mount would invalidate the sandbox
claim. The first executable workspace slice needs deterministic tool behavior
without crossing those still-open boundaries.

The user also needs a reviewable result. A full artifact service is not yet
implemented, but the sample repository produces a small Git patch. The public
event contract needs an honest bounded representation rather than relying on a
test process to inspect the container after the turn.

## Decision

1. A trusted Docker sandbox runner lives outside the agent container. It invokes
   the Docker CLI as a replaceable engine adapter; the sandbox never receives
   the Docker socket or another host-control capability.
2. The first activation model is one ephemeral container per active turn. The
   container starts only after the existing durable command ACK transaction.
   Cold and queued sessions still consume no process, thread, or container. Warm
   reuse and workspace/session restoration require later snapshot and
   reconciliation work rather than being inferred from this slice.
3. The container runs as UID/GID `1000:1000` with a read-only root filesystem,
   private PID/IPC namespaces, all Linux capabilities dropped,
   `no-new-privileges`, bounded CPU/memory/PIDs/file descriptors, no devices,
   no published ports, and no host bind mounts. `/tmp` and `/workspace` are
   separately bounded tmpfs mounts; the workspace mount is owned by the
   non-root runtime identity.
4. The acceptance path uses `network=none` and an embedded deterministic fake
   model inside the worker. The fake key is a fixed valueless test constant. No
   subscription login or real provider credential enters container config,
   logs, events, or the workspace. A real model later requires an explicitly
   designed, policy-controlled gateway/identity boundary; this slice does not
   weaken network isolation to reach the host.
5. The image contains a trusted minimal Java repair fixture. At activation the
   non-root worker copies it from the read-only image into the isolated tmpfs
   workspace and creates the baseline Git commit. Generic repository import and
   durable workspace restore remain later object-storage operations; no user or
   home directory is bind-mounted for this proof.
6. Pinned Pi `0.80.10` and its built-in `bash` and `edit` tools run inside the
   container. The fake model deterministically asks Pi to run a failing Java
   test, replace the defect, and rerun the test. Raw Pi RPC remains private to
   the in-container adapter; only AgentDock wire events leave the sandbox.
7. Host and worker communicate over the attached container's LF-delimited JSONL
   stdin/stdout. The private transport is versioned and closed. The worker emits
   one `event.publish` at a time and waits for the existing durable `event.ack`
   before continuing, preserving the PostgreSQL commit-before-ACK invariant.
   Runtime configuration is sent through stdin, never Docker arguments or
   inspectable container environment.
8. `turn.completed` may carry an optional `workspacePatch` containing a unified
   Git diff, its format, and a truncation flag. The UTF-8 patch is bounded to
   64 KiB before public event validation and is collected inside the sandbox
   immediately before the terminal event is published. Larger/binary artifacts
   will move to object storage and an artifact reference in a later slice.
9. Cancellation is forwarded to the worker's `AbortSignal`. The in-container Pi
   runner first uses native RPC abort and its POSIX process-group escalation.
   The outer runner additionally requires the Docker process/container to exit;
   after a bounded grace period it stops and force-removes only the exact
   generated container name. A cancelled result is not returned before that
   containment boundary is gone.
10. Every sandbox receives AgentDock labels containing only opaque
    command/session identity. Normal completion removes the `--rm` container.
    The runner also performs idempotent exact-name cleanup. Host crash recovery,
    orphan reconciliation, and durable workspace recovery remain explicit later
    work.
11. This implementation plugs into the existing in-process supervisor adapter
    for an end-to-end integration test. It proves that Pi/tools/workspace are
    outside NestJS, but it is not yet the production remote supervisor transport
    and does not auto-start from `main.ts`.

## Consequences

- The project gains executable evidence for a real isolation boundary rather
  than treating a local child process as cloud sandboxing.
- Tool events and the final patch traverse the same fenced, durable, resumable
  event path as text and terminal state.
- A malicious shell command is constrained to the disposable container and
  tmpfs workspace; it cannot control Docker or inspect a host bind mount.
- The test remains deterministic and zero-token, so CI can reproduce it on a
  Docker-capable runner.
- One active turn temporarily consumes one container and one Pi process. This is
  an activation strategy, not one permanent process per stored conversation.
- The embedded fake model is test infrastructure, not a production networking
  shortcut. Provider gateway, generic workspace import, snapshots, warm pooling,
  and orphan reconciliation remain necessary before deployment.

## Rejected alternatives

### Mount the host repository into the sandbox

A bind mount makes host filesystem ownership and path policy part of the attack
surface and does not model object-storage restoration. The first proof uses a
read-only image fixture copied into an isolated tmpfs workspace.

### Mount the Docker socket into a supervisor container

The Docker socket is effectively host-root control. The trusted manager remains
outside the untrusted sandbox and exposes no engine capability to Pi or tools.

### Give the sandbox ordinary internet access for the fake or real model

That would make the security test weaker than the existing Phase 0 probe and
would mix credential/egress work into the workspace slice. The deterministic
model stays inside the networkless test container; real egress needs a separate
gateway decision.

### Read `git diff` from the host test after container exit

An external assertion would prove only that the test harness saw a file. A
bounded patch on the durable terminal event makes the result part of the actual
user-facing contract and SSE replay history.

### Keep one container alive for every stored session

That recreates the resource-scaling problem AgentDock is intended to solve.
Ephemeral activation preserves the invariant that cold sessions consume no live
runtime; later snapshots and pooling may optimize latency without changing it.
