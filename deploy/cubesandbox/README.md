# CubeSandbox Provider experiment

This directory is the operator path for the optional
`CubeSandboxProvider`. The supported deployment remains Kubernetes + gVisor.
Cube is selected only by trusted deployment configuration; a browser user,
tenant, model response or Tool Call cannot choose it.

The integration is pinned and researched against
[`TencentCloud/CubeSandbox` v0.6.0](https://github.com/TencentCloud/CubeSandbox/tree/v0.6.0).
Cube's Kubernetes delivery is a separate Cube control/execution plane, not a
Kubernetes `RuntimeClass` for the existing AgentDock Tool Pod.

## Safety boundary

Do not install Cube on AgentDock's current single-node production K3s host.
The upstream chart uses privileged host preparation, requires KVM/PVM and an
XFS `/data/cubelet`, and may install a host kernel and reboot a PVM compute
node. A compute DaemonSet upgrade can interrupt every sandbox on that node.

Use a dedicated cluster with, at minimum:

- Kubernetes 1.24 or later and Helm 3.10 or later;
- a separate control node and dedicated compute node;
- 4 CPU / 8 GiB or more for control and 16 CPU / 32 GiB or more for compute;
- KVM on bare metal, or a deliberately prepared PVM compute node;
- XFS-backed `/data/cubelet` for production;
- private network reachability from the AgentDock host to CubeAPI and
  CubeProxy.

Read the upstream
[Helm install guide](https://cubesandbox.com/guide/kubernetes/install),
[architecture](https://cubesandbox.com/guide/kubernetes/architecture) and
[upgrade guide](https://cubesandbox.com/guide/kubernetes/upgrade) before
mutating a host.

## 1. Install a pinned dedicated Cube plane

Clone and verify the exact upstream release:

```bash
git clone --branch v0.6.0 --depth 1 \
  https://github.com/TencentCloud/CubeSandbox.git
cd CubeSandbox
test "$(git rev-parse HEAD)" = "8721dd151971ce3c2966482bbd32904ad98f378e"
```

Follow the upstream guide to label dedicated control/compute nodes and create
`runtime-values.yaml`. Create a random API key in a private file without a
trailing newline:

```bash
umask 077
openssl rand -hex 32 | tr -d '\n' > /secure/agent-dock-cube-api-key
kubectl create namespace cube-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n cube-system create secret generic agent-dock-cube-api \
  --from-file=api-key=/secure/agent-dock-cube-api-key
```

Merge this directory's
[`agent-dock-values.example.yaml`](./agent-dock-values.example.yaml) after the
upstream runtime values. It enables CubeAPI's simple-key authentication from a
Kubernetes Secret. CubeAPI accepts unauthenticated management requests when
neither `CUBE_API_KEY` nor `AUTH_CALLBACK_URL` is configured, so an
unauthenticated deployment is not accepted by AgentDock.

```bash
helm upgrade --install cube ./deploy/kubernetes/chart \
  --namespace cube-system \
  --create-namespace \
  --values runtime-values.yaml \
  --values /path/to/agent-dock/deploy/cubesandbox/agent-dock-values.example.yaml \
  --wait \
  --timeout 90m

kubectl get pods -n cube-system -o wide
helm test cube -n cube-system --timeout 20m --logs
```

Expose only the following over private routing or dedicated internal
LoadBalancer Services:

```text
CubeAPI:   TCP 3000
CubeProxy: TCP 80 or 443
```

Do not expose CubeProxy's admin port, CubeMaster, MySQL, Redis, Cubelet or the
Kubernetes API. Restrict both allowed source addresses to the AgentDock host.
If traffic crosses an untrusted network, use a private tunnel or properly
validated TLS. The supplied fixed relays deliberately do not implement a
general-purpose proxy.

## 2. Build and validate the AgentDock Tool image

From the AgentDock experiment branch:

```bash
export AGENT_DOCK_IMAGE_REVISION="$(git rev-parse HEAD)"
export AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE="registry.example/agent-dock-cube-tool:${AGENT_DOCK_IMAGE_REVISION}"

docker build --network host \
  --file deploy/cubesandbox/Dockerfile.tool \
  --build-arg "AGENT_DOCK_VERSION=experiment" \
  --build-arg "AGENT_DOCK_REVISION=${AGENT_DOCK_IMAGE_REVISION}" \
  --tag "${AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE}" \
  .

npm run cubesandbox:template-check
docker push "${AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE}"
```

The image pins the upstream Cube base image by OCI digest and contains the
credential-free AgentDock Tool Worker with Node 24, Java 17, Python 3.11 and
Git 2. The local template check executes a real file-write/counting-sort/test
and content checkpoint. It intentionally prints
`"isolationValidated": false`: Docker compatibility does not prove Cube KVM
isolation.

## 3. Register the immutable Cube template

Run the pinned `cubemastercli` from the Cube control plane. Prefer the pushed
image's digest (`image@sha256:...`) rather than a mutable tag:

```bash
kubectl exec -n cube-system deploy/cube-cubemastercli -- \
  sh -lc 'cubemastercli \
    --address "$CUBEMASTERCLI_ADDRESS" \
    --port "$CUBEMASTERCLI_PORT" \
    tpl create-from-image \
    --image "registry.example/agent-dock-cube-tool@sha256:<manifest-digest>" \
    --writable-layer-size 1G \
    --expose-port 49984 \
    --probe 49984 \
    --probe-path /health'
```

Record the returned `job_id` and `template_id`, then wait for READY:

```bash
kubectl exec -n cube-system deploy/cube-cubemastercli -- \
  sh -lc 'cubemastercli \
    --address "$CUBEMASTERCLI_ADDRESS" \
    --port "$CUBEMASTERCLI_PORT" \
    tpl watch --job-id <job-id>'
```

Preserve the READY output's template ID, template-spec fingerprint and
artifact SHA-256 with the release evidence. Register only port 49984 and use it
as the readiness probe. The image deliberately replaces Cube's inherited
entrypoint so root `envd` is not started: it would otherwise create a second
command/file channel outside AgentDock's Tool Broker. The inherited OCI
metadata still declares port 49983, so the compatibility gate verifies that
there is no listener on that port.

## 4. Run the live KVM gate before selecting Cube

The live gate refuses a superficial network test. In addition to CubeAPI, set
at least two real AgentDock platform endpoints that are reachable from the
trusted test host but must be unreachable from a Tool microVM, for example the
Control Plane and PostgreSQL private addresses:

```bash
export AGENT_DOCK_IMAGE_REVISION="<revision embedded in the Tool image>"
export AGENT_DOCK_CUBESANDBOX_API_URL="http://<private-cube-api>:3000"
export AGENT_DOCK_CUBESANDBOX_API_KEY_FILE="/secure/agent-dock-cube-api-key"
export AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID="<ready-template-id>"
export AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP="<private-cube-proxy>"
export AGENT_DOCK_CUBESANDBOX_PROXY_PORT="80"
export AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME="http"
export AGENT_DOCK_CUBESANDBOX_DOMAIN="cube.app"
export AGENT_DOCK_CUBESANDBOX_FORBIDDEN_ENDPOINTS="<control-plane-host>:8080,<postgres-host>:5432"

npm run cubesandbox:live-check
```

The gate creates real microVMs for two tenants and verifies:

- a distinct guest kernel and the `cubesandbox-kvm` evidence contract;
- uid/gid 1000, no new privileges and no effective capabilities;
- no Docker socket, Kubernetes token or platform/model credential;
- different content at the same Workspace path in the two microVMs;
- no public Internet, CubeAPI, Control Plane or PostgreSQL connection;
- content-hashed Workspace capture;
- cancellation destroys the executing microVM;
- no AgentDock activation remains in Cube inventory.

Do not set `isolationValidated=true` in release material unless this command
passes against the dedicated Cube plane.

## 5. Select Cube for the Compose product plane

Keep the normal production runtime secrets and kubeconfig: exact-commit
repository import deliberately remains on the existing restricted gVisor
importer for this experiment. Add these values to
`deploy/production/runtime/.env`:

```dotenv
AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID=<ready-template-id>
AGENT_DOCK_CUBESANDBOX_DOMAIN=cube.app
AGENT_DOCK_CUBESANDBOX_API_KEY_HOST_FILE=/secure/agent-dock-cube-api-key
AGENT_DOCK_CUBESANDBOX_API_NODE_IP=<private-cube-api>
AGENT_DOCK_CUBESANDBOX_API_NODE_PORT=3000
AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP=<private-cube-proxy>
AGENT_DOCK_CUBESANDBOX_PROXY_NODE_PORT=80
AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE=registry.example/agent-dock-cube-tool:<revision>
```

Validate the merged topology before changing running services:

```bash
npm run cubesandbox:config
npm run cubesandbox:build
npm run cubesandbox:up
npm run cubesandbox:ps
```

The override starts two credential-free fixed-target relays. The Sandbox
Manager remains on internal Compose networks, holds the Cube API key from the
mode-0600 file, and forces every Cube create request to:

```json
{
  "allow_internet_access": false,
  "network": {
    "allowPublicTraffic": false
  }
}
```

The private per-microVM traffic token stays inside the trusted Provider and is
never sent to Pi, the model or Tool code.

## Rollback

Cube is not a data authority. Conversation state and content-verified
Workspace checkpoints remain in AgentDock's PostgreSQL/object-storage commit
path. To return to the supported gVisor execution plane:

```bash
npm run cubesandbox:down
npm run production:up
```

Do not delete the Cube cluster until Cube inventory contains no active
AgentDock activation. Uninstalling the upstream chart does not revert node
labels, taints, `/data/cubelet` data or a PVM host-kernel change; follow the
upstream uninstall and host recovery documentation separately.
