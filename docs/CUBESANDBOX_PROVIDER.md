# CubeSandbox execution provider

## Current role

CubeSandbox KVM is Pi Cloud's only untrusted Tool runtime. The trusted Pi
Worker owns the Agent Loop and model credential; the Tool Broker owns execution
admission and Cube lifecycle. The guest owns neither.

```text
Pi Tool call
  -> trusted Tool adapter
  -> Tool Broker (Run/Attempt/lease/fence/Step validation)
  -> Cube API
  -> credential-free Cube KVM Tool service
  -> bounded result
  -> Pi Agent Loop
```

There is no Docker, gVisor, local-process or model-selectable runtime fallback.
The `SandboxProvider` interface in code is a narrow Cube adapter boundary, not
a supported production runtime menu.

## Identity and authority

The Tool Broker derives tenant, Workspace, Session, Run, Attempt, fence,
activation and Cloud Step identity from trusted state. The browser, model and
Tool arguments cannot choose a Sandbox ID, image, mount, resource limit or
network policy.

Each operation has an immutable operation ID. A reconnect may attach to the
same in-flight operation, but conflicting reuse fails closed. A stale Attempt
cannot start another Tool or advance Workspace state. If a side-effecting Tool
may have run but its result cannot be proven, the outcome is `UNKNOWN`; it is
not replayed automatically.

The Worker never receives Cube management credentials. Cube receives no model,
PostgreSQL, Kafka, Valkey, Kubernetes, Volume-gateway or Cube-control
credential.

## Workspace and process lifetime

One tenant Workspace maps to one stable persistent Cube Volume. Only the
`workspace/` child of its trusted Volume envelope is mounted into the guest as
`/workspace`; platform generation and Git-baseline metadata stay outside the
guest view.

At a fenced settlement boundary, the trusted Volume gateway flushes the
Workspace and records a bounded file/hash/Git revision. PostgreSQL advances the
Workspace revision with compare-and-swap. This operation does not create a
second archive of all Workspace bytes.

A Cube activation may remain warm according to the Session retention policy.
Its processes, sockets and PTYs survive only while that exact activation
survives. After destruction or failure, a new KVM reattaches the same Volume and
recovers files, not RAM or process state. Warm retention is an optimization,
never a conversation or Workspace durability dependency.

## Tool and terminal channels

Agent file and shell Tools use the authenticated private Tool service. The Web
Terminal uses a separate short-lived human authority through the same Tool
Broker and guest service:

```text
authenticated browser WebSocket
  -> Control Plane
  -> Tool Broker
  -> Cube Tool service
  -> unprivileged PTY in /workspace
```

A human terminal and an Agent Run cannot write the same Workspace at the same
time. There is no public SSH port and no second `envd` command channel.

## Network policy

The guest has no route to platform services. Optional public HTTP/HTTPS egress
crosses a deployment-owned proxy that resolves targets and rejects loopback,
private, link-local, metadata, Kubernetes and platform destinations. Proxy
configuration grants public dependency access, not trusted-network access.

## Template and resource policy

The deployment-owned immutable template supplies the fixed non-root user,
language toolchain and private Tool service. Users cannot submit a template,
kernel, device, host mount, privileged flag or network policy. Cube and the
Tool service enforce bounded CPU, memory, process count, open files, output and
execution time.

Template retention deletes only superseded Pi Cloud templates after proving no
active Sandbox references them. It does not touch tenant Workspace Volumes or
Pi Session records.

## Reconciliation and evidence

PostgreSQL records desired activation identity and fenced ownership. Tool
Broker periodically reconciles that state with Cube inventory. Destruction is
qualified by both logical activation and physical runtime identity, so an old
cleanup request cannot delete a newer KVM.

Verification includes:

```bash
npm run cubesandbox:template-check
npm run cubesandbox:live-check
npm run production:check
```

The live gate is required for claims about guest identity, credentials,
cross-tenant file isolation, private-network denial, public proxy behavior,
timeout/cancellation, persistent Volume reattachment and orphan cleanup. The
one-host profile still shares one physical host and does not claim host or Cube
administrator compromise tolerance.
