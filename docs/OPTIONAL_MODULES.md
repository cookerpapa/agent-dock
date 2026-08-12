# Optional deployment modules

AgentDock's default deployment is the shortest production path required for
the conversation product:

```text
Web → Control Plane → Temporal → Pi Worker → Tool Broker → Cube
                    ↘ PostgreSQL / object storage
```

The default Control Plane exposes authentication, model/proxy settings,
projects, conversations, Workspaces, Runs, cancellation, steer and durable SSE.
It does not instantiate research-only services.

## Advanced research API

Set this only for a private research deployment:

```bash
AGENT_DOCK_ADVANCED_MODULES_ENABLED=true
```

This registers:

- Candidate Race orchestration and promotion;
- Attempt rewind and immutable Review Bundles;
- model governance, usage and Session context inspection;
- Project Environment history/validation;
- operational summary and audit data APIs.

The module reuses the same tenant boundary, PostgreSQL state, Temporal
execution and Cube isolation. Disabling it removes controllers and providers;
it is not a UI feature flag and no dormant route remains reachable.

## Observability

Prometheus, Jaeger and Grafana are already an explicit Compose profile:

```bash
docker compose --profile observability up -d
```

## GitHub gateway

The GitHub Gateway service remains a separate `github` Compose profile for
controlled repository-import experiments. The product's GitHub App/PR routes
and browser workflow are removed; enabling this service alone does not expose
them.

```bash
npm run production:config:github
npm run production:up:github
```

The default production build does not build or start this profile.

## Removed product surfaces

The following unfinished product workflows are not part of either core or the
advanced Web product: Web Preview, structured Diff, Artifact download,
test-result navigation, Fork/Rollback, GitHub App/PR delivery, and organization,
RBAC or audit-search pages. Reintroducing one requires a new end-to-end product
decision, public contract and acceptance suite.
