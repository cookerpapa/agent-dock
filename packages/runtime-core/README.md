# AgentDock runtime core

`@agent-dock/runtime-core` contains execution semantics shared by the Control
Plane and trusted Pi Workers. It is not an HTTP API package and it does not own
NestJS controllers, browser authentication, deployment configuration or
Supervisor WebSocket transport.

## Owned boundaries

- exact-command Run and cancellation execution;
- RunAttempt, lease, fence and terminal-state transitions;
- Pi checkpoint manifests, object storage and bounded read cache;
- durable event ingestion and cross-replica notifications;
- conversation projection and terminal-event construction;
- model credential runtime and Temporal affinity metadata;
- immutable Review Bundle and structured test evidence primitives.

## Dependency direction

```text
control-plane ─┐
supervisor-host ├─> runtime-core ─> sandbox-supervisor
tests/tools ────┘                  └> domain/database/protocol
```

Runtime-neutral code belongs here only when at least two trusted runtime
components consume it or when moving it prevents a Worker from importing the
Control Plane product layer. REST controllers, tenant-facing services,
WebSocket channel code and production bootstrap stay in `control-plane`.

The package exposes explicit subpaths so consumers import one capability rather
than pulling a barrel that accidentally widens the dependency graph.
