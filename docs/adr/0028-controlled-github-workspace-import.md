# ADR-0028: Controlled public GitHub workspace import

- Status: accepted
- Date: 2026-07-19
- Extends: ADR-0021 checkpoint storage, ADR-0023 trusted Supervisor topology,
  and ADR-0027 brokered Pi execution

## Context

AgentDock can now run a real Pi coding turn, but every new workspace is copied
from one image-owned Java fixture. A useful coding-agent service must accept user
code without giving Pi or its shell unrestricted Internet access, mounting the
operator's home directory, or allowing a caller-controlled URL to turn the
trusted runtime into an SSRF proxy.

The existing workspace manifest already rejects absolute/traversing paths,
links and special files, more than 512 files, files larger than 512 KiB, and a
manifest larger than 2 MiB. PostgreSQL also has an unused
`workspaces.object_snapshot_key`, and the trusted Supervisor already owns the
bounded immutable S3 object-store interface. Those boundaries should become the
workspace provisioning primitive.

## Decision

### Source contract

1. A project source is either the existing `sample_java` fixture or
   `github_public`. A GitHub source contains only a normalized `owner/repository`
   coordinate and an exact lowercase 40-hex commit SHA. The API does not accept
   a URL, hostname, port, branch/tag, refspec, query string, username, password,
   token, SSH form, local path, or Git configuration.
2. The control plane derives source scope from the authenticated tenant and
   writes the project, workspace, and source row in one transaction. The source
   row is immutable after creation except for its import state, lease, safe
   failure code, and verified object metadata. Foreign workspace IDs remain
   indistinguishable from absent IDs.
3. Existing projects and newly registered tenants retain `sample_java` by
   default. The public conversation resource returns only the safe source kind,
   repository coordinate, commit SHA, and import status.

### Isolated import

4. The trusted Supervisor, not the control plane or Pi worker, coordinates the
   first import. PostgreSQL grants one expiring import lease for the exact
   tenant/project/workspace. Concurrent first turns wait for the winner's ready
   snapshot rather than cloning independently. An expired lease may be reclaimed;
   only its exact owner may publish success or failure.
5. Git runs in a separate one-shot, non-root, read-only Docker container. It has
   no bind mount, Docker socket, deployment/provider credential, published port,
   or membership in the database, object-storage, management, model-runtime, or
   provider-egress networks. Its only writable storage is bounded tmpfs, and its
   only network is a dedicated repository-egress bridge. The trusted Supervisor
   anchors that bridge in the bundled Compose topology; its reachable endpoints
   remain authenticated, and the importer has neither management credentials nor
   a model-gateway capability. The importer is not an agent and receives no
   prompt or tool authority.
6. The import worker constructs exactly
   `https://github.com/<owner>/<repository>.git`, disables redirects, hooks,
   submodules, external/file protocols, credential helpers, interactive prompts,
   symlinks, and LFS smudge execution, fetches only the requested commit with
   bounded depth/no tags, verifies `HEAD`, removes `.git`, and runs the existing
   workspace-manifest capture. Unsupported or oversized repositories fail closed
   with a safe code.
7. A Docker bridge is not a domain firewall. The fixed Git invocation and lack
   of caller-controlled URL/commands are the application restriction; a future
   hostile-SaaS design should additionally use a DNS-aware egress proxy or
   network policy and stricter isolation from trusted service surfaces. No claim
   here treats arbitrary repository bytes as trusted.

### Immutable provisioning and activation

8. The captured canonical manifest is addressed by its SHA-256 under a
   tenant/workspace-prefixed object key. S3 creation is immutable. A retry that
   finds the deterministic object already present must read and verify identical
   bytes before reusing it. PostgreSQL records key/hash/size and atomically moves
   the workspace source to `ready`.
9. Every activation resolves that original snapshot through PostgreSQL plus S3
   and verifies key, hash, size, and manifest again. The Pi container receives
   the bounded snapshot through its typed stdin protocol, establishes a local
   baseline Git commit, and then overlays any settled session checkpoint. This
   preserves cumulative diff semantics without re-cloning and keeps follow-up
   turns available when GitHub is down.
10. Pi workers keep their existing network policy: fake turns use no network;
    real-model turns have only the internal model gateway. They never join the
    repository-egress network. Imported repository files may influence the model
    and tools, but cannot directly change the worker image or receive credentials.

### Product and test boundary

11. The Web exposes an explicit new-workspace panel with sample/GitHub choices.
    It explains that commit SHA is immutable and validates the coordinate/SHA
    before submission. Import begins on the first turn; `pending`, `importing`,
    `ready`, and safe `failed` states remain observable through project details.
12. Routine CI and the disposable production acceptance remain independent of
    GitHub and paid models. Unit/integration tests use a fake importer and object
    store plus Docker argument/protocol checks. One explicit opt-in live test
    must import a public repository at an exact commit and complete a real Pi
    tool/edit/test-or-verification turn with a non-empty diff and token ledger.

## Executable acceptance criteria

The slice is complete only when tests and the live check prove:

1. invalid URL/ref/credential-shaped input and extra fields are rejected;
2. project/source creation is atomic, tenant-scoped, quota-aware, and defaults
   existing callers to the fixture;
3. one import lease wins, expired leases are reclaimable, stale owners cannot
   publish, and ready snapshots are hash/size/manifest verified;
4. importer Docker arguments contain the dedicated egress network and hardening
   limits but no tenant credential, provider key, host mount, or published port;
5. redirects, submodules, symlinks, oversized paths/files/count/manifest, wrong
   commit, malformed protocol, timeout, cancellation, and dirty cleanup fail
   closed;
6. the imported baseline reaches pinned Pi, settled checkpoints restore without
   another clone, and the final Git patch is relative to the imported commit;
7. the production topology stays healthy, fake workers remain networkless, real
   workers remain gateway-only, and no importer/managed worker survives a turn.

## Consequences

- AgentDock becomes useful on real public source while retaining an auditable,
  narrow import boundary.
- This is deliberately not private Git hosting. GitHub App/OAuth installation
  tokens, SSH, arbitrary hosts, monorepos beyond current limits, submodules, LFS,
  sparse selection, branch refresh, pull requests, and write-back are separate
  milestones.
- The first turn can spend import time before Pi starts. Later turns use the
  immutable S3 seed and session checkpoint, so cold-session density remains
  independent of idle processes and GitHub availability.
- Repository contents remain untrusted prompt/tool input. The existing Docker
  host is still not a mutually hostile public-tenant boundary.

## Rejected alternatives

### Let Pi run `git clone`

That gives arbitrary prompt-controlled tools provider-independent Internet
egress and makes repository acquisition impossible to distinguish from data
exfiltration.

### Accept any HTTPS URL and block private IPs

DNS rebinding, redirects, alternate encodings, proxy behavior, and future Git
protocol features make that much broader than the needed first slice. A fixed
GitHub coordinate is easier to validate and explain.

### Clone in the Supervisor process

Parsing attacker-selected packs and writing paths inside the Docker-owning,
credential-bearing host needlessly enlarges the trusted process. A disposable
credential-free importer contains that parser and filesystem boundary.

### Re-clone on every turn

That makes checkpoint recovery depend on a mutable external service and wastes
latency/bandwidth. The original immutable seed belongs in the existing object
store and is reverified on each activation.
