# One-host production deployment

The supported one-host profile targets x86_64 Debian/Ubuntu or WSL2 with
systemd, KVM and enough CPU/RAM for Cube microVMs.

```bash
./install.sh
```

The installer pins the host tools, prepares Cube/K3s and Volume Plugin,
generates private runtime secrets, builds images, migrates PostgreSQL and starts
the application. It is resumable and supports a read-only preflight:

```bash
./install.sh --check-only
```

Open `http://127.0.0.1:8080`, register the designated administrator and set the
model provider/key in the administrator page.

The installer also creates a private Workspace-terminal service credential.
Users open the terminal from the Workspace panel; there is no SSH listener or
manual Cube credential to configure.

## Services

The default topology includes PostgreSQL, Kafka, Valkey, Event Gateway,
Control Plane, two trusted Pi Workers, Tool Broker, persistent Workspace Volume
gateway, Cube integration, provider proxy and Web. Observability and GitHub
experiments are optional profiles.

Temporal, MinIO and Kopia are not installed.

## Operations

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:down
npm run production:backup
npm run production:restore
```

Offline backups contain PostgreSQL, retained Kafka events, the Valkey hot view,
the generated runtime configuration, Worker boot ledgers and the local
persistent Workspace Volume directory. Kafka remains the recovery source for
the rebuildable Valkey view. On distributed
storage, use the storage backend's snapshot/backup mechanism in addition to the
PostgreSQL backup.

## Acceptance

```bash
npm run production:check
npm run production:worker-pool-check
npm run production:control-plane-restart-check
PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 npm run production:long-context-check
```

The first command requires explicit live-model/Cube acknowledgement and consumes
tokens. It verifies pure chat without Cube, multi-round Tool use, persistent
Volume reuse across a fresh KVM, tenant isolation and cleanup.

The long-context gate is intentionally expensive. It runs real coding tasks
until Pi compacts its native Session, verifies early-context recall and
post-compaction Tool use, and then stops the owning Worker to prove recovery on
another Worker.

The generated runtime directory contains credentials and must remain mode 0700;
individual secrets must remain private regular files. Do not commit it.
