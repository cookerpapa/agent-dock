# Configuration reference

This document describes the supported configuration surface of the current
CubeSandbox + Temporal production path. It deliberately separates settings an
operator may change from generated deployment identity and internal service
wiring.

## Configuration sources

AgentDock has three configuration layers:

1. **Administrator settings** are changed in the Web administration page and
   versioned in PostgreSQL. They take effect without restarting the cluster.
2. **Operator settings** live in
   `deploy/production/runtime/.env`. They are read when production services are
   rendered or started and normally require the affected service to be
   recreated.
3. **Secrets and generated identity** live under
   `deploy/production/runtime/secrets/` and `deployment.json`. The installer
   owns these files; they are not ordinary tuning knobs.

The runtime directory is ignored by Git and must remain mode `0700`. Secret
files must remain regular, non-symlink files with mode `0600` and a common
non-root owner.

Shell environment variables override values from the runtime `.env` for one
operator command. Use this only for an intentional one-off operation. Persist
normal settings in `.env` so a later deployment does not silently revert them.

### Distributed Kubernetes profile

The multi-node-capable profile is configured through the strict Helm values in
`deploy/helm/agent-dock-platform`, not through the single-host runtime `.env`.
Start from `values.distributed.example.yaml` and keep the resulting operator
file outside Git. Its main restart-bound settings are:

| Helm value | Purpose |
| --- | --- |
| `global.imagePullSecrets` | Namespace-local registry credentials used by every AgentDock Pod, including Pi Workers. |
| `controlPlane.autoscaling` / `web.autoscaling` | HPA lower/upper bounds and CPU targets. |
| `eventGateway.autoscaling` | KEDA Kafka-lag/CPU targets and the non-zero projector replica floor. |
| `pi-workers.autoscaling` | KEDA Temporal backlog target, Worker lower/upper bounds and conservative scale-down windows. |
| `sandboxPlane.replicas` | Sandbox Manager/Data Mover replica count; production requires at least three for Lease-based owner-loss detection. |
| `external.database.*` | PgBouncer application URL key plus a direct PostgreSQL session URL key for `LISTEN` and migrations. |
| `external.temporal`, `external.checkpointS3`, `external.kopiaS3` | External durable authorities shared by all replaceable application Pods. |
| `external.eventIngest` | Internal Event Gateway service URL and dedicated Worker-ingest service-token key. |
| `external.kafka` | Enterprise Worker-event transport, shared idempotent projection group and TLS/SCRAM Secret-key mapping. The topic and identity must exist before rollout. |
| `external.liveEventStore` | Valkey URL Secret key used by Event Gateway replay/projectors and the live-stream compactor. The file may contain one URL or comma-separated cluster seed URLs. |
| `networkPolicy.externalEgressCidrs` | Explicit external dependency CIDRs; the schema rejects `0.0.0.0/0`. |

`AGENT_DOCK_SANDBOX_MANAGER_URLS` is the ordered, comma-separated Manager
ring injected into Control Plane and Workers. The ordering is part of runtime
placement identity and must not be changed while activations are live.
`AGENT_DOCK_DATABASE_NOTIFICATION_URL` (normally file-backed) must bypass
transaction-pooling PgBouncer because PostgreSQL `LISTEN` is session-scoped.
The enterprise Chart also injects `AGENT_DOCK_EXTERNAL_WORKER_EVENT_LOG=true`,
the Event Gateway URL and a dedicated ingest service token into Control Plane
and Pi Workers. Do not enable only one side: all Worker publishers, Event
Gateway Kafka ingest/projectors and the terminal projection barrier are one
cutover unit. The service token authenticates AgentDock's internal HTTP
contract; Kafka TLS/SCRAM credentials remain mounted only in Event Gateway.

The checked-in enterprise Kafka profile requires TLS plus SCRAM-SHA-512 and
reads `kafka-ca.crt`, `kafka-username` and `kafka-password` from the global
platform Secret. `security.enabled=false` is for explicit local development,
not a Stage 1/2 deployment. Event Gateway reads the values from mounted files;
KEDA references the same Secret through `TriggerAuthentication`, so rendered
Pod environment values contain paths rather than credentials.

See [Distributed Kubernetes deployment](DISTRIBUTED_DEPLOYMENT.md) for the
preflight, Secret/PVC contract, scaling boundaries and blue-green procedure.

## Administrator settings

A platform administrator logs in through the normal Web entry point and lands
on the dedicated settings page.

| Setting | Supported values | Persistence and activation |
| --- | --- | --- |
| Pi Worker model | `deepseek-v4-flash`, `deepseek-v4-pro` | Versioned in PostgreSQL; a new Run reads the latest committed version. An active Run keeps its frozen model snapshot. |
| DeepSeek API Key | A provider key accepted by the administrator form | Encrypted at rest with the deployment model-credential master key; a new Run uses the new credential version. The plaintext key is not sent to Cube. |
| Cube public proxy enabled | enabled or disabled | Versioned in PostgreSQL; new proxy connections read the latest revision. |
| Cube upstream proxy URL | An HTTP proxy URL reachable by the Cube egress gateway | Versioned in PostgreSQL. Existing connections are not migrated; new proxy-aware HTTP/HTTPS connections use the new route. |

These are the only settings currently exposed in the administrator Web page.
Tenant ownership alone does not grant access.

To designate the administrator:

1. create the account through normal registration;
2. obtain its tenant UUID;
3. set `AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID` in the runtime `.env`;
4. recreate the Control Plane.

Changing the administrator identity is a deployment authorization change, not
a hot application setting.

## Supported operator settings

Run `npm run production:init` or `./install.sh` before editing the generated
runtime `.env`. Validate the resulting topology with:

```bash
npm run production:config
```

Apply changed restart-bound settings with:

```bash
npm run production:up
```

### Web and deployment

| Variable | Default | Purpose | Activation |
| --- | --- | --- | --- |
| `AGENT_DOCK_HTTP_BIND_ADDRESS` | `127.0.0.1` | Host address that publishes the Web ingress. Keep loopback unless a separate TLS/reverse-proxy boundary is intentionally configured. | Recreate Web ingress. |
| `AGENT_DOCK_HTTP_PORT` | `8080` | Host port for the Web product. | Recreate Web ingress. |
| `AGENT_DOCK_IMAGE_VERSION` | `production` | Local image tag used by the production topology. | Rebuild/recreate services. |
| `AGENT_DOCK_PI_WORKER_DEPLOYMENT` | `compose` | Selects `compose` or `kubernetes` Pi Workers. | Run `production:deploy`; old and new Worker modes are reconciled. |
| `AGENT_DOCK_SUPERVISOR_CAPACITY` | `1` | Maximum simultaneous active Runs admitted by each Compose Pi Worker process. | Recreate Pi Workers and Control Plane. |
| `AGENT_DOCK_WEB_SESSION_COOKIE_SECURE` | `false` | Marks browser session cookies Secure. Set to `true` when the browser reaches AgentDock through HTTPS. | Recreate Control Plane. |
| `AGENT_DOCK_WEB_SESSION_TTL_MS` | `2592000000` | Browser login lifetime in milliseconds; accepted range is one minute through 365 days. | Recreate Control Plane. |
| `AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID` | bootstrap model-source tenant when empty | Dedicated platform-administrator tenant UUID. | Recreate Control Plane. |

`AGENT_DOCK_SUPERVISOR_ID_PREFIX` and
`AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE` are generated topology values.
Change them only together with the Worker deployment manifests and networking.

### Registration and tenant quotas

| Variable | Default | Purpose | Activation |
| --- | --- | --- | --- |
| `AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED` | `true` | Enables or disables creation of new accounts from the public registration page. Existing accounts remain usable. | Recreate Control Plane. |
| `AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS` | `32` | Maximum number of tenants admitted by public registration. | Recreate Control Plane. |
| `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS` | `10` | Project/Workspace quota assigned to newly registered public tenants. | Recreate Control Plane; does not rewrite existing tenant policy rows. |
| `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS` | `100` | Conversation quota assigned to newly registered public tenants. | Recreate Control Plane; does not rewrite existing tenant policy rows. |
| `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS` | `10` | Maximum queued plus active Runs assigned to newly registered public tenants. | Recreate Control Plane; does not rewrite existing tenant policy rows. |
| `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS` | `2` | Maximum concurrently active Runs assigned to newly registered public tenants. It cannot exceed the unsettled-Run limit. | Recreate Control Plane; does not rewrite existing tenant policy rows. |

The bootstrap service account tenant has a separate policy surface:

| Variable | Default |
| --- | --- |
| `AGENT_DOCK_TENANT_MAXIMUM_PROJECTS` | `100` |
| `AGENT_DOCK_TENANT_MAXIMUM_SESSIONS` | `1000` |
| `AGENT_DOCK_TENANT_MAXIMUM_UNSETTLED_TURNS` | `100` |
| `AGENT_DOCK_TENANT_MAXIMUM_CONCURRENT_TURNS` | `2` |

Those bootstrap values are reconciled by the database bootstrap service. They
do not define the policy of accounts created through public registration.

### Object storage and live events

| Variable | Default | Purpose | Notes |
| --- | --- | --- | --- |
| `AGENT_DOCK_CHECKPOINT_BUCKET` | `agent-dock-checkpoints` | Immutable Pi Session checkpoint objects. | Changing an occupied bucket does not migrate existing checkpoints. |
| `AGENT_DOCK_CHECKPOINT_REGION` | `us-east-1` | S3 region used for Pi checkpoint requests. | Must match the selected object store. |
| `AGENT_DOCK_WORKSPACE_KOPIA_BUCKET` | `agent-dock-workspace-kopia` | Kopia repository objects for durable Workspace checkpoints. | Changing an occupied repository requires an explicit migration and recovery test. |
| `AGENT_DOCK_WORKER_EVENT_RETENTION_MS` | `86400000` | Kafka raw Worker-event retention in the single-host topic bootstrap. | Must exceed the one-hour Valkey live replay window. Recreate the topic to change an existing topic. |
| `AGENT_DOCK_EVENT_RETENTION_INTERVAL_MS` | `60000` | Idle scan interval for the Valkey compactor. | Minimum 1000 ms. Recreate Event Retention. |
| `AGENT_DOCK_EVENT_RETENTION_BATCH_SIZE` | `100` | Maximum terminal Turns trimmed before the Worker yields. | Tune against Valkey and PostgreSQL control-row capacity. Recreate Event Retention. |

The default topology deliberately fixes MinIO endpoints, key prefixes and
path-style access to its internal object-storage network. External S3 is a
deployment-topology change, not a supported `.env` toggle in the single-host
profile.

The distributed Helm profile exposes compactor cadence under
`eventRetention.intervalMs` and `eventRetention.batchSize`. Its replicas are
safe to increase because claims and replay-floor advancement are coordinated
in PostgreSQL. Kafka topic retention must exceed the live replay window so an
empty Valkey read model can be rebuilt. Object-store lifecycle rules apply to
Pi Session, Workspace and Artifact objects, not raw token deltas.

### Optional modules and observability

| Variable | Default | Purpose | Activation |
| --- | --- | --- | --- |
| `AGENT_DOCK_PRODUCTION_PROFILES` | empty | Comma-separated optional Compose profiles: `observability`, `github`. | Re-run the matching production `up` command. |
| `AGENT_DOCK_OTLP_TRACES_ENDPOINT` | empty | Explicit OTLP/HTTP traces endpoint. | Recreate emitting services. |
| `AGENT_DOCK_PROMETHEUS_PORT` | `9090` | Loopback port exposed by the observability ingress. | Recreate observability ingress. |
| `AGENT_DOCK_JAEGER_PORT` | `16686` | Loopback port exposed by the observability ingress. | Recreate observability ingress. |
| `AGENT_DOCK_GRAFANA_PORT` | `3001` | Loopback port exposed by the observability ingress. | Recreate observability ingress. |
| `AGENT_DOCK_ADVANCED_MODULES_ENABLED` | `false` | Enables maintained research/backend modules that are outside the default product UI. | Recreate Control Plane. |
| `AGENT_DOCK_GITHUB_APP_ID` | empty | GitHub App identifier for the optional `github` profile. | Recreate the optional GitHub Gateway. |

Convenience commands:

```bash
npm run production:config:observability
npm run production:up:observability
npm run production:config:github
npm run production:up:github
```

The optional GitHub profile also requires its private key and webhook secret in
the generated secret paths. Enabling a profile does not promote its unfinished
browser workflow into the default product.

### Trusted-host proxy variables

`HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` may be supplied to image builds and
trusted provider egress. They are distinct from the Cube public proxy setting:

- trusted-host variables govern build/provider traffic outside the guest;
- the administrator Cube proxy governs proxy-aware HTTP/HTTPS traffic from
  untrusted microVMs through the public-only egress gateway;
- neither setting permits Cube to reach private, metadata or platform
  addresses.

## Fixed production policy

The following values exist in service code but are intentionally fixed in the
current production topology. They are documented here so they are not mistaken
for missing Web settings.

| Policy | Current value |
| --- | --- |
| Sandbox Provider | CubeSandbox only; alternate Providers fail validation. |
| Cube warm idle lifetime | 15 minutes (`900000` ms). |
| Maximum active Tool Sandboxes | 2. |
| Maximum warm Sandboxes | 4. |
| Maximum remote Tool execution | 5 minutes. |
| Worker-to-Sandbox Manager request | 6 minutes. |
| Pi Turn timeout | 10 minutes. |
| Model Gateway upstream request | 120 seconds. |
| Pi model-request timeout | 150 seconds. |
| Model capability TTL | 15 minutes. |
| Model requests per Run | 32. |
| Pi checkpoint read-cache TTL | 10 minutes. |
| Pi checkpoint read-cache capacity | 512 objects / 32 MiB. |
| Compose/Kubernetes Pi Worker termination grace | 22 minutes. |
| Sandbox Manager ownership heartbeat / lease | 5 seconds / 15 seconds. |
| Worker Control Channel heartbeat / timeout / lease | 10 seconds / 30 seconds / 60 seconds. |
| Valkey live replay / single-host Kafka retention | 1 hour / 24 hours. |

### Cross-component ordering

These durations are not independent tuning values. AgentDock validates the
following order in Worker startup and deployment CI:

```text
Tool execution 5m
  < Worker-to-Manager request 6m

provider upstream 120s
  <= Pi model request 150s
  <= Pi Turn 10m
  < model Capability 15m

Pi Turn 10m + Manager request 6m + settlement 5m + process margin 1m
  <= Worker termination grace 22m

Valkey live replay 1h
  < Kafka raw-event retention 24h (single host) / 7d (enterprise)
```

Lease-style settings have their own ordering: heartbeat intervals must leave
at least one missed-heartbeat detection margin before ownership expiry. Lease
expiry changes who may commit; cache and warm-idle expiry only trigger a cold
restore and never extend authority. Browser session TTL and Temporal history
retention are similarly separate from Run/Tool ownership.

Increasing an upstream timeout without also increasing the downstream request,
Capability and shutdown budgets is rejected. Reducing Kafka retention below
the live replay window is also rejected because Valkey could no longer be
rebuilt before canonical-transcript fallback. See
[ADR-0094](adr/0094-cross-component-time-and-retention-budgets.md).

Changing these values requires a code/deployment-policy change plus capacity,
failure and security acceptance. They are not supported administrator hot
configuration.

## Generated identity: do not hand-edit

`production:init` writes deployment identity into `.env` and
`deployment.json`. These values bind database bootstrap records, credentials,
images and Cube evidence together:

```text
AGENT_DOCK_RUNTIME_DIRECTORY
AGENT_DOCK_APPLICATION_UID
AGENT_DOCK_APPLICATION_GID
AGENT_DOCK_TENANT_ID
AGENT_DOCK_USER_ID
AGENT_DOCK_API_CREDENTIAL_ID
AGENT_DOCK_CREDENTIAL_BINDING_ID
AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID
```

Do not copy identifiers between installations or regenerate only one side.
Use backup/restore for an existing installation and `production:init` for a
new one.

`AGENT_DOCK_IMAGE_REVISION` is derived from the exact Git commit by the
production command and is also checked against the registered Cube template.
Do not use it to bypass stale-template validation.

## Secret inventory

The installer creates private files for:

- PostgreSQL and MinIO credentials;
- internal API, Supervisor, Sandbox Manager, Data Mover and egress tokens;
- the model-credential encryption master key;
- Cube API access;
- Kopia repository and scoped object-store credentials;
- metrics and optional GitHub/Grafana credentials.

The model provider API Key is the exception: the administrator rotates it in
the Web page, and the encrypted record is stored in PostgreSQL. Cube never
receives that key or the master key.

Do not move secret contents into `.env`, commit the runtime directory or mount
the whole secrets directory into a guest. Rotate service credentials through a
planned maintenance procedure because a partial rotation can split trusted
components across different authentication epochs.

## Safe change procedure

For restart-bound configuration:

1. create a verified backup for storage, identity or authentication changes;
2. edit `deploy/production/runtime/.env`;
3. run `npm run production:config` and inspect validation errors;
4. run `npm run production:up` (or the selected profile command);
5. check `npm run production:ps` and service logs;
6. run the relevant zero-token or live acceptance check.

For administrator model/proxy settings, use the Web page. The committed
revision is immediately visible there, so a cluster restart is neither needed
nor desirable.
