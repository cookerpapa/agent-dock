# Configuration

AgentDock separates hot administrator configuration, restart-bound operator
configuration and generated secrets.

## Administrator settings

The administrator page stores versioned settings in PostgreSQL and applies
them to new requests without restarting the cluster:

- model provider, model ID and encrypted API credential;
- Cube public-egress proxy URL and bypass list.

Ordinary tenant users cannot read or update these settings.

## Generated one-host configuration

`npm run production:init` creates a private runtime directory containing `.env`
and secret files. It is intentionally destructive-incompatible with the retired
Temporal/MinIO/Kopia deployment format.

Important operator values include:

- HTTP bind address/port;
- Pi Worker replica profile and per-Worker capacity;
- public-registration and tenant quotas;
- Tool, model and Turn timeouts;
- Cube warm/persistent retention and capacity;
- Workspace Volume gateway concurrency;
- Kafka/Valkey event retention and projection settings;
- optional GitHub and observability profiles.

The Worker requires both:

```text
DATABASE_URL_FILE
DATABASE_NOTIFICATION_URL_FILE (optional on one host; defaults to DATABASE_URL)
```

In distributed deployments the first may use PgBouncer transaction pooling.
The notification URL must connect directly to PostgreSQL because `LISTEN` is
session-scoped.

No S3, MinIO, Kopia, Temporal Task Queue or execution Cell setting is accepted
by the current runtime.

## Kubernetes values

The platform and Pi Worker charts are JSON-schema validated. Required external
authorities are:

- PostgreSQL/PgBouncer and direct PostgreSQL notification URL;
- Kafka and Valkey;
- an existing ReadWriteMany Workspace PVC/CSI backend;
- Cube API/proxy/Volume Plugin endpoints;
- provider egress proxy.

KEDA's PostgreSQL scaler reads the count of ready `turn.command.v1` and
`turn.cancel.v1` Outbox rows. It changes Worker replica count only; database
claim/fence logic remains the scheduling authority.

## Ordered timing constraints

Startup and CI validate relationships rather than isolated numbers:

```text
Tool execution < Tool Broker RPC timeout
model upstream timeout <= Pi model timeout <= Pi Turn timeout
model capability TTL >= Pi Turn timeout + expiry margin
repository import lease <= repository import wait
Worker termination grace > Turn + Tool settlement window
Kafka retention > Valkey live replay window
```

Changing one value may require changing its dependents. Run:

```bash
npm run runtime-policy:check
npm run production:config
npm run helm:check
```

## Secrets

Never place credentials in committed Helm values or environment files. Use
private files/Kubernetes Secrets for database URLs, model encryption key,
Worker enrollment/management tokens, Tool Broker token, Cube API key, event
ingest token and metrics token. Cube receives none of them.
