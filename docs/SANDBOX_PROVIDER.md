# Sandbox Provider

## Supported runtime

The production Tool Broker supports one runtime:

```text
CubeSandboxProvider
  → Cube API
  → CubeMaster / Cubelet
  → CubeShim / KVM microVM
```

CubeSandbox is selected by construction. There is no production runtime
selector and no fallback implementation to misconfigure.

## Contract

The trusted Manager owns a provider-neutral lifecycle contract:

```ts
interface SandboxProvider {
  checkHealth(): Promise<void>;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  retainForWarm?(handle: SandboxHandle): Promise<SandboxHandle>;
  rebind(handle: SandboxHandle, assignment: ToolSandboxAssignment): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, request: ToolRequest, signal?: AbortSignal): Promise<ToolResult>;
  readFile(handle: SandboxHandle, input: ReadInput, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(handle: SandboxHandle, input: WriteInput, signal?: AbortSignal): Promise<void>;
  snapshot(handle: SandboxHandle, requestId: string): Promise<CaptureResult>;
  inspect(handle: SandboxHandle): Promise<SandboxInspection>;
  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  close(): Promise<void>;
}
```

Native Cube SDK objects never cross into the Pi Worker.

## Identity

Every activation binds:

- tenant;
- Project and Workspace;
- Session and Turn;
- RunAttempt;
- Supervisor boot;
- command, lease and fencing token;
- environment image/specification hash;
- frozen logical Turn digest, current Attempt digest and current per-sampling
  Step digest.

The Manager derives runtime identity. The model, browser and Pi Tool arguments
cannot supply a runtime ID or weaken policy.

## Lifecycle

```text
logical Tool reservation
  → no microVM yet
first Tool call
  → create/restore Cube activation
subsequent Tool calls
  → reuse exact active activation
Run boundary
  → revoke old Tool capability
  → checkpoint dirty Workspace
  → retain eligible activation as IDLE_WARM
idle expiry/failure
  → destroy activation
future Tool call
  → restore into a fresh activation
```

Pure chat has no Sandbox lifecycle.

## Fixed policy

The template and Manager enforce:

- KVM microVM boundary;
- non-platform user identity;
- no host mount or runtime socket;
- no platform/model/object-store/database credentials;
- bounded CPU, memory, processes, open files, disk, output and time;
- public HTTP/HTTPS through the trusted proxy;
- denial of private, loopback, link-local, metadata and platform networks;
- exact cleanup and orphan reconciliation.

## Tool surface

Pi receives ordinary Tools such as:

```text
read
write
edit
bash
git
tests
```

The Tool adapter converts each call into an authenticated Manager request
containing the server-owned activation binding, frozen Step digest and unique
operation ID. Identical reconnects attach to one bounded execution ledger;
conflicting reuse fails closed. Lazy activation, proxy configuration and Cube
lifecycle remain invisible to Pi.

## Persistent Workspace Volume

The microVM root/process world is not durable. The Workspace's stable Cube
Volume is. The trusted Volume gateway flushes the Volume and captures a bounded
identity/file/hash/Git reference; PostgreSQL advances the Workspace revision
only through base-revision CAS under the current fence. No per-Run archive copy
is created.

## Acceptance

Automated and live checks cover:

- runtime/guest identity;
- credential absence;
- cross-tenant file isolation;
- private/platform network denial;
- public proxy egress;
- path traversal and symlink escape;
- output and timeout bounds;
- cancellation/process cleanup;
- Workspace restore;
- multi-round Pi state;
- zero residual runtimes after destruction.

Historical runtime implementations are retained only in immutable ADR/research
history, not as executable providers.

## Template lifecycle

Tool templates are immutable and tied to a committed AgentDock revision. The
registration path keeps the selected template plus a bounded READY rollback
window and asks CubeMaster to delete only superseded AgentDock templates.
PENDING builds and templates outside the AgentDock registry namespace are not
eligible. This lifecycle policy is separate from Workspace checkpoints: pruning
a reproducible Tool image cannot delete a tenant's Pi Session or Workspace.
