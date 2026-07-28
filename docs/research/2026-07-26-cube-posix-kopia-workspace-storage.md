# Cube POSIX and Kopia Workspace storage research

Date: 2026-07-26

## Question

Can AgentDock replace node-local Cube snapshot authority with Cube's supported
volume path, mature snapshot software and its existing PostgreSQL
fencing/CAS protocol?

## Official-source findings

### CubeSandbox v0.6 Volume Plugin

Cube's official Volume Plugin contract is a close fit:

- CubeMaster invokes controller `Create` and `Destroy` hooks.
- Cubelet invokes node `Attach` and `Detach` hooks.
- `POST /volumes` creates a durable volume record.
- `POST /sandboxes` accepts `volumeMounts: [{name, path}]`.
- the node hook returns a `hostPath` below
  `volume_plugin_base_dir`, which Cubelet exposes to the microVM through its
  storage path.
- the same driver name and binary must be configured in CubeMaster and Cubelet.
- Cube explicitly describes NFS and other shared backends as valid plugin
  targets, but the v0.6 repository only ships COS as a full reference plugin.

AgentDock therefore needs a bounded pre-mounted POSIX plugin, not a second
storage orchestrator. In production the configured base directory is an
external POSIX shared mount present on every Cube node. In local development it
is a host directory.

Source:
<https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/volume-plugin.md>

### Kopia

Kopia is Apache-2.0 and actively released. Version `0.23.1` was released on
2026-06-16. It supports encrypted, compressed, deduplicated snapshots,
S3-compatible repositories, restore and full file verification.

Kopia's repository server access controls are not used as AgentDock's tenant
security boundary: official documentation notes that clients that know object
IDs can read repository objects. AgentDock instead keeps all repository
authority inside one trusted, narrow data-mover service. Tenant isolation is
enforced before a Kopia command is constructed, and untrusted sandboxes never
connect to that service or repository.

The production image builds the no-UI CLI from the immutable `v0.23.1` source
tag. The upstream release image was originally pinned, but its binary was
compiled before fixes for Go `CVE-2026-39822` and gRPC
`GHSA-hrxh-6v49-42gf` were available. The source rebuild uses the already
pinned Go `1.26.5` builder and raises only gRPC to its first fixed release:

```text
kopia/kopia source: v0.23.1
release commit: 72ec08fd8edb86c67ed27099bf1b955e1f308ffa
google.golang.org/grpc: v1.82.1
golang:1.26.5-alpine3.23
sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc
```

Sources:

- <https://github.com/kopia/kopia>
- <https://github.com/kopia/kopia/releases/tag/v0.23.1>
- <https://kopia.io/docs/repositories/>
- <https://kopia.io/docs/reference/command-line/common/snapshot-create/>
- <https://kopia.io/docs/reference/command-line/common/snapshot-restore/>
- <https://kopia.io/docs/advanced/consistency/>

## Adopt/build decision

Adopt Kopia for snapshot bytes, verification, compression, encryption and
deduplication. Build only:

1. the official Cube binary-plugin adapter for a pre-mounted POSIX backend;
2. a narrow authenticated data-mover API that validates AgentDock identity and
   invokes pinned Kopia without a shell; and
3. the checkpoint-reference codec that binds Kopia output to the existing
   fenced Workspace commit.

PostgreSQL remains the only Workspace-head authority. Cube and Kopia do not
become competing schedulers or metadata authorities.
