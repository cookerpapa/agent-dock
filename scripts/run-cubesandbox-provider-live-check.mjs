import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory =
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ??
  fileURLToPath(new URL("../deploy/production/runtime", import.meta.url));

function assertEndpoint(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.host !== "string" ||
    value.host.length < 1 ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new Error(`${label} evidence was invalid`);
  }
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function workspaceVolumeGatewayAddress() {
  const containerIds = execFileSync(
    "docker",
    [
      "ps",
      "--filter",
      "label=com.docker.compose.service=workspace-volume-gateway",
      "--format",
      "{{.ID}}",
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  )
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (containerIds.length !== 1) {
    throw new Error(
      "exactly one running production workspace-volume-gateway is required by the live gate",
    );
  }
  const networks = JSON.parse(
    execFileSync(
      "docker",
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerIds[0]],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  const addresses = Object.values(networks)
    .map((network) => network?.IPAddress)
    .filter((address) => typeof address === "string" && address.length > 0);
  if (addresses.length < 1) {
    throw new Error("workspace-volume-gateway has no reachable container address");
  }
  return addresses[0];
}

const cluster = await readJson(`${runtimeDirectory}/cubesandbox/cluster.json`);
const template = await readJson(`${runtimeDirectory}/cubesandbox/template.json`);
const api = assertEndpoint(cluster.api, "Cube API");
const master = assertEndpoint(cluster.master, "Cube master");
const registry = assertEndpoint(cluster.registry, "Cube registry");
const proxy = assertEndpoint(cluster.proxy, "Cube proxy");
if (
  typeof cluster.sandboxDomain !== "string" ||
  typeof template.templateId !== "string" ||
  typeof template.imageRevision !== "string"
) {
  throw new Error("Cube cluster/template evidence was invalid");
}

const gatewayAddress = workspaceVolumeGatewayAddress();
const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  [
    "test",
    "--workspace",
    "@pi-cloud/tool-broker",
    "--",
    "cubesandbox-live-provider.integration.test.ts",
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PI_CLOUD_CUBESANDBOX_TEST: "1",
      PI_CLOUD_CUBESANDBOX_API_URL: `http://${api.host}:${String(api.port)}`,
      PI_CLOUD_CUBESANDBOX_API_KEY_FILE: `${runtimeDirectory}/secrets/cubesandbox-api-key`,
      PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: proxy.host,
      PI_CLOUD_CUBESANDBOX_PROXY_PORT: String(proxy.port),
      PI_CLOUD_CUBESANDBOX_DOMAIN: cluster.sandboxDomain,
      PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: template.templateId,
      PI_CLOUD_IMAGE_REVISION: template.imageRevision,
      PI_CLOUD_CUBESANDBOX_FORBIDDEN_ENDPOINTS: `${master.host}:${String(master.port)},${registry.host}:${String(registry.port)}`,
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: `http://${gatewayAddress}:4500`,
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: `${runtimeDirectory}/secrets/workspace-volume-gateway-token`,
    },
    stdio: "inherit",
  },
);

await new Promise((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else {
      rejectPromise(
        new Error(
          `CubeSandbox Provider live gate failed (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    }
  });
});
