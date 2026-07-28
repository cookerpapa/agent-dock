# Production deployment

## Supported topology

The local production profile is a self-hosted, loopback-only deployment:

```text
127.0.0.1:8080
  → Web ingress
  → Control Plane / Temporal / Pi Workers
  → Sandbox Manager
  → CubeSandbox KVM execution plane
```

Persistent business state lives in PostgreSQL and MinIO. Cube/POSIX/Kopia
provides Workspace execution and checkpoint storage. Only the Web ingress is
published to the host.

## Prerequisites

- Linux or WSL2 with KVM available;
- Docker Engine and Compose;
- Node.js 24 and npm 11;
- the CubeSandbox source/cluster expected by
  `scripts/install-cubesandbox-k3s.mjs`;
- enough disk for images, PostgreSQL, MinIO and Workspace checkpoints.

Verify KVM before installation:

```bash
test -r /dev/kvm -a -w /dev/kvm
```

## First deployment

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run production:init
npm run cubesandbox:init
# Run this operator-only step from a root shell.
npm run cubesandbox:cluster-install
npm run production:deploy
```

Run the initialization commands as the intended runtime owner. Only
`cubesandbox:cluster-install` runs as root; when a custom
`AGENT_DOCK_RUNTIME_DIRECTORY` is used, preserve that setting in the root
shell. The two initialization commands are idempotent, so
`production:deploy` validates and reuses the same private runtime.

`production:deploy`:

1. creates/validates the private production runtime directory;
2. creates/validates Cube credentials;
3. builds production images;
4. registers the current Cube Tool template;
5. starts the product services;
6. starts Kubernetes Pi Workers when that deployment mode is selected.

Open:

```text
http://127.0.0.1:8080
```

## Runtime configuration

Private runtime configuration is stored under:

```text
deploy/production/runtime/
├── .env
├── deployment.json
├── cubesandbox/
└── secrets/
```

The directory is ignored by Git and must remain mode `0700`; secret files must
remain `0600`.

Important non-secret settings include:

```text
AGENT_DOCK_HTTP_BIND_ADDRESS=127.0.0.1
AGENT_DOCK_HTTP_PORT=8080
AGENT_DOCK_PI_WORKER_DEPLOYMENT=compose|kubernetes
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true|false
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32
AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID=<dedicated-admin-tenant-uuid>
```

The Sandbox Provider is fixed to `cubesandbox`. Supplying another Provider
causes startup/deployment validation to fail.

## Accounts and administrator

Public registration creates ordinary tenant owners. Tenant ownership never
grants platform settings authority.

Create a dedicated administrator account through the normal registration
endpoint, then put its tenant UUID in:

```text
AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID
```

After Control Plane restart, that account lands on the administrator settings
page. Existing tenant owners remain ordinary product users.

The administrator can hot-update:

- Pi Worker model/provider credential;
- selected model;
- Cube outbound upstream proxy.

Those updates are versioned in PostgreSQL. New Runs/connections consume the
latest committed configuration without a cluster restart.

## Registration policy

Self-registration is bounded:

```text
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32
```

Use `false` for a closed private deployment. Existing accounts continue to
work.

## Pi Worker deployment

Compose mode is the simplest single-host profile:

```text
AGENT_DOCK_PI_WORKER_DEPLOYMENT=compose
```

Kubernetes mode uses the versioned Worker Pool Helm chart and supports replica
scaling:

```text
AGENT_DOCK_PI_WORKER_DEPLOYMENT=kubernetes
```

Commands:

```bash
npm run kubernetes:pi-workers:up
npm run kubernetes:pi-workers:status
npm run kubernetes:pi-workers:check
```

Pi Workers do not execute untrusted Tools locally. Adding Worker replicas
increases Agent Loop/model concurrency; Cube capacity is governed separately.

## Cube execution plane

```bash
npm run cubesandbox:ps
npm run cubesandbox:template-check
npm run cubesandbox:live-check
```

The registered template revision must match the Sandbox Manager environment.
The Manager fails closed if guest runtime/toolchain evidence does not match.

Cube guests:

- receive no platform/model credential;
- use `/workspace` for tenant files;
- route proxy-aware Web traffic through the Cube egress gateway;
- cannot reach private, metadata or platform addresses;
- are bounded by the fixed resource policy.

## Workspace persistence

The active guest mounts its Session-bound Workspace volume. The trusted Data
Mover creates immutable Kopia checkpoints and advances the PostgreSQL Workspace
head under fence/base-revision CAS.

Deleting a conversation does not delete its Workspace. Runtime eviction
destroys the guest but retains the committed Workspace. A new activation
restores that head.

Do not treat Cube RAM/process state as the durable recovery authority.

## Routine operations

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:build
npm run production:up
npm run production:down
```

`production:down` stops services but preserves named data volumes. Do not use a
volume-deleting Compose command unless an explicit destructive reset is
intended.

## Health

Check:

- Web/Control Plane health endpoint;
- Temporal frontend and Worker registrations;
- PostgreSQL and MinIO readiness;
- Sandbox Manager health;
- Cube API/Proxy/Cubelet health;
- Pi Worker pool status;
- egress gateway configuration revision.

The browser Workspace inspector reads only committed directory APIs. It does
not depend on administrative diagnostics or live Sandbox inspection.

## Backup

Stop application writers before a cold backup:

```bash
npm run production:down
npm run production:backup -- --output /absolute/private/path/agent-dock.adbackup
```

The backup contains encrypted/checksummed production state and image evidence.
Keep its passphrase and artifact outside the repository.

Restore only into an empty, intended runtime:

```bash
npm run production:restore -- \
  --input /absolute/private/path/agent-dock.adbackup
```

After restore:

```bash
npm run production:deploy
npm run production:check
```

## Upgrade

1. create a verified backup;
2. fetch/build the intended commit;
3. run zero-token CI;
4. run `production:deploy` (includes migrations and template registration);
5. inspect service/Worker/Cube health;
6. run live acceptance.

Database migrations are append-only engineering history. Do not edit a
migration already applied to a persistent database.

## Verification

Zero-token:

```bash
npm run format:check
npm run build
npm run check
npm run security:audit
npm run production:config
```

Real Cube/model path:

```bash
npm run production:check
```

The live path must verify:

- account/session/Workspace APIs;
- pure chat without Cube activation;
- Tool execution inside Cube;
- public proxy egress and private/platform denial;
- Pi checkpoint and multi-round restore;
- Workspace checkpoint and file inspection;
- cancellation/fencing;
- runtime cleanup;
- persisted token usage when a real model is enabled.

## Troubleshooting

### Browser returns no answer

Inspect, in order:

```bash
npm run production:ps
docker compose --env-file deploy/production/runtime/.env \
  -f deploy/production/compose.yaml logs --tail=200 control-plane supervisor-host
npm run kubernetes:pi-workers:status
```

Then inspect the Run/Attempt terminal failure in PostgreSQL/Control Plane
events. Do not infer the cause only from the browser message.

### Tool call cannot access the public Web

Check:

- administrator Cube proxy setting;
- Cube egress gateway health;
- WSL mirrored networking/upstream proxy reachability;
- the Tool process honors `HTTP_PROXY`/`HTTPS_PROXY`;
- target address is not in a denied class.

### Workspace inspector fails

Verify the Session has a committed Workspace version and the immutable
materializer/Data Mover is healthy. The directory UI intentionally does not
inspect a live guest or operational endpoints.
