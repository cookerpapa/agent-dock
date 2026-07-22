# Production deployment runbook

This runbook deploys AgentDock's currently supported production slice on one
Linux Docker host. The result is a durable, authenticated, private multi-tenant
service with PostgreSQL metadata, MinIO checkpoint bytes, a tenant-neutral
remote control plane, one shared trusted Pi Agent Runner, separate one-shot Tool
Sandboxes, and a static Web UI. Multiple tenants can share this runtime without
sharing their API resources, event streams, quotas, or checkpoint namespaces.
The loopback product enables capacity-bounded browser account registration so
the isolation can be exercised from separate browser contexts; an operator can
disable new registration without invalidating existing accounts.

The word _production_ here means that this bounded slice has explicit
configuration, durable storage, health checks, restart behavior, security
boundaries, and a destructive disposable acceptance test. It does not turn the
service into a general coding-agent SaaS. A workspace may use the image-owned
Java repair fixture or a small public GitHub repository pinned to an exact
commit. An operator-configured GitHub App may additionally expose allowlisted
private repositories and trusted Pull Request delivery without giving GitHub
credentials to repository code. The platform operator configures the backend
model once; new browser tenants inherit that allowlisted model through a
separately encrypted tenant binding and never receive its API key. It does not
support arbitrary Git URLs, arbitrary provider URLs,
policy-approved third-party extensions, hostile public Internet SaaS,
multi-node Kubernetes, or direct Internet exposure.
The optional registration route is not verified
human identity, billing, OIDC, recovery, abuse prevention, or a hostile public
code-execution SaaS boundary. Those limits are part of the product contract,
not hidden deployment TODOs.

The architecture and safety rationale are recorded in
[ADR-0023](adr/0023-production-supervisor-host-and-self-hosted-topology.md) and
[ADR-0024](adr/0024-permanent-event-rejection-and-spool-quarantine.md). Private
tenant identity, quotas, isolation, and fair dispatch are recorded in
[ADR-0025](adr/0025-private-multi-tenant-identity-and-fair-scheduling.md).
Opt-in registration and conversation discovery are recorded in
[ADR-0026](adr/0026-opt-in-self-service-registration-and-conversation-discovery.md).
Encrypted tenant model credentials, brokered egress, and real Pi execution are
recorded in
[ADR-0027](adr/0027-tenant-model-credentials-and-brokered-pi-execution.md).
Controlled public GitHub import and immutable workspace seeds are recorded in
[ADR-0028](adr/0028-controlled-github-workspace-import.md).
The trusted Pi Runner and remote Tool Sandbox split is recorded in
[ADR-0029](adr/0029-trusted-pi-runner-and-remote-tool-sandbox.md).
The provider-neutral runtime boundary is recorded in
[ADR-0030](adr/0030-pluggable-sandbox-provider-boundary.md), the gVisor-only
decision in [ADR-0038](adr/0038-gvisor-only-tool-execution.md), and the current
Kubernetes-managed execution plane in
[ADR-0039](adr/0039-kubernetes-gvisor-execution-plane.md) and
[ADR-0040](adr/0040-demand-activated-warm-sandboxes-and-batched-events.md).
Versioned environments and capability-scoped dependency setup are recorded in
[ADR-0042](adr/0042-versioned-project-environment-plane.md) and
[ADR-0044](adr/0044-capability-scoped-dependency-egress.md).
Product operations,
recovery, and release evidence are recorded in
[ADR-0036](adr/0036-product-operations-and-release-evidence.md). See also the
[browser account and platform-model decision](adr/0037-browser-accounts-and-platform-managed-model.md),
[threat model](THREAT_MODEL.md), [network matrix](NETWORK_MATRIX.md), and
[Sandbox Provider contract](SANDBOX_PROVIDER.md).

## Prerequisites

- Ubuntu amd64 with systemd and working `/dev/kvm`. On WSL2, enable nested
  virtualization and use the native WSL services rather than Docker Desktop's
  sandbox runtime.
- Docker Engine/Compose for the trusted product plane, plus K3s/containerd and
  gVisor `runsc`/KVM for the untrusted execution plane. The validated host uses
  Docker Engine `29.6.2`, Compose `5.1.3`, K3s `v1.36.2+k3s1`, containerd
  `2.3.2-k3s2`, and `runsc release-20260714.0`.
- Node.js `24.18.0` and npm `11.16.0` for the verified repository toolchain. The built
  application images pin their own Node and service image digests.
- Enough local CPU, memory, and storage for PostgreSQL, MinIO, seven application
  images, and up to two concurrent workers. The Compose file declares explicit
  per-service limits; capacity should be measured against the intended host.
- A private checkout and a trusted operator account. Anyone who can read the
  generated runtime directory or administer Docker/K3s/containerd is inside the
  trusted computing base. No application service receives a runtime socket.

Install and attest the host first:

```bash
sudo AGENT_DOCK_HOST_USER="$USER" ./scripts/install-kubernetes-gvisor-host.sh
newgrp docker
npm run sandbox:check
```

The installer is checksum/version pinned for K3s and runsc, creates the scoped
RBAC/NetworkPolicy/RuntimeClass resources, and writes the private Manager
kubeconfig. Do not expose Docker/containerd/Kubernetes credentials to an
application or Tool Pod. The Manager fails readiness instead of falling back to
runc or systrap. On the validated WSL2/K3s network path, the installed runsc
configuration retains `network = "sandbox"` but disables host/software GSO;
the public importer pins Git HTTP/1.1. `npm run sandbox:check` performs a real
exact-commit import so this compatibility path cannot silently regress.

## First deployment

Install the exact lockfile without running package lifecycle scripts, then run
the idempotent deployment entry point:

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run production:deploy
```

Browser registration is enabled by default because the supported ingress is
loopback-only. To choose a smaller capacity before the first command, set the
bounded value; initialization validates and persists it in the private runtime
`.env`:

```bash
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32 \
npm run production:deploy
```

The first invocation creates `deploy/production/runtime/`, generates private
random credentials and stable logical IDs, builds all seven pinned application
images, migrates and bootstraps PostgreSQL, creates a private checkpoint bucket,
and waits for every long-running service to become healthy. A completed runtime
directory is reused on later invocations. A non-empty partial directory is
rejected rather than silently replacing credentials.

The default ingress is `http://127.0.0.1:8080`. Open it, create a username and
password, and continue directly to the conversation product. Login persists in
an HttpOnly cookie, so a reload does not require another credential prompt. The
first message lazily creates an empty Workspace; the left sidebar lists only
that account tenant's conversations and the right side streams the selected
conversation.

The initial bootstrap owner token remains an operator/automation credential and
is not part of the normal Web login. Obtain it only on the trusted host when an
API or administration task needs it:

```bash
npm run production:token
```

Configure or rotate the platform backend model with that trusted operator
identity, not in the user-facing page. New accounts inherit the active platform
model; existing accepted Turns keep their immutable model snapshot. The token
command intentionally writes a secret to stdout, so do not run it in CI logs,
shell tracing, a screen recording, or an untrusted terminal multiplexer.

After opening a Session, `inspect` opens the product evidence surface:
Workspace versions/files/structured comparisons, bounded escaped Artifact
previews, Run/Attempt transitions, test results, usage/context, and owner-only
operations/activity. Mutating controls submit normal idempotent fork, rollback,
archive, or retry-as-new-Run requests; the browser never rewrites a terminal
Run. For a configured GitHub App, the create-workspace panel synchronizes one
installation and shows only enabled repositories, while the Workspace panel
offers an explicit branch/commit/Check/Pull Request action. The default
placeholder App configuration fails those paths closed.

To choose a different loopback port or an external runtime directory, set these
values only before the first initialization:

```bash
AGENT_DOCK_HTTP_PORT=18080 \
AGENT_DOCK_RUNTIME_DIRECTORY=/absolute/private/agent-dock-runtime \
npm run production:deploy
```

The generated `.env`, `deployment.json`, and every file under `secrets/` are
mode `0600`; their two parent directories are mode `0700`. Keep the runtime
directory outside unencrypted/general-purpose backups, artifact uploads, and
source-control staging. The coordinated encrypted recovery backup described
below must include it. The repository's default runtime path is ignored by Git.
The control-plane containers run under the non-root numeric owner of their four
mounted application secret files, avoiding an assumption that every Docker host
uses UID `1000`. Initialization performed as root assigns those files to the
image's unprivileged `1000:1000` identity. Mixed owners or a root-owned
application secret fail before Compose starts.

Initialization also creates `secrets/dependency-egress-private-key.pem`, a
stable Ed25519 issuer owned only by the Sandbox Manager. The Manager publishes
only its public key into the named Kubernetes trust ConfigMap. Re-running
initialization validates and preserves the private key; production acceptance
checks that neither the PEM nor any other secret appears in Compose output,
container logs or durable Agent events.
The generated `model-credential-master-key` encrypts tenant provider keys with
AES-256-GCM and must be backed up with PostgreSQL. It is mounted only into the
control plane and trusted Supervisor host. Losing it makes configured provider
credentials unrecoverable; exposing it together with the database exposes
those credentials.
The MinIO root credential stays in the MinIO/bootstrap boundary. The Supervisor
uses a separate generated application identity whose policy permits bucket
location/list plus object read/write only for the checkpoint bucket; it has no
object-delete action. Reusing an older runtime that gave the Supervisor the root
credential atomically migrates `aws-credentials` during `production:init` before
the topology is updated.

## Deployment topology

Only the Web service publishes a host port, bound to loopback by default:

```text
browser -> web/Caddy -> authenticated /v1 API -> control-plane
       GitHub webhook -> HMAC Gateway |              |
                                      |              +-> PostgreSQL
                                      |              +-> GitHub Gateway RPC
                                      |              +-> outbound Supervisor WebSocket
                                      v
                              trusted Pi Agent Runner -> MinIO checkpoints
                                      |         |
                                      |         +-> fixed provider API (egress only here)
                                      |         +-> loopback Model Gateway
                                      |
                                      +-> narrow authenticated tool RPC
                                                   |
                                             Sandbox Manager
                                                   |
                                            scoped Kubernetes API
                                                   |
                                      K3s -> containerd -> runsc/KVM
                                                   |
                               demand-activated warm Tool Pod (default-deny)
```

The optional `github-gateway` is the only service that reads the GitHub App
private key or obtains installation tokens. It joins only `github-control` and
provider egress; it has no database, MinIO, model, Manager, Kubernetes, or runtime authority.
The Control Plane and trusted Runner call it with a service credential, while
the Tool Sandbox is not attached to its network. With the default empty App ID
and placeholder key, liveness remains healthy but private import, installation
registration, and PR delivery return `github_app_not_configured`.

The database, object store, Supervisor management endpoint, boot-provisioning
route, readiness endpoints, and outbound Supervisor transport stay on isolated
Compose networks. Caddy returns `404` for `/internal/*` and `/health/*`; it only
proxies `/v1/*` and serves static assets. Liveness is exposed as `/healthz` and
contains no dependency detail.

The trusted `supervisor-host` runs as the deployment's non-root application UID
and has no runtime socket or Kubernetes credential. It runs pinned Pi with built-in local tools and
extension discovery disabled, then loads one fixed image-owned extension that
routes `read/write/edit/bash` through the private `sandbox-control` network. Pi
and the loopback Model Gateway receive a turn capability; that environment is
never forwarded to remote bash.

The separate `sandbox-manager` runs non-root with a private least-privilege
kubeconfig. It has no Docker/containerd socket, database, S3, provider,
enrollment, GitHub or tenant credential and exposes only authenticated bounded
lifecycle/tool/inventory operations. It constructs only
`KubernetesGvisorSandboxProvider`; the former provider selector and direct
Docker implementations do not exist. A credential-free relay gives this
internal-network service TCP reachability to the host API without receiving the
kubeconfig. Readiness starts a real gVisor Pod and every activation is
re-inspected for RuntimeClass, Pod UID and guest-kernel identity. Capability
authorization and assignment fencing remain above the Provider implementation.
Tool Pods are demand-activated on the first Tool Call, not for pure chat. A
healthy Pod is dedicated to one exact tenant/project/workspace/session and may
remain warm across later Runs under a fresh fence until idle TTL/LRU eviction.
The Manager also maintains two optional tenant-free `clean-prewarm` gVisor Pods.
They contain empty volumes and no assignment, are consumed exactly once by a
first Tool activation, and can never be returned after tenant code runs.
They run as UID/GID `1000:1000`, with
`runtimeClassName: agent-dock-gvisor`, default-deny network,
no ServiceAccount token, host namespace/path/device/socket, inherited
credential, published port or writable root filesystem, and are removed after
failure, cancellation, timeout, revision mismatch, eviction, or shutdown.
Cold sessions consume no Pi process, Tool Sandbox, socket, timer, or dedicated
thread.

Persistent state is split into seven declared volumes:

- `postgres-data`: tenants, encrypted model credentials, token usage, sessions,
  commands, leases, events, checkpoint metadata, Supervisor generations, and
  retirement work;
- `minio-data`: immutable Pi JSONL and workspace checkpoint bytes;
- `supervisor-boot`: fsynced current/recent boot ownership ledger;
- `supervisor-spool`: active unacknowledged event publications and permanently
  stale quarantine evidence;
- `prometheus-data`: retained platform time-series evidence;
- `grafana-data`: dashboard/operator state;
- `jaeger-data`: retained trace evidence.

PostgreSQL metadata and MinIO objects form one logical checkpoint. The boot and
spool volumes are also required for honest owner-stop proof and event recovery;
the observability volumes preserve the operator evidence shown by the deployed
product. Do not treat any subset as the supported complete recovery point.

## Routine commands

```bash
npm run production:config   # validate interpolation without printing secrets
npm run production:build    # rebuild all application and worker images
npm run production:up       # start already-built images and wait for health
npm run production:ps       # show service state and health
npm run production:logs     # follow bounded container logs
npm run production:down     # stop the topology and preserve all seven volumes
```

`production:down` is non-destructive. Do not append `--volumes` during normal
operation. Removing the Compose volumes permanently deletes the database,
checkpoint bytes, owner ledger, spool, and retained telemetry; take and verify
a coordinated backup first and resolve the exact Compose project/volume names with
`docker compose ls` and `docker volume ls` rather than using globs.

Container logs use Docker's bounded `json-file` policy: three files of at most
10 MiB per service. Logs contain safe component/state/error codes and opaque
identifiers, but operators should still grant log access as privileged
operational access.

## Browser accounts and bounded registration

`POST /v1/auth/register` and `POST /v1/auth/login` are the normal product entry.
Registration accepts a normalized username, display name, and password. One
transaction creates the tenant-local owner, quota policy, inherited platform
model binding, salted scrypt password verifier, and first Web session. The
response contains identity and expiry metadata only. The browser receives an
opaque `HttpOnly`, `SameSite=Strict` cookie; PostgreSQL stores only its SHA-256
digest. `POST /v1/auth/logout` revokes it immediately. Existing login sessions
survive Control Plane/Web restarts because they are database-backed.

The legacy `POST /v1/registrations` route remains for API compatibility and
returns an owner bearer token once. It is not used by the default Web
application. Both registration routes exist only when
`AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true` and share the same total-tenant
admission cap.

The defaults written for a new runtime are:

```text
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS=10
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS=100
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS=10
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS=1
```

The total-tenant cap includes the bootstrap tenant and any offline-created
tenants. Concurrent registrations serialize inside PostgreSQL, so successful
requests cannot race beyond it. A duplicate username/slug returns `409`; a full
runtime returns `429`; disabled registration returns `404`. Failed browser
registration retains no partial tenant, password verifier, session, or model
binding.

For an existing deployment, edit
`deploy/production/runtime/.env` (or the selected external runtime's `.env`),
change only these bounded non-secret settings, then run
`npm run production:deploy`. Disabling it later prevents new self-service
tenants but does not delete or disable existing tenants. Existing accounts can
still log in. The registration tab remains visible and reports the bounded
server response when admission is disabled.

After login, `GET /v1/conversations` lists at most the newest 100 sessions for
the verified tenant, and `GET /v1/conversations/:sessionId` loads at most the
newest 200 prompt turns before the Web resumes that session's durable SSE
suffix. There is no tenant selector. A cookie or token from another tenant
receives the same `404` for that exact session UUID as it would for a
nonexistent UUID.

This option is suitable for loopback/private functional validation. It has no
distributed login limiter, CAPTCHA, verified email, password recovery/MFA,
billing, or hostile-public-customer sandbox claim. Do not treat the convenient
account screen as authorization to publish the bundled HTTP endpoint on the
Internet.

## Privileged tenant administration

Credential issue/list/revoke, custom quotas, and unrestricted tenant creation
remain offline operator actions. Self-registration cannot grant a role other
than owner for its new tenant, choose another tenant, or access this privileged
administration boundary. Create a manually managed tenant from the trusted host:

```bash
npm run production:tenant -- create \
  --slug team-alpha \
  --display-name "Alpha owner" \
  --maximum-projects 100 \
  --maximum-sessions 1000 \
  --maximum-unsettled-turns 100 \
  --maximum-concurrent-turns 1
```

The JSON result contains stable tenant/user/profile IDs and the initial owner
token. The token is printed exactly once; transfer it through a separate secure
channel and do not paste the command output into logs or tickets. To create a
second credential for an existing tenant-local user:

```bash
npm run production:tenant -- issue \
  --tenant team-alpha \
  --user-id USER_UUID_FROM_CREATE \
  --label "read-only browser" \
  --role viewer
```

Roles are `owner`, `member`, and `viewer`. Owner and member may use the current
project/session/turn/cancellation API; viewer may authenticate and read an event
stream but cannot mutate resources. Inspect safe credential metadata or revoke
one credential without revealing any token digest:

```bash
npm run production:tenant -- list --tenant team-alpha
npm run production:tenant -- revoke \
  --tenant team-alpha \
  --credential-id CREDENTIAL_UUID
```

Switching browser accounts means logging out and logging in with the other
username. There is no client-supplied tenant selector. The running control plane
does not mount the bootstrap/API-token file and has no configured default
request tenant; it derives every public request scope from the verified cookie
or Bearer credential.

## Tenant model configuration

The bootstrap operator tenant is the platform model source. In a deterministic
acceptance deployment, new accounts inherit that zero-token profile. When the
operator source uses an allowlisted DeepSeek model, registration decrypts the
source key only inside the trusted Control Plane and re-seals it with the new
tenant/binding/version as AES-GCM associated data. No user response or browser
asset contains the key.

Normal product accounts may read safe `GET /v1/model-configuration` metadata
for diagnostics but cannot replace it. The default Web application has no model
panel. In production, only the configured platform operator tenant may call
`PUT /v1/model-configuration`; the endpoint accepts only `deepseek` plus the
server model allowlist and never accepts a provider URL.

Operator replacement creates immutable credential-binding versions for the
platform source and every browser-account tenant in one transaction. Repeating
the same key/model is content-idempotent. Already accepted Turns keep their
snapshotted version; future Turns and newly registered accounts use the current
source. Manually provisioned API-only tenants remain independent.
Provider-reported input, output, cache-read, and cache-write tokens are written
to `usage_ledger` for each model call. Monetary cost uses immutable integer
micro-USD rate snapshots. Bootstrap rates are deliberately zero; AgentDock
never guesses current provider pricing.

The trusted Supervisor decrypts the exact snapshotted version and gives its
in-process Pi runtime only a short-lived, request-limited loopback Model Gateway
capability. The capability is revoked when the activation settles and never
crosses the remote-tool RPC boundary. Tool Pods have no network at all.
Treat the Supervisor, Sandbox Manager, PostgreSQL, private runtime directory,
K3s/containerd/runsc and host authority as the trusted computing base; this is not a mutually
hostile public-SaaS sandbox.

## Controlled GitHub workspaces

Sending a first message without importing a repository creates an empty
Workspace. To work on existing code, open `导入项目`; choose the explicit Java
fixture for acceptance or `公开 GitHub 仓库` and provide only:

- a lowercase `owner/repository` coordinate such as
  `mathewjonas/java-calculator-junit`; and
- the exact lowercase 40-hex commit SHA to preserve as the workspace baseline.

The API intentionally accepts no URL, branch, tag, credential, SSH form, Git
configuration, or arbitrary host. Project, workspace, and pending source state
commit in one tenant-scoped transaction. The first turn may take longer because
the Supervisor must win an expiring PostgreSQL import lease, ask the Sandbox
Manager to start a hardened one-shot importer, and publish the verified
content-addressed seed to MinIO.
Concurrent first turns wait for that seed. Every later activation rechecks its
object key, byte count, SHA-256, and manifest, then overlays the last settled
session checkpoint; it does not clone again.

The importer has no host mount, ServiceAccount token, runtime socket, prompt,
provider/deployment credential or published port. It is a separate gVisor Pod
in `agent-dock-importers`; NetworkPolicy permits cluster DNS and public TCP/443
while excluding loopback, private, link-local, Pod, Service and node ranges.
The importer receives only a normalized GitHub coordinate and exact commit,
disables hooks and redirects, and never executes repository code or a
user-controlled command. Standard NetworkPolicy plus a fixed GitHub URL is not
a DNS-aware firewall; do not claim this as a mutually hostile public-tenant
boundary.

Current repository limits are at most 512 regular files, 512 KiB per file, and
2 MiB for the canonical manifest. Absolute/traversing paths, symlinks, special
files, redirects, submodules, LFS filters, oversized content, and commit mismatch
fail closed. Arbitrary Git hosts, branch/tag refresh, sparse checkout, and direct
Tool-Sandbox GitHub credentials are not supported.

For private repositories and PR write-back, create a least-privilege GitHub App
outside AgentDock, install it only on intended repositories, stop the topology,
replace `secrets/github-app-private-key.pem` in the private runtime with the App
PEM while preserving mode `0600` and the application UID/GID, and add the
positive `AGENT_DOCK_GITHUB_APP_ID` to that runtime's private `.env`. Restart
with `production:up`. The Web owner enters an installation ID, synchronizes its
repository list, and can choose only a repository explicitly enabled in
AgentDock. Exact commit SHA remains mandatory.

The Gateway creates short-lived installation tokens in trusted memory. Private
snapshot bytes cross its authenticated RPC boundary; PR delivery consumes a
tenant/version-validated patch Artifact and performs branch, commit, Check Run,
and PR API operations inside the Gateway. The token never reaches the Control
Plane, Runner, Tool Sandbox, events, or Artifact. Production ships with a
placeholder key/empty App ID and fails these operations closed. Deterministic
GitHub API contract tests do not constitute a live installation; validate a
real App in a private test repository before relying on delivery.

## TLS and network exposure

The bundled Caddy configuration intentionally serves plain HTTP on loopback. It
is safe for local-host access and for the disposable acceptance topology; it is
not an Internet ingress.

For remote access, keep AgentDock bound to loopback or a private network and put
a separately managed TLS reverse proxy or authenticated tunnel in front of it.
Set `AGENT_DOCK_WEB_SESSION_COOKIE_SECURE=true` before redeploying so browsers
send account cookies only over HTTPS.
Preserve the `Authorization` header, disable proxy buffering for
`text/event-stream`, allow long-lived SSE reads, and keep `/internal/*`,
`/health/*`, PostgreSQL, MinIO, Supervisor management, the Kubernetes API, and
all Docker/containerd sockets unreachable. Add host firewall rules and an identity-aware access layer if more
than the trusted operator can reach the endpoint. Binding
`AGENT_DOCK_HTTP_BIND_ADDRESS=0.0.0.0` without those controls is unsupported.

The included browser session is HttpOnly and SameSite Strict, and bearer
credentials still provide private tenant automation with three coarse roles.
These controls do not constitute verified public identity, password recovery,
MFA, distributed rate limiting, enterprise RBAC, billing, or abuse protection.

## Health and operations

Use `npm run production:ps` for the first health view. Expected steady state:

- `postgres`, `minio`, `control-plane`, `sandbox-manager`, `supervisor-host`,
  and `web` are healthy;
- `database-bootstrap`, `minio-bootstrap`, and `supervisor-volume-bootstrap`
  exited successfully;
- no `tool-sandbox-image` service is running;
- no assigned `workload=tool-sandbox`, dependency-bootstrap or importer Pod
  remains after explicit Session retirement; up to the configured two
  tenant-free `workload=clean-prewarm` Pods remain as steady-state capacity;
- one current Supervisor boot is ready for the configured stable Supervisor ID.

`production:up` includes Compose orphan cleanup. An upgrade from the former
repository-egress topology therefore removes its exited network-bootstrap
container; after its empty obsolete network is removed once, no compatibility
service or network remains.

The Supervisor is ready only after the authenticated Sandbox Manager,
PostgreSQL, MinIO, provisioning, spool recovery, and its current outbound
WebSocket are ready. A transient
control-plane restart may make a committed command's outcome ambiguous. The
system then fails that command/session as `connection_closed`, never replays its
possible side effects, quarantines a permanently stale final spool event with a
checksummed rejection record, reconnects the same Supervisor boot, and accepts
future work in a new session. This is intentional at-least-once delivery safety,
not a transparent exactly-once claim.

One Supervisor process advertises a default capacity of two. Do not scale the
`supervisor-host` service while it uses one stable `AGENT_DOCK_SUPERVISOR_ID` and
shared boot volume. Control-plane replicas can be tested with Compose scaling,
but the bundled ingress and database sizing remain a single-host deployment;
load-test before treating extra replicas as an availability SLA.

Alert operationally on prolonged unhealthy/restarting services, a growing
retirement queue, repeated `connection_closed` failures, non-empty active spool
after recovery, quarantine growth, PostgreSQL/MinIO capacity, and managed Tool
Pods that outlive their command deadline. Quarantine is retained
as audit evidence and has no automatic garbage collection in this slice.

## Backup and restore

The supported recovery point is a cold, encrypted bundle. Stop accepting work,
wait for all active turns to settle or cancel them, then stop the topology
without removing volumes:

```bash
npm run production:down
npm run production:backup -- \
  --output /secure/off-host/agent-dock-2026-07-20.adbackup \
  --passphrase-file /secure/keys/agent-dock-backup.passphrase
npm run production:up
```

The passphrase file must be a non-symlink regular file, mode `0600`, containing
20–4096 bytes. Generate and store it independently from the backup. The command
refuses a running Compose project or an existing output, archives the runtime
plus all seven named volumes, records sizes/SHA-256, Git status/revision, image
version, and exact local image IDs, then encrypts and authenticates the complete
payload with AES-256-GCM and a scrypt-derived key. Treat both backup and key as
sensitive; storing them together removes the intended protection.

Restore only into a new project name and an absent or empty runtime path, after
installing the recorded checkout and exact local images:

```bash
npm run production:restore -- \
  --input /secure/off-host/agent-dock-2026-07-20.adbackup \
  --passphrase-file /secure/keys/agent-dock-backup.passphrase \
  --runtime-dir /srv/agent-dock-restored \
  --project-name agent-dock-restored \
  --confirm-empty

AGENT_DOCK_RUNTIME_DIRECTORY=/srv/agent-dock-restored \
COMPOSE_PROJECT_NAME=agent-dock-restored \
npm run production:up
```

Restore authenticates the payload before use, rejects unsafe paths, verifies
every authority hash and exact image ID, recreates only the seven new project
volumes, rebinds the runtime path, hardens permissions, and validates Compose.
It never overwrites an existing container, volume, or non-empty runtime. After
startup verify both tenant views, event cursor continuity, current Workspace
version/Artifact reads, Supervisor retirement, and one new completed turn before
admitting traffic. `npm run production:check` performs this complete drill on a
disposable populated topology.

For larger installations, use `pg_dump` plus an S3-native versioned/replicated
bucket and a coordinated ledger/spool snapshot instead of raw volumes. A logical
database dump without the matching object namespace is incomplete, because
PostgreSQL stores independent hashes and pointers while MinIO stores bytes.

If the ledger/spool cannot be restored, do not fabricate owner proof or delete
leases manually; preserve the database and perform an explicit incident
reconciliation.

## Upgrade and rollback

Before an upgrade, read the new ADRs/migrations, take the coordinated backup
above, and preserve the old images. Then:

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run production:deploy
npm run production:ps
```

`production:deploy` rebuilds pinned images and runs the idempotent migration and
bootstrap jobs before the long-running services become ready. Recreating the
Supervisor host intentionally creates a fresh boot/sandbox generation; the old
boot is fenced and retired, and settled sessions restore from PostgreSQL/MinIO.

Database migrations are forward-moving. A container-image rollback is not a
safe schema rollback by itself. Restore the coordinated pre-upgrade recovery
point when a migration is incompatible, or use a migration-specific rollback
procedure that has been separately tested. Never point an older binary at an
unknown newer schema merely because its container starts.

## Credential rotation

Processes read mounted secrets only at startup. Rotate during a maintenance
window, with a coordinated backup and no active turns:

- Tenant API credentials: issue a replacement with `production:tenant`, verify
  it through `/v1/identity`, then revoke the old credential by ID. The initial
  `secrets/api-token` remains bootstrap identity material and is not mounted by
  the running control plane; revoking its database credential does not make a
  later idempotent deployment recreate or re-enable it.
- Platform provider API key: the platform operator replaces the source binding
  through the authenticated API. One transaction creates immutable binding
  versions for the source and every browser-account tenant; accepted Turns keep
  their old snapshot and future Turns use the new version. Retained old versions
  are deliberate recovery state and need a future reference-aware retention job
  before deletion. Manually managed API-only tenants are not silently enrolled
  in this propagation set.
- Model-credential master key: do not replace this file independently. Current
  ciphertext is bound to key version 1 and no online re-encryption procedure is
  implemented. Rotate only through a separately tested decrypt/re-encrypt
  migration, or restore the original key with its matching database.
- Enrollment and management tokens: replace the matching files atomically in
  both consumers and recreate the control plane and Supervisor host together.
  The host restart creates a fresh boot credential and revokes the old one.
- PostgreSQL or MinIO credentials: change the backing service credential and
  every matching client secret as one operation. MinIO has separate root and
  checkpoint-application credentials; preserve that split and reattach the
  bucket-scoped no-delete policy. Because database and application credentials
  are embedded in `database-url` and `aws-credentials`, partial rotation will
  make services unready. Test this procedure on a restored copy first.

Every replacement must remain a bounded, non-symlink regular file with mode
`0600`; its parent directory must remain `0700`. Do not place secret values in
Compose environment variables, command arguments, Git, issue trackers, or logs.

## Reproducible production acceptance

Before the full topology gate, the isolated execution plane can be reproduced
without model tokens:

```bash
npm run sandbox:check
```

This builds and imports the Tool image, validates the RuntimeClass/containerd
handler, attests runsc/KVM and the live gVisor kernel, and checks scoped RBAC,
effective Pod/resource policy, network isolation, `/proc`/credential
absence, cross-tenant workspaces, path/symlink defense, bounded output,
cancellation, cleanup, and the real Pi remote-tool repair loop.

Run the destructive acceptance topology separately from a real deployment:

```bash
npm run production:check
```

The command creates a random project name, private temporary runtime, random
loopback port, fresh volumes, and fresh credentials. It builds images, starts
real PostgreSQL and MinIO, enables bounded self-registration, and proves invalid
and duplicate requests, atomic owner creation, plus a real concurrent race at
the total-tenant cap (exactly one success and one `429`). It issues a viewer,
proves owner/viewer conversation reads, cross-tenant conversation/UUID/SSE
isolation, per-role authorization, tenant-prefixed S3 checkpoints, a
tenant-neutral control-plane container, public/internal authentication and port
isolation, reruns both bootstrap jobs to prove idempotency and the bucket-scoped
no-delete credential, repairs Java, interrupts and reconnects the control plane,
verifies ambiguous-command failure and spool quarantine, scales the control plane from
one to two and back, restores a follow-up from S3, restarts the Supervisor into
a fresh boot, reconciles the old boot, cancels a live Tool Pod, audits the
execution boundary (no application owns a runtime socket; the Manager has only
scoped Kubernetes authority; Tool Pods are host-mount-free, credential-free,
and networkless), verifies non-root host-UID
portability and secret absence, and replays 22 durable ordered events. It then
exercises the built Web/Session inspector API surface, safe file and patch
reads, Run usage/tests/context, owner activity, and fork/archive/rollback. The
gate finally shuts the populated stack down, creates an authenticated encrypted
seven-volume backup, restores it under a new random Compose project, verifies
both tenants and all 22 events, completes another Pi turn, and removes both
projects' exact containers, networks, volumes, and runtime paths.

Never set `AGENT_DOCK_PRODUCTION_CHECK_KEEP=1` in shared CI. That diagnostic
option intentionally leaves the isolated topology and its secret directory for
manual inspection. `AGENT_DOCK_PRODUCTION_CHECK_SKIP_BUILD=1` is only for local
iteration after the exact images have already been built; release evidence must
use the default full-build path.

After the deployment acceptance passes, run the complete repository gate:

```bash
npm run ci
```

For a release, build from the clean commit and produce local checksummed
supply-chain evidence:

```bash
AGENT_DOCK_IMAGE_VERSION=0.1.0 npm run production:build
AGENT_DOCK_IMAGE_VERSION=0.1.0 npm run release:evidence -- \
  --output-dir dist/release-evidence-0.1.0
```

The command verifies every image's OCI version/full-revision labels and exact
image ID, writes a production-dependency CycloneDX SBOM, one CycloneDX SBOM and
complete HIGH/CRITICAL vulnerability report per image, a manifest, and
`SHA256SUMS`. A digest-pinned Trivy runs against read-only image archives with no
Docker socket and blocks any fixable HIGH or CRITICAL finding. The worktree must
be clean unless `--allow-dirty` is explicitly used for diagnosis; dirty evidence
is marked and must not be published as a release. The matching CI matrix uses
commit-pinned SBOM, scanner, and artifact Actions. See
[the release process](RELEASE_PROCESS.md) for review and retention policy.

Together these commands are the executable boundary for the supported private
multi-tenant production slice. They deliberately stay on the deterministic
profile and spend no provider quota. A release that changes the real-provider
or GitHub-import path also needs the explicit opt-in live check below against an
already deployed test tenant whose active profile is real:

```bash
AGENT_DOCK_LIVE_GITHUB_CHECK=1 npm run production:github-check
```

By default it imports the pinned tiny public repository recorded in the script,
creates a session, runs two real Pi turns, requires completed tool calls and
cumulative patches containing new files, confirms positive per-turn token
usage, proves the source object's key/hash/size/update timestamp did not change
between turns, and confirms no importer Pod survived. Override the source
only with both `AGENT_DOCK_LIVE_GITHUB_REPOSITORY=owner/repository` and
`AGENT_DOCK_LIVE_GITHUB_COMMIT_SHA=<40-hex-sha>`. The check can consume provider
quota and modify the configured tenant by adding a project/session; it is
therefore guarded and excluded from routine CI. During release validation,
confirm the Pi runtime remains inside the trusted non-root Supervisor, that no
application owns a Docker/containerd socket, that the Manager's Kubernetes
credential remains limited to two execution namespaces plus one named
RuntimeClass read, and that the transient Tool Pod has
default-deny networking and no credential-bearing environment or mount. Rotate or
revoke a temporary test key afterward. Any broader claim requires its own ADR,
threat model, and acceptance evidence.
