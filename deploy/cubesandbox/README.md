# CubeSandbox primary execution plane

This directory is the operator path for AgentDock's ordinary Tool runtime.
`CubeSandboxProvider` is selected only by trusted deployment configuration; a
browser user, tenant, model response or Tool Call cannot choose it or request a
lower-security fallback.

The integration is pinned to
[`TencentCloud/CubeSandbox` v0.6.0](https://github.com/TencentCloud/CubeSandbox/tree/v0.6.0)
at commit `8721dd151971ce3c2966482bbd32904ad98f378e`. Cube is a separate
CubeAPI/CubeMaster/Cubelet/CubeShim KVM control and execution plane, not a
Kubernetes `RuntimeClass`.

```text
Browser
   │
Control Plane
   │ durable Run
Trusted Pi Worker pool
   │ narrow Tool RPC
Sandbox Manager
   │ fixed-target CubeAPI/CubeProxy relays
CubeMaster / Cubelet
   │
per-RunAttempt KVM Tool microVM
```

Pi, model authentication and conversation state remain in the trusted Worker
pool. Only the credential-free Tool Worker and Workspace enter Cube.

## Deployment profiles

The checked-in installer supports a single-node local validation profile on
the current WSL2/K3s host. It is useful for development and produces real KVM
isolation evidence, but it is not a multi-node production claim.

A public or business-critical deployment should follow the upstream
[installation](https://cubesandbox.com/guide/kubernetes/install),
[architecture](https://cubesandbox.com/guide/kubernetes/architecture) and
[upgrade](https://cubesandbox.com/guide/kubernetes/upgrade) guidance and use:

- separate control and dedicated compute nodes;
- KVM on bare metal or a deliberately prepared PVM compute node;
- XFS-backed `/data/cubelet`;
- private CubeAPI/CubeProxy routing and firewalls;
- rehearsed control-node, compute-node, storage and rolling-upgrade drills.

Only CubeAPI TCP 3000 and CubeProxy TCP 80/443 should be privately reachable
from AgentDock. Do not expose CubeMaster, MySQL, Redis, Cubelet, CubeProxy admin
ports or the Kubernetes API.

## 1. Initialize private runtime state

Run the normal production initializer first. The Cube initializer creates a
mode-0600 Cube API key with the same non-root owner as the other application
secrets:

```bash
npm run production:init
npm run cubesandbox:init
```

No key, traffic token or provider credential belongs in `.env`, source
control, Pi messages or a Tool microVM.

## 2. Install the pinned local Cube plane

Installation mutates K3s and requires root. On the validated WSL2 host it also
creates a stable `agentdock0` dummy node interface with MTU 1500 and enforces
Flannel/Pod MTU 1450:

```bash
sudo --preserve-env=PATH \
  node scripts/install-cubesandbox-k3s.mjs
```

The installer:

- verifies `/dev/kvm`, K3s, Helm and the exact upstream checkout;
- rejects an unauthenticated CubeAPI;
- installs the pinned chart and private template registry;
- rolls Cube components after a node-network change;
- verifies Cube workload interface MTU instead of trusting YAML alone;
- writes private, bounded cluster evidence to
  `deploy/production/runtime/cubesandbox/cluster.json`.

Do not bind Flannel to WSL's loopback device. Its 65536-byte MTU advertises an
unusable jumbo MSS and black-holes ordinary CubeProxy responses once packets
exceed the real path MTU.

## 3. Commit, build and register the immutable Tool template

Template identity is tied to a clean, committed AgentDock revision. After code
and documentation are committed:

```bash
sudo --preserve-env=PATH \
  node scripts/register-cubesandbox-tool-template.mjs
```

The registration command:

1. builds `deploy/cubesandbox/Dockerfile.tool` from the exact Git revision;
2. runs the local Tool protocol compatibility gate;
3. pushes the image to the private registry and resolves its digest;
4. registers only port 49984 and probe `49984 /health`;
5. waits for CubeMaster to report the template `READY`;
6. records the revision, image digest, template ID and spec SHA-256 in the
   private `runtime/cubesandbox/template.json`.

The image contains Node 24, Java 17, Python 3.11 and Git 2. It replaces Cube's
inherited entrypoint so root `envd` is not started; otherwise that daemon would
create a second command/file channel outside AgentDock's Tool Broker.

## 4. Run the real KVM gate

The live gate requires CubeAPI plus at least two real platform endpoints that
are reachable from the trusted host but forbidden from a Tool guest:

```bash
AGENT_DOCK_CUBESANDBOX_TEST=1 \
AGENT_DOCK_IMAGE_REVISION="$(git rev-parse HEAD)" \
AGENT_DOCK_CUBESANDBOX_API_URL="http://<cube-api>:3000" \
AGENT_DOCK_CUBESANDBOX_API_KEY_FILE="deploy/production/runtime/secrets/cubesandbox-api-key" \
AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID="<ready-template-id>" \
AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP="<cube-proxy>" \
AGENT_DOCK_CUBESANDBOX_PROXY_PORT=80 \
AGENT_DOCK_CUBESANDBOX_FORBIDDEN_ENDPOINTS="<control-plane>:8080,<postgres>:5432" \
npm run cubesandbox:live-check
```

The gate creates real microVMs for two tenants and proves:

- a guest kernel distinct from the host and `cubesandbox-kvm` evidence;
- uid/gid 1000, no new privileges and zero effective capabilities;
- no Docker socket, Kubernetes token or platform/model credential;
- same-path canaries remain different across tenant Workspaces;
- CubeAPI, platform endpoints and public Internet are denied;
- path, symlink, output, timeout and process limits;
- content-hashed Workspace capture;
- cancellation destroys the executing guest;
- zero remaining AgentDock activation in Cube inventory.

The local Docker template check is compatibility evidence only. It must never
be reported as KVM isolation evidence.

## 5. Deploy the product

Normal production commands now select Cube automatically:

```bash
npm run production:config
npm run production:build
npm run production:up
npm run production:ps
```

`production:deploy` also initializes Cube's private runtime state. Startup
fails closed when cluster evidence, template status, image digest, template
specification or AgentDock Git revision does not match.

The primary Compose overlay starts two credential-free fixed-target relays.
The Sandbox Manager remains on internal networks, holds the Cube API key from
the private file, and forces every create request to disable Internet and public
traffic. The per-microVM Cube traffic token remains inside the trusted Provider.

The K3s/gVisor plane remains available only to the exact-commit importer and
the explicit deterministic production gate. It is not an ordinary Tool
fallback. Cube currently rejects project recipes with `dependencyHosts` until
temporary setup egress followed by a demonstrably fresh offline guest is
implemented and accepted.

## Lifecycle and rollback

Cube is not a data authority. Conversation state and content-verified
Workspace checkpoints commit through PostgreSQL/object storage. Cube v0.6.0
does not provide the metadata CAS required for safe higher-fence warm rebind,
so each completed, failed, cancelled or timed-out Tool Run destroys its guest;
a later Run restores the committed Workspace into a new guest.

Operational inspection and teardown remain available even if the source
revision has advanced beyond the last registered template:

```bash
npm run production:ps
npm run production:logs
npm run production:down
```

Starting or restarting requires a READY template for the current commit.
Before uninstalling Cube, verify its inventory has no AgentDock activation.
Removing the chart does not automatically revert node labels, taints,
`/data/cubelet` data or any PVM host-kernel change.
