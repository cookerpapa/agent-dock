import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const runtimeEnvironmentPath = join(runtimeDirectory, ".env");
const runtimeKubeconfigPath = join(runtimeDirectory, "kubernetes", "pi-worker-local.kubeconfig");
const switchStatePath = join(runtimeDirectory, "kubernetes", "pi-worker-local-switch.json");
const chartPath = join(repositoryRoot, "deploy/helm/agent-dock-pi-worker-pool");
const k3d =
  process.env.AGENT_DOCK_K3D_BIN ?? join(repositoryRoot, ".cache", "tools", "k3d-v5.9.0", "k3d");
const kubectl =
  process.env.AGENT_DOCK_KUBECTL_BIN ??
  (await executable("/usr/local/bin/kubectl").catch(() => "kubectl"));
const helm =
  process.env.AGENT_DOCK_HELM_BIN ??
  (await executable("helm").catch(() =>
    executable(join(repositoryRoot, ".cache", "tools", "helm-v3.18.6", "helm")),
  ));

const clusterName = "agent-dock-workers";
const k3sImage = "rancher/k3s:v1.35.5-k3s1";
const k3sSystemImages = [
  "rancher/mirrored-pause:3.6",
  "rancher/local-path-provisioner:v0.0.36",
  "rancher/mirrored-coredns-coredns:1.14.3",
  "rancher/mirrored-library-busybox:1.37.0",
  "rancher/klipper-helm:v0.10.0-build20260513",
  "rancher/klipper-lb:v0.4.17",
  "rancher/mirrored-library-traefik:3.6.13",
];
const serverContainer = `k3d-${clusterName}-server-0`;
const loadBalancerContainer = `k3d-${clusterName}-serverlb`;
const workerNamespace = "agent-dock-workers";
const systemNamespace = "agent-dock-system";
const releaseName = "pi-workers-local";
const poolName = "local-v1";
const workerStatefulSetName = `agent-dock-pi-worker-${poolName}`;
const workerPrefix = `agent-dock-pi-worker-${poolName}-`;
const managementHostSuffix = "workers.agent-dock.local";
const workerReplicas = 2;
const workerIds = Array.from(
  { length: workerReplicas },
  (_, ordinal) => `${workerPrefix}${String(ordinal)}`,
);
const workerManagementHosts = workerIds.map((workerId) => `${workerId}.${managementHostSuffix}`);
const workerMetricsHosts = workerIds.map(
  (workerId) => `${workerId}.metrics.${managementHostSuffix}`,
);

const composeNetworks = {
  management: "agent-dock-production_management",
  database: "agent-dock-production_database",
  objectStorage: "agent-dock-production_object-storage",
  sandboxControl: "agent-dock-production_sandbox-control",
  modelEgress: "agent-dock-production_model-egress",
  githubControl: "agent-dock-production_github-control",
  observability: "agent-dock-production_observability",
  temporal: "agent-dock-production_temporal",
};

const bridgeTargets = [
  {
    name: "control-plane",
    composeService: "control-plane",
    network: composeNetworks.management,
    port: 3000,
  },
  {
    name: "sandbox-manager",
    composeService: "sandbox-manager",
    network: composeNetworks.sandboxControl,
    port: 4300,
  },
  {
    name: "github-gateway",
    composeService: "github-gateway",
    network: composeNetworks.githubControl,
    port: 4400,
  },
  {
    name: "provider-egress-relay",
    composeService: "provider-egress-relay",
    network: composeNetworks.modelEgress,
    port: 3129,
  },
  {
    name: "jaeger",
    composeService: "jaeger",
    network: composeNetworks.observability,
    port: 4318,
  },
  {
    name: "postgres",
    composeService: "postgres",
    network: composeNetworks.database,
    port: 5432,
  },
  {
    name: "minio",
    composeService: "minio",
    network: composeNetworks.objectStorage,
    port: 9000,
  },
  {
    name: "temporal",
    composeService: "temporal",
    network: composeNetworks.temporal,
    port: 7233,
  },
];

const command = process.argv[2];
if (!new Set(["up", "down", "status", "check"]).has(command)) {
  throw new Error("Usage: local-kubernetes-pi-workers.mjs <up|down|status|check>");
}

async function executable(path) {
  await access(path, constants.X_OK);
  return path;
}

function childEnvironment(overrides = {}) {
  return {
    ...process.env,
    ...overrides,
  };
}

function capture(binary, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd ?? repositoryRoot,
        env: options.environment ?? childEnvironment(),
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options.timeout ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              `${binary} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || error.message}`,
            ),
          );
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

function run(binary, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.environment ?? childEnvironment(),
      stdio: [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${binary} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

function parseEnvironment(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const delimiter = line.indexOf("=");
        if (delimiter < 1) throw new Error("Production environment contains a malformed entry");
        return [line.slice(0, delimiter), line.slice(delimiter + 1)];
      }),
  );
}

async function readRuntimeEnvironment() {
  return parseEnvironment(await readFile(runtimeEnvironmentPath, "utf8"));
}

async function replaceRuntimeEnvironment(updates) {
  const metadata = await stat(runtimeEnvironmentPath);
  const lines = (await readFile(runtimeEnvironmentPath, "utf8"))
    .split(/\r?\n/u)
    .filter((line, index, all) => !(index === all.length - 1 && line.length === 0));
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const delimiter = line.indexOf("=");
    if (delimiter < 1 || line.startsWith("#")) return line;
    const key = line.slice(0, delimiter);
    const replacement = pending.get(key);
    if (replacement === undefined) return line;
    pending.delete(key);
    return `${key}=${replacement}`;
  });
  for (const [key, value] of pending) next.push(`${key}=${value}`);
  const temporary = `${runtimeEnvironmentPath}.pi-workers-${process.pid}`;
  await writeFile(temporary, `${next.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, metadata.mode & 0o777);
  await rename(temporary, runtimeEnvironmentPath);
}

async function writePrivate(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function repositoryRevision() {
  const dirty = await capture("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new Error("The local Kubernetes Worker image requires a clean committed source tree");
  }
  const revision = await capture("git", ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("Git revision is invalid");
  return revision;
}

async function ensureK3d() {
  try {
    await executable(k3d);
  } catch {
    if (process.env.AGENT_DOCK_K3D_BIN !== undefined) {
      throw new Error("Configured k3d is unavailable");
    }
    await run(process.execPath, [join(repositoryRoot, "scripts", "ensure-k3d.mjs")]);
    await executable(k3d);
  }
}

async function k3dClusterExists() {
  const clusters = JSON.parse(await capture(k3d, ["cluster", "list", "--output", "json"]));
  return clusters.some((cluster) => cluster.name === clusterName);
}

async function ensureCluster() {
  if (!(await k3dClusterExists())) {
    await run(k3d, [
      "cluster",
      "create",
      clusterName,
      "--servers",
      "1",
      "--agents",
      "0",
      "--image",
      k3sImage,
      "--servers-memory",
      "4g",
      "--port",
      "127.0.0.1:18080:80@loadbalancer",
      "--k3s-arg",
      "--disable=metrics-server@server:*",
      "--kubeconfig-update-default=false",
      "--kubeconfig-switch-context=false",
      "--wait",
      "--timeout",
      "5m",
    ]);
  }
  const kubeconfig = await capture(k3d, ["kubeconfig", "get", clusterName]);
  await writePrivate(runtimeKubeconfigPath, `${kubeconfig}\n`);
  await ensureK3sSystemImages();
  await waitForK3sSystemPlane();
}

async function imageExistsInK3d(image) {
  return capture("docker", ["exec", serverContainer, "crictl", "inspecti", image])
    .then(() => true)
    .catch(() => false);
}

async function importDockerImageIntoK3d(image, pull) {
  if (await imageExistsInK3d(image)) return;
  const importDirectory = join(runtimeDirectory, "kubernetes", "image-import");
  const publicDockerConfig = join(runtimeDirectory, "kubernetes", "public-docker-config");
  await mkdir(importDirectory, { recursive: true, mode: 0o700 });
  await mkdir(publicDockerConfig, { recursive: true, mode: 0o700 });
  if (pull) {
    // Public cluster bootstrap images do not require registry credentials. An
    // isolated config also avoids making local credential-helper availability a
    // prerequisite for an unattended cutover.
    await run("docker", ["pull", image], {
      environment: childEnvironment({ DOCKER_CONFIG: publicDockerConfig }),
    });
  }
  const imageKey = image.replaceAll(/[^a-zA-Z0-9_.-]/gu, "-");
  const archive = join(importDirectory, `${String(process.pid)}-${imageKey}.tar`);
  const remoteArchive = `/tmp/agent-dock-${String(process.pid)}-${imageKey}.tar`;
  try {
    await run("docker", ["save", "--output", archive, image]);
    await run("docker", ["cp", archive, `${serverContainer}:${remoteArchive}`]);
    await run("docker", [
      "exec",
      serverContainer,
      "ctr",
      "--namespace",
      "k8s.io",
      "images",
      "import",
      remoteArchive,
    ]);
  } finally {
    await rm(archive, { force: true });
    await run("docker", ["exec", serverContainer, "rm", "-f", remoteArchive]).catch(
      () => undefined,
    );
  }
}

async function ensureK3sSystemImages() {
  for (const image of k3sSystemImages) {
    await importDockerImageIntoK3d(image, true);
  }
}

async function waitForKubernetesResource(namespace, resource, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await kubectlCapture(["--namespace", namespace, "get", resource])
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Kubernetes resource ${namespace}/${resource} was not created`);
}

async function waitForK3sSystemPlane() {
  await kubectlRun([
    "--namespace",
    "kube-system",
    "wait",
    "--for=condition=Ready",
    "pod",
    "--selector",
    "k8s-app=kube-dns",
    "--timeout=3m",
  ]);
  await kubectlRun([
    "--namespace",
    "kube-system",
    "wait",
    "--for=condition=Ready",
    "pod",
    "--selector",
    "app=local-path-provisioner",
    "--timeout=3m",
  ]);
  await waitForKubernetesResource("kube-system", "deployment/traefik");
  await kubectlRun([
    "--namespace",
    "kube-system",
    "rollout",
    "status",
    "deployment/traefik",
    "--timeout=3m",
  ]);
  await kubectlRun([
    "--namespace",
    "kube-system",
    "wait",
    "--for=condition=Ready",
    "pod",
    "--selector",
    "svccontroller.k3s.cattle.io/svcname=traefik",
    "--timeout=3m",
  ]);
}

async function dockerInspect(container) {
  const output = await capture("docker", ["inspect", container]);
  const [inspection] = JSON.parse(output);
  if (inspection === undefined) throw new Error(`Docker container ${container} is unavailable`);
  return inspection;
}

async function ensureNetworkAttachment(container, network, aliases = []) {
  const inspection = await dockerInspect(container);
  const existing = inspection.NetworkSettings?.Networks?.[network];
  const existingAliases = new Set(existing?.Aliases ?? []);
  if (existing !== undefined && aliases.every((alias) => existingAliases.has(alias))) return;
  if (existing !== undefined) {
    await run("docker", ["network", "disconnect", "--force", network, container]);
  }
  await run("docker", [
    "network",
    "connect",
    ...aliases.flatMap((alias) => ["--alias", alias]),
    network,
    container,
  ]);
}

async function composeContainer(service) {
  const ids = (
    await capture("docker", [
      "ps",
      "--filter",
      "label=com.docker.compose.project=agent-dock-production",
      "--filter",
      `label=com.docker.compose.service=${service}`,
      "--format",
      "{{.ID}}",
    ])
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(`Expected one running Compose ${service} container, found ${ids.length}`);
  }
  return ids[0];
}

async function networkIp(container, network) {
  const inspection = await dockerInspect(container);
  const address = inspection.NetworkSettings?.Networks?.[network]?.IPAddress;
  if (typeof address !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) {
    throw new Error(`Container ${container} has no IPv4 address on ${network}`);
  }
  return address;
}

function kubeEnvironment() {
  return childEnvironment({ KUBECONFIG: runtimeKubeconfigPath });
}

async function kubectlCapture(args, timeout = 120_000) {
  return capture(kubectl, args, { environment: kubeEnvironment(), timeout });
}

async function kubectlRun(args, input) {
  return run(kubectl, args, { environment: kubeEnvironment(), input });
}

async function applyManifest(resources) {
  await kubectlRun(
    ["apply", "--server-side", "--field-manager=agent-dock-local-workers", "-f", "-"],
    resources.map((resource) => stringify(resource)).join("---\n"),
  );
}

async function bridgeComposeServices() {
  for (const network of Object.values(composeNetworks)) {
    await ensureNetworkAttachment(serverContainer, network);
  }
  await ensureNetworkAttachment(
    loadBalancerContainer,
    composeNetworks.management,
    workerManagementHosts,
  );
  await ensureNetworkAttachment(
    loadBalancerContainer,
    composeNetworks.observability,
    workerMetricsHosts,
  );

  await applyManifest([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: systemNamespace,
        labels: { "agent-dock.io/trusted-plane": "true" },
      },
    },
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: workerNamespace,
        labels: { "agent-dock.io/trusted-plane": "true" },
      },
    },
  ]);
  await kubectlRun([
    "label",
    "namespace",
    "kube-system",
    "agent-dock.io/trusted-plane=true",
    "--overwrite",
  ]);

  const resolved = [];
  for (const target of bridgeTargets) {
    const container = await composeContainer(target.composeService);
    resolved.push({
      ...target,
      address: await networkIp(container, target.network),
    });
  }

  await applyManifest(
    resolved.flatMap((target) => [
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: target.name,
          namespace: systemNamespace,
          labels: { "agent-dock.io/bridge": "compose" },
        },
        spec: {
          ports: [
            {
              name: "tcp",
              protocol: "TCP",
              port: target.port,
              targetPort: target.port,
            },
          ],
        },
      },
      {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name: `compose-${target.name}`,
          namespace: systemNamespace,
          labels: {
            "kubernetes.io/service-name": target.name,
            "endpointslice.kubernetes.io/managed-by": "agent-dock-local-workers",
          },
        },
        addressType: "IPv4",
        endpoints: [{ addresses: [target.address], conditions: { ready: true } }],
        ports: [{ name: "tcp", protocol: "TCP", port: target.port }],
      },
    ]),
  );
  return resolved;
}

async function applyWorkerSecret() {
  const secretDirectory = join(runtimeDirectory, "secrets");
  const source = async (name) => (await readFile(join(secretDirectory, name))).toString("base64");
  const databaseUrl = new URL(
    (await readFile(join(secretDirectory, "database-url"), "utf8")).trim(),
  );
  databaseUrl.hostname = `postgres.${systemNamespace}.svc.cluster.local`;
  databaseUrl.port = "5432";
  const data = {
    "database-url": Buffer.from(`${databaseUrl.toString()}\n`).toString("base64"),
    "aws-credentials": await source("aws-credentials"),
    "supervisor-enrollment-token": await source("supervisor-enrollment-token"),
    "supervisor-management-token": await source("supervisor-management-token"),
    "sandbox-manager-token": await source("sandbox-manager-token"),
    "model-credential-master-key": await source("model-credential-master-key"),
    "github-gateway-token": await source("github-gateway-token"),
    "metrics-token": await source("metrics-token"),
  };
  await applyManifest([
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "agent-dock-pi-worker-secrets",
        namespace: workerNamespace,
      },
      type: "Opaque",
      data,
    },
  ]);
}

async function activeRunCount() {
  const postgres = await composeContainer("postgres");
  const output = await capture("docker", [
    "exec",
    postgres,
    "psql",
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--username",
    "agent_dock",
    "--dbname",
    "agent_dock",
    "--command",
    "select count(*) from runs where state not in ('completed','failed','cancelled','timed_out','superseded')",
  ]);
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Active Run count was invalid");
  }
  return count;
}

async function composeWorkerContainers() {
  const output = await capture("docker", [
    "ps",
    "--all",
    "--filter",
    "label=com.docker.compose.project=agent-dock-production",
    "--format",
    '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}',
  ]);
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [id, service, state] = line.split("\t");
      return { id, service, state };
    })
    .filter(({ service }) => /^supervisor-host(?:-\d+)?$/u.test(service));
}

async function stopAndRemoveComposeWorkers() {
  for (const worker of await composeWorkerContainers()) {
    if (worker.state === "running") {
      await run("docker", ["stop", "--time", "45", worker.id]);
    }
    await run("docker", ["rm", worker.id]);
  }
}

async function runningServiceEnvironmentValue(service, name) {
  const container = await composeContainer(service);
  const inspection = await dockerInspect(container);
  const prefix = `${name}=`;
  const match = (inspection.Config?.Env ?? []).find((entry) => entry.startsWith(prefix));
  if (match === undefined) {
    throw new Error(`${service} does not declare ${name}`);
  }
  return match.slice(prefix.length);
}

async function productionCompose(args, imageRevision) {
  await run(
    process.execPath,
    [join(repositoryRoot, "scripts", "production-compose.mjs"), ...args],
    {
      environment: childEnvironment({
        AGENT_DOCK_IMAGE_REVISION: imageRevision,
      }),
    },
  );
}

async function waitForComposeHealthy(service, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const container = await composeContainer(service).catch(() => undefined);
    if (container !== undefined) {
      const inspection = await dockerInspect(container);
      if (inspection.State?.Health?.Status === "healthy") return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${service} did not become healthy`);
}

async function switchControlPlaneToKubernetes(runtimeEnvironment, revision) {
  const controlPlaneImageRevision = await runningServiceEnvironmentValue(
    "control-plane",
    "AGENT_DOCK_IMAGE_REVISION",
  );
  const previous = {
    formatVersion: 1,
    switchedAt: new Date().toISOString(),
    revision,
    controlPlaneImageRevision,
    piWorkerDeployment: runtimeEnvironment.AGENT_DOCK_PI_WORKER_DEPLOYMENT ?? "compose",
    supervisorIdPrefix: runtimeEnvironment.AGENT_DOCK_SUPERVISOR_ID_PREFIX ?? "agent-dock-worker-",
    supervisorManagementUrlTemplate:
      runtimeEnvironment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE ??
      "http://{supervisorId}:4100",
  };
  await writePrivate(switchStatePath, `${JSON.stringify(previous, null, 2)}\n`);
  await replaceRuntimeEnvironment({
    AGENT_DOCK_PI_WORKER_DEPLOYMENT: "kubernetes",
    AGENT_DOCK_SUPERVISOR_ID_PREFIX: workerPrefix,
    AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE: `http://{supervisorId}.${managementHostSuffix}`,
  });
  await stopAndRemoveComposeWorkers();
  await productionCompose(
    ["up", "--detach", "--no-deps", "control-plane"],
    controlPlaneImageRevision,
  );
  await waitForComposeHealthy("control-plane");
  return previous;
}

async function restoreComposeWorkers(previous) {
  await replaceRuntimeEnvironment({
    AGENT_DOCK_PI_WORKER_DEPLOYMENT: previous.piWorkerDeployment,
    AGENT_DOCK_SUPERVISOR_ID_PREFIX: previous.supervisorIdPrefix,
    AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE: previous.supervisorManagementUrlTemplate,
  });
  await productionCompose(
    ["up", "--detach", "--no-deps", "control-plane"],
    previous.controlPlaneImageRevision,
  );
  await waitForComposeHealthy("control-plane");
  await productionCompose(
    ["up", "--detach", "--no-deps", "supervisor-host", "supervisor-host-1"],
    previous.controlPlaneImageRevision,
  );
}

async function buildAndImportWorkerImage(revision) {
  const tag = `kubernetes-${revision.slice(0, 12)}`;
  const image = `agent-dock/supervisor-host:${tag}`;
  const proxyBuildArguments = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ].flatMap((name) =>
    typeof process.env[name] === "string" && process.env[name].length > 0
      ? ["--build-arg", name]
      : [],
  );
  await run("docker", [
    "build",
    "--network",
    "host",
    ...proxyBuildArguments,
    "--file",
    "packages/supervisor-host/Dockerfile",
    "--build-arg",
    `AGENT_DOCK_VERSION=${tag}`,
    "--build-arg",
    `AGENT_DOCK_REVISION=${revision}`,
    "--tag",
    image,
    ".",
  ]);
  await importDockerImageIntoK3d(image, false);
  return { image, tag };
}

async function migrateLegacyMutableClaimTemplate() {
  const current = await kubectlCapture([
    "--namespace",
    workerNamespace,
    "get",
    "statefulset",
    workerStatefulSetName,
    "--output",
    "json",
  ]).catch(() => undefined);
  if (current === undefined) return;
  const statefulSet = JSON.parse(current);
  const labels = statefulSet.spec?.volumeClaimTemplates?.[0]?.metadata?.labels;
  if (labels?.["agent-dock.io/worker-build-id"] === undefined) return;
  // Early local chart revisions put the changing Build ID into this immutable
  // template. Runs are already drained before cutover, and PVC retention is
  // Retain, so recreate only the controller and Pods while preserving state.
  await kubectlRun([
    "--namespace",
    workerNamespace,
    "delete",
    "statefulset",
    workerStatefulSetName,
    "--cascade=foreground",
    "--wait=true",
    "--timeout=2m",
  ]);
}

async function waitForWorkerPodInventory(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const expected = new Set(workerIds);
  while (Date.now() < deadline) {
    const pods = await kubectlCapture([
      "--namespace",
      workerNamespace,
      "get",
      "pods",
      "--selector",
      `agent-dock.io/worker-pool=${poolName}`,
      "--output",
      "json",
    ])
      .then((output) => JSON.parse(output).items)
      .catch(() => []);
    if (pods.length === workerReplicas && pods.every((pod) => expected.has(pod.metadata?.name))) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Kubernetes did not create all ${String(workerReplicas)} expected Worker Pods`);
}

async function deployWorkerPool(revision, imageTag, resolvedTargets, runtimeEnvironment) {
  await applyWorkerSecret();
  await migrateLegacyMutableClaimTemplate();
  const externalCidrs = [...new Set(resolvedTargets.map((target) => `${target.address}/32`))];
  const arguments_ = [
    "upgrade",
    "--install",
    releaseName,
    chartPath,
    "--namespace",
    workerNamespace,
    "--timeout",
    "7m",
    "--set",
    `workerPool.name=${poolName}`,
    "--set",
    `workerPool.replicas=${String(workerReplicas)}`,
    "--set",
    "management.ingress.enabled=true",
    "--set",
    "management.ingress.className=traefik",
    "--set",
    `management.ingress.hostSuffix=${managementHostSuffix}`,
    "--set",
    "management.ingress.scheme=http",
    "--set",
    "image.repository=agent-dock/supervisor-host",
    "--set",
    `image.tag=${imageTag}`,
    "--set",
    "image.pullPolicy=Never",
    "--set",
    "temporal.address=temporal.agent-dock-system.svc.cluster.local:7233",
    "--set",
    "temporal.namespace=agent-dock",
    "--set",
    "temporal.taskQueue=agent-dock-pi-runs-v1",
    "--set",
    "temporal.workerDeploymentName=agent-dock-pi-workers",
    "--set-string",
    `temporal.workerBuildId=${revision}`,
    "--set",
    "services.controlPlaneUrl=http://control-plane.agent-dock-system.svc.cluster.local:3000",
    "--set",
    "services.sandboxManagerUrl=http://sandbox-manager.agent-dock-system.svc.cluster.local:4300",
    "--set",
    "services.githubGateway.enabled=true",
    "--set",
    "services.githubGateway.url=http://github-gateway.agent-dock-system.svc.cluster.local:4400",
    "--set",
    "services.providerProxyUrl=http://provider-egress-relay.agent-dock-system.svc.cluster.local:3129",
    "--set",
    "services.otlpTracesEndpoint=http://jaeger.agent-dock-system.svc.cluster.local:4318/v1/traces",
    "--set",
    "conversationStorage.existingSecret=agent-dock-pi-worker-secrets",
    "--set",
    `conversationStorage.s3.bucket=${runtimeEnvironment.AGENT_DOCK_CHECKPOINT_BUCKET ?? "agent-dock-checkpoints"}`,
    "--set",
    `conversationStorage.s3.region=${runtimeEnvironment.AGENT_DOCK_CHECKPOINT_REGION ?? "us-east-1"}`,
    "--set",
    "conversationStorage.s3.endpoint=http://minio.agent-dock-system.svc.cluster.local:9000",
    "--set",
    "conversationStorage.s3.forcePathStyle=true",
    "--set",
    "conversationStorage.s3.allowInsecureEndpoint=true",
    "--set",
    "state.storageClassName=local-path",
    "--set",
    "state.accessModes[0]=ReadWriteOnce",
    "--set-json",
    `networkPolicy.externalEgressCidrs=${JSON.stringify(externalCidrs)}`,
  ];
  await run(helm, arguments_, { environment: kubeEnvironment() });
  await kubectlRun([
    "--namespace",
    workerNamespace,
    "delete",
    "pod",
    "--selector",
    `agent-dock.io/worker-pool=${poolName}`,
    "--wait=true",
    "--timeout=2m",
  ]);
  await waitForWorkerPodInventory();
  await kubectlRun([
    "--namespace",
    workerNamespace,
    "wait",
    "--for=condition=Ready",
    "pod",
    "--selector",
    `agent-dock.io/worker-pool=${poolName}`,
    "--timeout=7m",
  ]);
}

async function temporalDeploymentDescription() {
  const temporal = await composeContainer("temporal");
  const output = await capture("docker", [
    "exec",
    temporal,
    "temporal",
    "worker",
    "deployment",
    "describe",
    "--address",
    "127.0.0.1:7233",
    "--namespace",
    "agent-dock",
    "--name",
    "agent-dock-pi-workers",
    "--output",
    "json",
  ]);
  return JSON.parse(output);
}

function temporalDeploymentContainsBuild(deployment, revision) {
  return deployment.versionSummaries?.some((version) => version.BuildID === revision) === true;
}

async function currentTemporalBuildId() {
  const deployment = await temporalDeploymentDescription().catch(() => undefined);
  const buildId = deployment?.routingConfig?.currentVersionBuildID;
  return typeof buildId === "string" && buildId.length > 0 ? buildId : undefined;
}

async function setTemporalCurrentVersion(revision) {
  const temporal = await composeContainer("temporal");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const deployment = await temporalDeploymentDescription().catch(() => undefined);
    if (deployment !== undefined && temporalDeploymentContainsBuild(deployment, revision)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  const deployment = await temporalDeploymentDescription().catch(() => undefined);
  if (deployment === undefined || !temporalDeploymentContainsBuild(deployment, revision)) {
    throw new Error("Kubernetes Pi Worker Build ID did not register with Temporal");
  }
  await run("docker", [
    "exec",
    temporal,
    "temporal",
    "worker",
    "deployment",
    "set-current-version",
    "--address",
    "127.0.0.1:7233",
    "--namespace",
    "agent-dock",
    "--deployment-name",
    "agent-dock-pi-workers",
    "--build-id",
    revision,
    "--yes",
  ]);
  const confirmationDeadline = Date.now() + 30_000;
  while (Date.now() < confirmationDeadline) {
    if ((await currentTemporalBuildId()) === revision) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Temporal did not confirm the promoted Kubernetes Pi Worker Build ID");
}

async function currentHelmRevision() {
  const status = await capture(
    helm,
    ["status", releaseName, "--namespace", workerNamespace, "--output", "json"],
    { environment: kubeEnvironment() },
  ).catch(() => undefined);
  if (status === undefined) return undefined;
  const revision = JSON.parse(status).version;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Current Pi Worker Helm revision is invalid");
  }
  return revision;
}

async function rollbackKubernetesWorkerPool(revision) {
  await run(
    helm,
    ["rollback", releaseName, String(revision), "--namespace", workerNamespace, "--timeout", "7m"],
    { environment: kubeEnvironment() },
  );
  await kubectlRun([
    "--namespace",
    workerNamespace,
    "delete",
    "pod",
    "--selector",
    `agent-dock.io/worker-pool=${poolName}`,
    "--wait=true",
    "--timeout=2m",
  ]);
  await waitForWorkerPodInventory();
  await kubectlRun([
    "--namespace",
    workerNamespace,
    "wait",
    "--for=condition=Ready",
    "pod",
    "--selector",
    `agent-dock.io/worker-pool=${poolName}`,
    "--timeout=7m",
  ]);
}

async function waitForManagementRoutes(controlPlane, timeoutMs = 120_000) {
  for (const workerId of workerIds) {
    const target = `http://${workerId}.${managementHostSuffix}/health/ready`;
    const deadline = Date.now() + timeoutMs;
    let result;
    while (Date.now() < deadline) {
      result = await capture("docker", [
        "exec",
        controlPlane,
        "node",
        "--input-type=module",
        "--eval",
        `const response=await fetch(${JSON.stringify(target)}); if(!response.ok) process.exit(2); console.log(response.status)`,
      ]).catch(() => undefined);
      if (result === "200") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    if (result !== "200") throw new Error(`Control Plane cannot reach ${workerId}`);
  }
}

async function waitForWorkerEnrollment(postgres, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let enrolled = 0;
  while (Date.now() < deadline) {
    enrolled = Number(
      await capture("docker", [
        "exec",
        postgres,
        "psql",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--username",
        "agent_dock",
        "--dbname",
        "agent_dock",
        "--command",
        `select count(*) from supervisor_hosts where supervisor_id like '${workerPrefix}%'`,
      ]),
    );
    if (enrolled >= workerReplicas) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Expected ${workerReplicas} enrolled Kubernetes Workers, found ${enrolled}`);
}

async function checkDeployment(expectedRevision, { requireCurrent = true, emit = true } = {}) {
  await ensureK3d();
  const runtimeEnvironment = await readRuntimeEnvironment();
  if (runtimeEnvironment.AGENT_DOCK_PI_WORKER_DEPLOYMENT !== "kubernetes") {
    throw new Error("Production is not configured for Kubernetes Pi Workers");
  }
  const pods = JSON.parse(
    await kubectlCapture([
      "--namespace",
      workerNamespace,
      "get",
      "pods",
      "--selector",
      `agent-dock.io/worker-pool=${poolName}`,
      "--output",
      "json",
    ]),
  );
  if (pods.items.length !== workerReplicas) {
    throw new Error(`Expected ${workerReplicas} Worker Pods, found ${pods.items.length}`);
  }
  for (const pod of pods.items) {
    const ready = pod.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    if (!ready) throw new Error(`Worker Pod ${pod.metadata?.name} is not Ready`);
  }

  const controlPlane = await composeContainer("control-plane");
  await waitForManagementRoutes(controlPlane);

  const postgres = await composeContainer("postgres");
  await waitForWorkerEnrollment(postgres);

  const revision = expectedRevision ?? (await repositoryRevision());
  const deployment = await temporalDeploymentDescription();
  if (!temporalDeploymentContainsBuild(deployment, revision)) {
    throw new Error("Temporal Worker Deployment does not contain the expected Build ID");
  }
  if (requireCurrent && deployment.routingConfig?.currentVersionBuildID !== revision) {
    throw new Error("Temporal Worker Deployment is not routing new Runs to the expected Build ID");
  }

  if (emit)
    process.stdout.write(
      `${JSON.stringify({
        kubernetesPiWorkers: "ready",
        cluster: clusterName,
        replicas: workerReplicas,
        workerIds,
        buildId: revision,
        composePiWorkers: (await composeWorkerContainers()).length,
      })}\n`,
    );
}

async function up() {
  await ensureK3d();
  const revision = await repositoryRevision();
  const runtimeEnvironment = await readRuntimeEnvironment();
  const active = await activeRunCount();
  if (active !== 0) {
    throw new Error(`Refusing Worker cutover while ${active} Run(s) are not terminal`);
  }

  await ensureCluster();
  const resolvedTargets = await bridgeComposeServices();
  const { tag } = await buildAndImportWorkerImage(revision);
  const upgradingKubernetes = runtimeEnvironment.AGENT_DOCK_PI_WORKER_DEPLOYMENT === "kubernetes";
  const previousHelmRevision = upgradingKubernetes ? await currentHelmRevision() : undefined;
  const previousTemporalBuildId = await currentTemporalBuildId();
  let previous;
  try {
    if (!upgradingKubernetes) {
      previous = await switchControlPlaneToKubernetes(runtimeEnvironment, revision);
    }
    await deployWorkerPool(revision, tag, resolvedTargets, runtimeEnvironment);
    await checkDeployment(revision, { requireCurrent: false, emit: false });
    await setTemporalCurrentVersion(revision);
    await checkDeployment(revision);
  } catch (error) {
    if (previous !== undefined) {
      await restoreComposeWorkers(previous).catch((rollbackError) => {
        process.stderr.write(`Automatic Compose rollback failed: ${String(rollbackError)}\n`);
      });
    } else if (previousHelmRevision !== undefined) {
      await rollbackKubernetesWorkerPool(previousHelmRevision).catch((rollbackError) => {
        process.stderr.write(`Automatic Kubernetes rollback failed: ${String(rollbackError)}\n`);
      });
    }
    if (previousTemporalBuildId !== undefined) {
      await setTemporalCurrentVersion(previousTemporalBuildId).catch((rollbackError) => {
        process.stderr.write(
          `Automatic Temporal routing rollback failed: ${String(rollbackError)}\n`,
        );
      });
    }
    throw error;
  }
}

async function down() {
  await ensureK3d();
  const active = await activeRunCount();
  if (active !== 0) {
    throw new Error(`Refusing Worker rollback while ${active} Run(s) are not terminal`);
  }
  const previous = JSON.parse(await readFile(switchStatePath, "utf8"));
  if (await k3dClusterExists()) {
    const kubeconfig = await capture(k3d, ["kubeconfig", "get", clusterName]);
    await writePrivate(runtimeKubeconfigPath, `${kubeconfig}\n`);
    await run(helm, ["uninstall", releaseName, "--namespace", workerNamespace, "--wait"], {
      environment: kubeEnvironment(),
    }).catch(() => undefined);
  }
  await restoreComposeWorkers(previous);
  if (await k3dClusterExists()) {
    await run(k3d, ["cluster", "delete", clusterName]);
  }
  await rm(runtimeKubeconfigPath, { force: true });
}

async function status() {
  await ensureK3d();
  const runtimeEnvironment = await readRuntimeEnvironment();
  const clusterExists = await k3dClusterExists();
  const workers = await composeWorkerContainers();
  let kubernetesWorkers = [];
  if (clusterExists) {
    const kubeconfig = await capture(k3d, ["kubeconfig", "get", clusterName]);
    await writePrivate(runtimeKubeconfigPath, `${kubeconfig}\n`);
    const output = await kubectlCapture([
      "--namespace",
      workerNamespace,
      "get",
      "pods",
      "--selector",
      `agent-dock.io/worker-pool=${poolName}`,
      "--output",
      "json",
    ]).catch(() => undefined);
    if (output !== undefined) {
      kubernetesWorkers = JSON.parse(output).items.map((pod) => ({
        name: pod.metadata?.name,
        phase: pod.status?.phase,
        ready: pod.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
        node: pod.spec?.nodeName,
      }));
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        configuredDeployment: runtimeEnvironment.AGENT_DOCK_PI_WORKER_DEPLOYMENT ?? "compose",
        clusterExists,
        kubernetesWorkers,
        composeWorkers: workers.map(({ service, state }) => ({ service, state })),
      },
      null,
      2,
    )}\n`,
  );
}

if (command === "up") await up();
if (command === "down") await down();
if (command === "status") await status();
if (command === "check") await checkDeployment();
