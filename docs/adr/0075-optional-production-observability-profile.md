# ADR-0075: Optional production observability profile

## Status

Accepted.

## Context

The single-node production topology started Prometheus, Jaeger, Grafana, a
loopback observability ingress and a volume bootstrap on every deployment.
Those services are useful for diagnosis and acceptance evidence, but none of
them is required to accept a message, schedule a Run, execute Pi, call a model,
run a Tool in Cube or persist a Workspace.

Starting the complete dashboard stack by default increased memory use and
made a product demonstration look like it required twenty services. Core
services also had a hard-coded Jaeger endpoint even though tracing export is a
best-effort concern.

## Decision

1. The default production topology starts the fifteen services required by the
   product and Cube execution path.
2. The five local observability services use the Compose `observability`
   profile.
3. `production:up:observability` and
   `production:config:observability` enable the profile explicitly.
4. Core services expose their authenticated metrics endpoints in both modes.
5. OTLP export is disabled in the core profile. Enabling the observability
   profile selects the local Jaeger collector unless an explicit external
   endpoint overrides it.
6. Lifecycle teardown commands enable the optional profile so a previously
   started observability stack is not orphaned.

No metrics, tracing, dashboard or acceptance capability is deleted. This
decision changes the default deployment composition, not the service
contracts.

## Consequences

- A normal local deployment uses fewer resident processes and less memory.
- Product readiness no longer depends on a tracing backend.
- Operators who need dashboards must select the profile explicitly.
- External OTLP collectors remain supported without starting local Jaeger.
