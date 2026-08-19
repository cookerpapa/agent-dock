# Optional deployment modules

PiCloud's default deployment is the shortest production path required for
the conversation product:

```text
Web → Control Plane → PostgreSQL queue → Pi Worker → Tool Broker → Cube
                    ↘ PostgreSQL / Kafka / Valkey
```

The Control Plane exposes authentication, model/proxy settings, projects,
conversations, Workspaces, Runs, cancellation, steer and durable SSE. Dormant
research APIs are not compiled into the product.

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
test-result navigation, Workspace rollback, GitHub App/PR delivery, and
organization, RBAC or audit-search pages. Conversation forks, recursive tree
deletion and conversation-tail pruning are current core features; none of them
pretends to roll back Workspace bytes. Reintroducing a removed workflow
requires a new end-to-end product decision, public contract and acceptance
suite.
