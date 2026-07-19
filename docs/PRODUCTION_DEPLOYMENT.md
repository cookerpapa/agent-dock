# Production deployment runbook

This runbook deploys AgentDock's currently supported production slice on one
Linux Docker host. The result is a durable, authenticated, private multi-tenant
service with PostgreSQL metadata, MinIO checkpoint bytes, a tenant-neutral
remote control plane, one shared trusted Supervisor host, isolated one-shot Pi
workers, and a static Web UI. Multiple tenants can share this runtime without
sharing their API resources, event streams, quotas, or checkpoint namespaces.
An operator may explicitly enable capacity-bounded anonymous registration to
make that isolation easy to test from two browser contexts.

The word _production_ here means that this bounded slice has explicit
configuration, durable storage, health checks, restart behavior, security
boundaries, and a destructive disposable acceptance test. It does not turn the
service into a general coding-agent SaaS. A workspace may use the image-owned
Java repair fixture or a small public GitHub repository pinned to an exact
commit. A tenant owner may keep the default deterministic model or configure an
allowlisted DeepSeek model and encrypted API key. It does not support arbitrary
Git URLs, private repositories, arbitrary provider URLs, policy-approved third-
party extensions, public Internet SaaS, Kubernetes, or direct Internet exposure.
The optional registration route is not verified
human identity, billing, OIDC, recovery, abuse prevention, or a mutually
hostile Docker-host boundary. Those limits are part of the product contract,
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

## Prerequisites

- A Linux Docker host. The trusted Supervisor uses the Linux Docker socket and
  the worker's POSIX process-group cancellation semantics.
- Docker Engine with the Compose plugin. The acceptance topology is currently
  exercised on Docker Engine `29.4.2` and Compose `5.1.3`.
- Node.js `24.12.0` and npm `11.6.2` for the repository scripts. The built
  application images pin their own Node and service image digests.
- Enough local CPU, memory, and storage for PostgreSQL, MinIO, four application
  images, and up to two concurrent workers. The Compose file declares explicit
  per-service limits; capacity should be measured against the intended host.
- A private checkout and a trusted operator account. Anyone who can read the
  generated runtime directory or access the Docker socket is inside the trusted
  computing base.

Do not use a shared untrusted Docker socket or an unreviewed rootless/remote
Docker context without separately validating its socket ownership, mount, and
process-containment behavior.

## First deployment

Install the exact lockfile without running package lifecycle scripts, then run
the idempotent deployment entry point:

```bash
npm ci --ignore-scripts
npm run production:deploy
```

Registration is disabled by default. For a new loopback deployment that should
allow browser-created tenants, set the bounded values before the first command;
initialization validates and persists them in the private runtime `.env`:

```bash
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true \
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32 \
npm run production:deploy
```

The first invocation creates `deploy/production/runtime/`, generates private
random credentials and stable logical IDs, builds all four pinned application
images, migrates and bootstraps PostgreSQL, creates a private checkpoint bucket,
and waits for every long-running service to become healthy. A completed runtime
directory is reused on later invocations. A non-empty partial directory is
rejected rather than silently replacing credentials.

The default ingress is `http://127.0.0.1:8080`. Obtain the initial bootstrap
owner token only on the trusted host:

```bash
npm run production:token
```

Open the ingress URL, paste the token into the login card, and submit the
supported Java-repair prompt. New tenants start on the deterministic zero-token
profile. To use a real model, an owner opens `model`, selects an allowlisted
DeepSeek model, pastes that tenant's API key, and saves it before creating the
turn. Future turns for that tenant then spend its provider quota until the model
configuration is replaced. The browser first resolves `/v1/identity`, shows
the tenant, user, and role, and keeps the token only in JavaScript memory—not in
Web Storage, a URL, or a durable server-side session. Reloading or logging out
therefore requires the token again. The token command intentionally
writes a secret to stdout, so do not run it in CI logs, shell tracing, a screen
recording, or an untrusted terminal multiplexer.

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
                                      |              |
                                      |              +-> PostgreSQL
                                      |              +-> outbound Supervisor WebSocket
                                      v
                              trusted Supervisor host -> MinIO checkpoints
                                      |         |
                                      |         +-> fixed provider API (egress only here)
                                      |
                                      +-> Docker socket -> ephemeral Pi worker
                                                           | fake: no network
                                                           + real: internal gateway only
```

The database, object store, Supervisor management endpoint, boot-provisioning
route, readiness endpoints, and outbound Supervisor transport stay on isolated
Compose networks. Caddy returns `404` for `/internal/*` and `/health/*`; it only
proxies `/v1/*` and serves static assets. Liveness is exposed as `/healthz` and
contains no dependency detail.

The trusted `supervisor-host` container is deliberately root-equivalent because
it owns `/var/run/docker.sock`. Neither the control plane nor any Pi worker gets
that socket. Workers are created per active turn, not per conversation: they run
as UID/GID `1000:1000`, with no host bind mount, inherited long-lived deployment
secret, published port, or writable root filesystem, and are removed after
completion or cancellation. A fake worker has `--network none`. A real worker
joins only the internal `model-runtime` network and receives an expiring,
turn-bound gateway capability; only the Supervisor also joins provider egress
and decrypts the real key. Cold sessions consume no process, worker container,
socket, timer, or dedicated thread.

Persistent state is split into four declared volumes:

- `postgres-data`: tenants, encrypted model credentials, token usage, sessions,
  commands, leases, events, checkpoint metadata, Supervisor generations, and
  retirement work;
- `minio-data`: immutable Pi JSONL and workspace checkpoint bytes;
- `supervisor-boot`: fsynced current/recent boot ownership ledger;
- `supervisor-spool`: active unacknowledged event publications and permanently
  stale quarantine evidence.

PostgreSQL metadata and MinIO objects form one logical checkpoint. The boot and
spool volumes are also required for honest owner-stop proof and event recovery;
do not treat any one of these volumes as a complete backup by itself.

## Routine commands

```bash
npm run production:config   # validate interpolation without printing secrets
npm run production:build    # rebuild all application and worker images
npm run production:up       # start already-built images and wait for health
npm run production:ps       # show service state and health
npm run production:logs     # follow bounded container logs
npm run production:down     # stop the topology and preserve all four volumes
```

`production:down` is non-destructive. Do not append `--volumes` during normal
operation. Removing the Compose volumes permanently deletes the database,
checkpoint bytes, owner ledger, and spool evidence; take and verify a coordinated
backup first and resolve the exact Compose project/volume names with
`docker compose ls` and `docker volume ls` rather than using globs.

Container logs use Docker's bounded `json-file` policy: three files of at most
10 MiB per service. Logs contain safe component/state/error codes and opaque
identifiers, but operators should still grant log access as privileged
operational access.

## Opt-in self-service tenant registration

The only unauthenticated API exception is exact
`POST /v1/registrations`, and it exists only when
`AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true`. The Web login card's
`create tenant` tab submits a bounded slug and owner display name. A successful
transaction creates the tenant-local owner, deterministic model profile,
runtime policy, and indexed owner credential together, then shows the plaintext
token once. Save it immediately: PostgreSQL stores only its SHA-256 digest, and
there is no self-service password, email, or token-recovery flow.

The defaults written for a new runtime are:

```text
AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=false
AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=32
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS=10
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS=100
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS=10
AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS=1
```

The total-tenant cap includes the bootstrap tenant and any offline-created
tenants. Concurrent registrations serialize inside PostgreSQL, so successful
requests cannot race beyond it. A duplicate slug returns `409`; a full runtime
returns `429`; disabled registration returns `404`. Failed registration does
not retain a partial tenant or reveal a generated token.

For an existing deployment, edit
`deploy/production/runtime/.env` (or the selected external runtime's `.env`),
change only these bounded non-secret settings, then run
`npm run production:deploy`. Disabling it later prevents new self-service
tenants but does not delete or disable existing tenants. The registration form
may still be visible and will report the server's disabled response.

After login, `GET /v1/conversations` lists at most the newest 100 sessions for
the verified tenant, and `GET /v1/conversations/:sessionId` loads at most the
newest 200 prompt turns before the Web resumes that session's durable SSE
suffix. There is no tenant selector. A token from another tenant receives the
same `404` for that exact session UUID as it would for a nonexistent UUID.

This option is suitable for loopback/private functional validation. It has no
distributed rate limiter, CAPTCHA, verified identity, recovery, billing, or
hostile-public-customer sandbox claim. Do not treat enabling it as authorization
to publish the bundled HTTP endpoint on the Internet.

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

Switching tenants in the Web UI means logging out and presenting a credential
for the other tenant. There is no client-supplied tenant selector. The running
control plane does not mount the bootstrap/API-token file and has no configured
default tenant; it derives every public request scope from the verified token.

## Tenant model configuration

Every new tenant starts with the deterministic profile, so normal setup and
acceptance do not call a paid provider. After authenticating, any role may read
the safe `GET /v1/model-configuration` resource; only `owner` may replace it via
the Web model panel or `PUT /v1/model-configuration`. The replacement accepts
only `deepseek` plus the server allowlist shown by the UI. It does not accept a
provider URL or expose the key, ciphertext, digest, or gateway capability.

Saving a new key creates an immutable credential-binding version and switches
the tenant's default profile in one transaction. Repeating the same key/model is
content-idempotent. Already accepted turns keep their snapshotted version;
future turns use the replacement. The database stores AES-256-GCM ciphertext
whose associated data includes tenant, binding, version, provider, and master
key version. Provider-reported input, output, cache-read, and cache-write tokens
are written to `usage_ledger` for each model call. Monetary cost remains zero
until versioned provider pricing is modeled.

The Web clears the key field after submit and does not place it in Web Storage.
The trusted Supervisor decrypts the exact snapshotted version, gives the Pi
worker only a short-lived, request-limited turn capability, and revokes it when
the activation settles. The worker has no direct provider egress. Treat the
Supervisor, PostgreSQL, private runtime directory, and Docker authority as the
trusted computing base; this is not a mutually hostile public-SaaS sandbox.

## Controlled public GitHub workspaces

After login, open the `new workspace` panel. Keep `sample Java` for the bundled
fixture, or choose `public GitHub` and provide only:

- a lowercase `owner/repository` coordinate such as
  `mathewjonas/java-calculator-junit`; and
- the exact lowercase 40-hex commit SHA to preserve as the workspace baseline.

The API intentionally accepts no URL, branch, tag, credential, SSH form, Git
configuration, or arbitrary host. Project, workspace, and pending source state
commit in one tenant-scoped transaction. The first turn may take longer because
the Supervisor must win an expiring PostgreSQL import lease, start a hardened
one-shot importer, and publish the verified content-addressed seed to MinIO.
Concurrent first turns wait for that seed. Every later activation rechecks its
object key, byte count, SHA-256, and manifest, then overlays the last settled
session checkpoint; it does not clone again.

The importer has no bind mount, Docker socket, prompt, provider/deployment
credential, published port, or membership in the database, object-storage,
management, model-runtime, or provider-egress networks. It joins only the
repository-egress bridge. The trusted Supervisor also anchors that bridge in
this single-host topology, but all of its reachable privileged endpoints require
a credential or turn capability that the importer never receives. A fixed
GitHub URL is an application restriction, not a DNS firewall; do not claim this
as a mutually hostile public-tenant boundary.

Current repository limits are at most 512 regular files, 512 KiB per file, and
2 MiB for the canonical manifest. Absolute/traversing paths, symlinks, special
files, redirects, submodules, LFS filters, oversized content, and commit mismatch
fail closed. Private repositories, arbitrary Git hosts, branch refresh, sparse
checkout, pull requests, and write-back are not supported.

## TLS and network exposure

The bundled Caddy configuration intentionally serves plain HTTP on loopback. It
is safe for local-host access and for the disposable acceptance topology; it is
not an Internet ingress.

For remote access, keep AgentDock bound to loopback or a private network and put
a separately managed TLS reverse proxy or authenticated tunnel in front of it.
Preserve the `Authorization` header, disable proxy buffering for
`text/event-stream`, allow long-lived SSE reads, and keep `/internal/*`,
`/health/*`, PostgreSQL, MinIO, Supervisor management, and the Docker daemon
unreachable. Add host firewall rules and an identity-aware access layer if more
than the trusted operator can reach the endpoint. Binding
`AGENT_DOCK_HTTP_BIND_ADDRESS=0.0.0.0` without those controls is unsupported.

The included bearer credentials provide private tenant identity and three
coarse roles. The optional anonymous admission route does not turn them into
public account login, OIDC, CSRF-resistant cookie authentication, per-route
enterprise RBAC, rate limiting, billing, or abuse protection.

## Health and operations

Use `npm run production:ps` for the first health view. Expected steady state:

- `postgres`, `minio`, `control-plane`, `supervisor-host`, and `web` are healthy;
- `database-bootstrap` and `minio-bootstrap` exited successfully;
- no `sandbox-image` service is running;
- no container with `agent-dock.managed=true` remains after a turn settles;
- one current Supervisor boot is ready for the configured stable Supervisor ID.

The Supervisor is ready only after Docker, PostgreSQL, MinIO, provisioning,
spool recovery, and its current outbound WebSocket are ready. A transient
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
after recovery, quarantine growth, PostgreSQL/MinIO capacity, and managed worker
containers that outlive their command deadline. Quarantine is retained as audit
evidence and has no automatic garbage collection in this slice.

## Backup and restore

Back up all durable authorities as one recovery point:

1. Stop new ingress traffic and wait for active turns to settle or cancel them.
2. Run `npm run production:down`. This preserves the named volumes and gives a
   simple crash-consistent single-host boundary.
3. Snapshot or archive `postgres-data`, `minio-data`, `supervisor-boot`, and
   `supervisor-spool` together with the private runtime directory. Use the
   Docker/storage platform's documented named-volume backup mechanism; never
   copy PostgreSQL's live data directory while it is running.
4. Encrypt the backup, restrict it like production credentials, record the
   image version and Git commit, and test restoration on an isolated host.
5. Restart with `npm run production:up` and verify health.

For larger installations, use `pg_dump` plus an S3-native versioned/replicated
bucket and a coordinated ledger/spool snapshot instead of raw volumes. A logical
database dump without the matching object namespace is incomplete, because
PostgreSQL stores independent hashes and pointers while MinIO stores bytes.

Restore onto an isolated host in this order: restore the private runtime
directory and all four volumes, install the recorded checkout/image version,
run `npm run production:config`, then run `npm run production:up`. Verify boot
retirement, checkpoint restore, event cursor continuity, and absence of orphan
workers before admitting traffic. If the ledger/spool cannot be restored, do
not fabricate owner proof or delete leases manually; preserve the database and
perform an explicit incident reconciliation.

## Upgrade and rollback

Before an upgrade, read the new ADRs/migrations, take the coordinated backup
above, and preserve the old images. Then:

```bash
npm ci --ignore-scripts
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
- Tenant provider API keys: the tenant owner saves the replacement through the
  model panel. This creates a new immutable binding version; accepted turns keep
  their old snapshot. Retained old versions are deliberate recovery state and
  need a future reference-aware retention job before deletion.
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
no-delete credential, repairs Java, interrupts and reconnects the control plane, verifies
ambiguous-command failure and spool quarantine, scales the control plane from
one to two and back, restores a follow-up from S3, restarts the Supervisor into
a fresh boot, reconciles the old boot, cancels a live worker, audits worker
hardening, non-root host-UID portability, and secret absence, and replays 22
durable ordered events. It then removes only its exact random containers,
networks, volumes, and runtime path.

Never set `AGENT_DOCK_PRODUCTION_CHECK_KEEP=1` in shared CI. That diagnostic
option intentionally leaves the isolated topology and its secret directory for
manual inspection. `AGENT_DOCK_PRODUCTION_CHECK_SKIP_BUILD=1` is only for local
iteration after the exact images have already been built; release evidence must
use the default full-build path.

After the deployment acceptance passes, run the complete repository gate:

```bash
npm run ci
```

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
between turns, and confirms no importer container survived. Override the source
only with both `AGENT_DOCK_LIVE_GITHUB_REPOSITORY=owner/repository` and
`AGENT_DOCK_LIVE_GITHUB_COMMIT_SHA=<40-hex-sha>`. The check can consume provider
quota and modify the configured tenant by adding a project/session; it is
therefore guarded and excluded from routine CI. Inspect the real worker's sole
`model-runtime` network during release validation, and rotate or revoke a
temporary test key afterward. Any broader claim requires its own ADR, threat
model, and acceptance evidence.
