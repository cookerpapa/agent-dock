import { execFile, spawn } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CUBE_COMMIT = "8721dd151971ce3c2966482bbd32904ad98f378e";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const kubeconfig = "/etc/rancher/k3s/k3s.yaml";
const cubeRepository = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? "../CubeSandbox",
);
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const credentialPath = resolve(runtimeDirectory, "secrets/cubesandbox-api-key");
const secretValuesPath = resolve(runtimeDirectory, "cubesandbox/secret-values.yaml");
const cubeMasterCliPath = resolve(runtimeDirectory, "cubesandbox/cubemastercli");
const authorizerImageRepository = "pi-cloud/cube-api-authorizer";
const cubeEgressGatewayImageRepository = "pi-cloud/cube-egress-gateway";
const cubeEgressConfigTokenPath = resolve(runtimeDirectory, "secrets/cube-egress-config-token");
const k3sImageDirectory = "/var/lib/rancher/k3s/agent/images";
const wslStableNodeIp = "10.255.255.254";
const wslStableNodeInterface = "picloud0";
const wslStableNodeMtu = 1_500;
const wslFlannelMtu = 1_450;
const noProxyEntries = [
  process.env.NO_PROXY,
  process.env.no_proxy,
  "127.0.0.1",
  "localhost",
  wslStableNodeIp,
  "10.42.0.0/16",
  "10.43.0.0/16",
]
  .filter((value) => value !== undefined && value.length > 0)
  .join(",");
const environment = {
  ...process.env,
  KUBECONFIG: kubeconfig,
  NO_PROXY: noProxyEntries,
  no_proxy: noProxyEntries,
};
const kubectlCommand = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
const kubectlPrefix = process.env.PI_CLOUD_KUBECTL_BIN === undefined ? ["kubectl"] : [];
const k3sConfigPath = "/etc/rancher/k3s/config.yaml";
const k3sWslPreparePath = "/usr/local/libexec/pi-cloud-prepare-k3s-wsl";
const k3sServiceRouteHelperPath = "/usr/local/libexec/pi-cloud-route-k3s-services";
const k3sServiceRouteDropInPath =
  "/etc/systemd/system/k3s.service.d/pi-cloud-cube-service-route.conf";
const cubeSysctlPath = "/etc/sysctl.d/90-pi-cloud-cubesandbox.conf";
const inotifyInstanceLimitPath = "/proc/sys/fs/inotify/max_user_instances";
const minimumInotifyInstances = 1_024;
const k3sServiceCidr = "10.43.0.0/16";
const templateRegistryTlsSecret = "pi-cloud-cube-template-registry-tls";
const templateRegistryDockerTrustDirectory = "/etc/docker/certs.d/localhost:5000";
const posixVolumePluginName = "picloud-posix";
const posixVolumePluginConfigMap = "pi-cloud-posix-volume-plugin";
const posixVolumePluginSource = resolve(
  repositoryRoot,
  "deploy/cubesandbox/cube-volume-picloud-posix.sh",
);
const posixSharedRoot = resolve(runtimeDirectory, "state/cube-shared");
const posixVolumeRoot = resolve(posixSharedRoot, "volume");
const cubeletDataPath = "/data/cubelet";
const cubeletLoopbackImagePath = "/data/cubelet-xfs.img";
const cubeletLoopbackSize = "64G";
const cubeletLoopbackBytes = 64 * 1_024 * 1_024 * 1_024;

if (process.getuid?.() !== 0) {
  throw new Error(
    "CubeSandbox K3s installation must run as root because it imports an image into K3s containerd",
  );
}

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function captureKubectl(args, timeout) {
  return capture(kubectlCommand, [...kubectlPrefix, ...args], timeout);
}

function runKubectl(args, options) {
  return run(kubectlCommand, [...kubectlPrefix, ...args], options);
}

async function waitForRunningPod(labelSelector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pods = JSON.parse(
      await captureKubectl([
        "-n",
        "cube-system",
        "get",
        "pods",
        "--selector",
        labelSelector,
        "-o",
        "json",
      ]),
    )?.items;
    if (Array.isArray(pods) && pods.some((pod) => pod?.status?.phase === "Running")) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Kubernetes Pod did not enter Running for ${labelSelector}`);
}

function canonicalImageReference(image) {
  const [name, digest] = image.split("@", 2);
  const segments = name.split("/");
  const qualified =
    segments.length === 1
      ? `docker.io/library/${name}`
      : !segments[0].includes(".") && !segments[0].includes(":") && segments[0] !== "localhost"
        ? `docker.io/${name}`
        : name;
  return digest === undefined ? qualified : `${qualified}@${digest}`;
}

async function listK3sImages() {
  return new Set(
    (
      await capture("ctr", [
        "--address",
        "/run/k3s/containerd/containerd.sock",
        "--namespace",
        "k8s.io",
        "images",
        "list",
        "--quiet",
      ])
    ).split(/\r?\n/),
  );
}

async function stagePinnedK3sImages(archiveName, images, timeoutMs = 10 * 60_000) {
  await mkdir(k3sImageDirectory, { recursive: true, mode: 0o700 });
  const archivePath = join(k3sImageDirectory, archiveName);
  const partialArchivePath = `${archivePath}.partial`;
  try {
    await rm(partialArchivePath, { force: true });
    await run("docker", ["image", "save", "--output", partialArchivePath, ...images]);
    await rename(partialArchivePath, archivePath);
    await capture(
      "ctr",
      [
        "--address",
        "/run/k3s/containerd/containerd.sock",
        "--namespace",
        "k8s.io",
        "images",
        "import",
        archivePath,
      ],
      timeoutMs,
    );
    const imported = await listK3sImages();
    if (!images.every((image) => imported.has(canonicalImageReference(image)))) {
      throw new Error(`K3s did not confirm pinned images from ${archiveName}`);
    }
  } finally {
    await rm(partialArchivePath, { force: true });
    await rm(archivePath, { force: true });
  }
}

function assertSingleNode(value) {
  const nodes = JSON.parse(value)?.items;
  if (!Array.isArray(nodes) || nodes.length !== 1) {
    throw new Error("The local CubeSandbox profile requires exactly one K3s node");
  }
  const node = nodes[0];
  const ready = node?.status?.conditions?.find(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  const name = node?.metadata?.name;
  if (ready === undefined || typeof name !== "string" || name.length === 0) {
    throw new Error("The K3s node is not Ready");
  }
  return name;
}

function localIpv4Addresses(value) {
  const interfaces = JSON.parse(value);
  if (!Array.isArray(interfaces)) {
    throw new Error("ip -j address returned an invalid payload");
  }
  return new Set(
    interfaces.flatMap((networkInterface) =>
      Array.isArray(networkInterface.addr_info)
        ? networkInterface.addr_info
            .filter((address) => address.family === "inet" && typeof address.local === "string")
            .map((address) => address.local)
        : [],
    ),
  );
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureHostInotifyCapacity() {
  const configuredLimit = Number((await readFile(inotifyInstanceLimitPath, "utf8")).trim());
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) {
    throw new Error("The host inotify instance limit is invalid");
  }

  const desiredLimit = Math.max(configuredLimit, minimumInotifyInstances);
  const configuration = [
    "# Managed by PiCloud for the local CubeSandbox Kubernetes profile.",
    `fs.inotify.max_user_instances = ${String(desiredLimit)}`,
    "",
  ].join("\n");
  if ((await readOptional(cubeSysctlPath)) !== configuration) {
    const temporaryPath = `${cubeSysctlPath}.pi-cloud.tmp`;
    await writeFile(temporaryPath, configuration, { mode: 0o644 });
    await rename(temporaryPath, cubeSysctlPath);
  }
  if (configuredLimit < desiredLimit) {
    await writeFile(inotifyInstanceLimitPath, `${String(desiredLimit)}\n`);
  }

  const effectiveLimit = Number((await readFile(inotifyInstanceLimitPath, "utf8")).trim());
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < minimumInotifyInstances) {
    throw new Error(
      `CubeSandbox requires fs.inotify.max_user_instances >= ${String(minimumInotifyInstances)}`,
    );
  }
}

function stableWslInterfacePreparation() {
  return `# PiCloud gives K3s a stable WSL node address on an MTU-bounded
# dummy interface. Binding Flannel to loopback would inherit its 65536-byte
# MTU and create a black-hole for ordinary Ethernet-sized Pod traffic.
if grep -qi microsoft-standard-wsl /proc/sys/kernel/osrelease; then
  if ! ip link show dev ${wslStableNodeInterface} >/dev/null 2>&1; then
    ip link add name ${wslStableNodeInterface} type dummy
  fi
  ip link set dev ${wslStableNodeInterface} mtu ${wslStableNodeMtu} up
  ip address replace ${wslStableNodeIp}/32 dev ${wslStableNodeInterface}
  if ip -4 -o address show dev lo | grep -q ' ${wslStableNodeIp}/32 '; then
    ip address del ${wslStableNodeIp}/32 dev lo
  fi
fi`;
}

async function persistStableWslInterfacePreparation() {
  const helper = await readOptional(k3sWslPreparePath);
  if (helper === undefined) return false;
  const start = "# BEGIN PI_CLOUD_WSL_NODE_INTERFACE";
  const end = "# END PI_CLOUD_WSL_NODE_INTERFACE";
  const block = `${start}\n${stableWslInterfacePreparation()}\n${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`, "u");
  const updated = expression.test(helper)
    ? helper.replace(expression, block)
    : helper.replace(/^set -eu$/mu, `set -eu\n\n${block}`);
  if (updated === helper) return false;
  if (!updated.includes(block)) {
    throw new Error(`${k3sWslPreparePath} has an unexpected format`);
  }
  const temporaryPath = `${k3sWslPreparePath}.pi-cloud.tmp`;
  const mode = (await stat(k3sWslPreparePath)).mode & 0o777;
  await writeFile(temporaryPath, updated, { mode });
  await rename(temporaryPath, k3sWslPreparePath);
  return true;
}

async function currentLink(name) {
  try {
    const links = JSON.parse(await capture("ip", ["-j", "link", "show", "dev", name]));
    return Array.isArray(links) ? links[0] : undefined;
  } catch {
    return undefined;
  }
}

async function ensureStableWslNodeAddress() {
  const release = await readFile("/proc/sys/kernel/osrelease", "utf8");
  if (!release.toLowerCase().includes("microsoft-standard-wsl")) {
    return { isWsl: false, changed: false, podNetworkMtu: undefined };
  }

  const existingLink = await currentLink(wslStableNodeInterface);
  const existingInterfaceAddresses =
    existingLink === undefined
      ? new Set()
      : localIpv4Addresses(
          await capture("ip", ["-j", "-4", "address", "show", "dev", wslStableNodeInterface]),
        );
  const loopbackAddresses = localIpv4Addresses(
    await capture("ip", ["-j", "-4", "address", "show", "dev", "lo"]),
  );
  const interfaceChanged =
    existingLink === undefined ||
    existingLink.mtu !== wslStableNodeMtu ||
    !existingInterfaceAddresses.has(wslStableNodeIp) ||
    loopbackAddresses.has(wslStableNodeIp);

  if (existingLink === undefined) {
    await run("ip", ["link", "add", "name", wslStableNodeInterface, "type", "dummy"]);
  }
  await run("ip", [
    "link",
    "set",
    "dev",
    wslStableNodeInterface,
    "mtu",
    String(wslStableNodeMtu),
    "up",
  ]);
  await run("ip", ["address", "replace", `${wslStableNodeIp}/32`, "dev", wslStableNodeInterface]);
  if (loopbackAddresses.has(wslStableNodeIp)) {
    await run("ip", ["address", "del", `${wslStableNodeIp}/32`, "dev", "lo"]);
  }
  const helperChanged = await persistStableWslInterfacePreparation();

  const original = await readFile(k3sConfigPath, "utf8");
  const nodeIpLine = `node-ip: "${wslStableNodeIp}"`;
  const withNodeIp = /^node-ip:/mu.test(original)
    ? original.replace(/^node-ip:.*$/mu, nodeIpLine)
    : `${original.trimEnd()}\n${nodeIpLine}\n`;
  const flannelInterfaceLine = `flannel-iface: "${wslStableNodeInterface}"`;
  const updated = /^flannel-iface:/mu.test(withNodeIp)
    ? withNodeIp.replace(/^flannel-iface:.*$/mu, flannelInterfaceLine)
    : `${withNodeIp.trimEnd()}\n${flannelInterfaceLine}\n`;

  let currentNodeIp;
  try {
    const nodes = JSON.parse(await captureKubectl(["get", "nodes", "-o", "json"], 5_000))?.items;
    currentNodeIp = nodes?.[0]?.status?.addresses?.find(
      (address) => address.type === "InternalIP",
    )?.address;
  } catch {
    currentNodeIp = undefined;
  }
  const flannelEnvironment = await readOptional("/run/flannel/subnet.env");
  const currentFlannelMtu = flannelEnvironment?.match(/^FLANNEL_MTU=(\d+)$/mu)?.[1];
  if (
    updated === original &&
    currentNodeIp === wslStableNodeIp &&
    !interfaceChanged &&
    !helperChanged &&
    currentFlannelMtu === String(wslFlannelMtu)
  ) {
    return { isWsl: true, changed: false, podNetworkMtu: wslFlannelMtu };
  }

  const temporaryPath = `${k3sConfigPath}.pi-cloud.tmp`;
  const mode = (await stat(k3sConfigPath)).mode & 0o777;
  if (updated !== original) {
    await writeFile(temporaryPath, updated, { mode });
    await rename(temporaryPath, k3sConfigPath);
  }

  await run("systemctl", ["restart", "k3s"]);
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const value = JSON.parse(await captureKubectl(["get", "nodes", "-o", "json"], 5_000));
      const node = value?.items?.[0];
      const internalIp = node?.status?.addresses?.find(
        (address) => address.type === "InternalIP",
      )?.address;
      const ready = node?.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      );
      const currentEnvironment = await readOptional("/run/flannel/subnet.env");
      const mtu = currentEnvironment?.match(/^FLANNEL_MTU=(\d+)$/mu)?.[1];
      const flannelLink = await currentLink("flannel.1");
      const cniLink = await currentLink("cni0");
      if (
        internalIp === wslStableNodeIp &&
        ready &&
        mtu === String(wslFlannelMtu) &&
        flannelLink?.mtu === wslFlannelMtu &&
        cniLink?.mtu === wslFlannelMtu
      ) {
        return { isWsl: true, changed: true, podNetworkMtu: wslFlannelMtu };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(
    `K3s did not become Ready on ${wslStableNodeIp}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function restartCubeWorkloadsAfterNetworkChange() {
  for (const kind of ["deployment", "statefulset", "daemonset"]) {
    await runKubectl(["-n", "cube-system", "rollout", "restart", kind]);
  }
  const resources = (
    await captureKubectl([
      "-n",
      "cube-system",
      "get",
      "deployment,statefulset,daemonset",
      "-o",
      "name",
    ])
  )
    .split("\n")
    .filter((value) => value.length > 0);
  for (const resource of resources) {
    await runKubectl(["-n", "cube-system", "rollout", "status", resource, "--timeout=600s"]);
  }
}

function withCubeletPosixVolumePlugin(config) {
  if (
    config.includes(`name        = "${posixVolumePluginName}"`) ||
    config.includes(`name = "${posixVolumePluginName}"`)
  ) {
    return config;
  }
  const marker = `    [[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
      name        = "cos"
      type        = "binary"
      binary_path = "/usr/local/services/cubetoolbox/Cubelet/plugin/cube-volume-cos"`;
  if (!config.includes(marker)) {
    throw new Error("Cubelet v0.6 volume plugin configuration shape was not recognized");
  }
  return config.replace(
    marker,
    `${marker}

    [[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
      name        = "${posixVolumePluginName}"
      type        = "binary"
      binary_path = "/usr/local/services/cubetoolbox/Cubelet/plugin/cube-volume-picloud-posix"`,
  );
}

function withCubeMasterPosixVolumePlugin(config) {
  if (config.includes(`  - name: ${posixVolumePluginName}\n`)) return config;
  const marker = `  - name: cos
    type: binary
    binary_path: /usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-cos`;
  if (!config.includes(marker)) {
    throw new Error("CubeMaster v0.6 volume plugin configuration shape was not recognized");
  }
  return config.replace(
    marker,
    `${marker}
  - name: ${posixVolumePluginName}
    type: binary
    binary_path: /usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix`,
  );
}

async function installPosixVolumePlugin() {
  await mkdir(posixVolumeRoot, { recursive: true, mode: 0o700 });
  await chmod(posixSharedRoot, 0o700);
  // A hostPath bind mount keeps the original inode alive when an operator
  // atomically replaces or moves the runtime directory. Put the resolved
  // directory identity on both Pod templates so re-running the installer
  // recreates CubeMaster/Cubelet instead of silently retaining a stale mount.
  const sharedRootMetadata = await stat(posixSharedRoot);
  const sharedRootIdentity = `${String(sharedRootMetadata.dev)}-${String(sharedRootMetadata.ino)}`;
  await chmod(posixVolumeRoot, 0o700);
  const pod = await captureKubectl([
    "-n",
    "cube-system",
    "get",
    "pod",
    "-l",
    "app.kubernetes.io/component=cube-node",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]);
  if (pod.length < 1) throw new Error("Cubelet Pod was unavailable for plugin configuration");
  const cubeletConfig = withCubeletPosixVolumePlugin(
    await captureKubectl([
      "-n",
      "cube-system",
      "exec",
      pod,
      "-c",
      "cubelet",
      "--",
      "cat",
      "/usr/local/services/cubetoolbox/Cubelet/config/config.toml",
    ]),
  );
  const masterSecret = JSON.parse(
    await captureKubectl([
      "-n",
      "cube-system",
      "get",
      "secret",
      "cube-master-config",
      "-o",
      "json",
    ]),
  );
  const encodedMasterConfig = masterSecret?.data?.["conf.yaml"];
  if (typeof encodedMasterConfig !== "string") {
    throw new Error("CubeMaster configuration Secret was invalid");
  }
  const masterConfig = withCubeMasterPosixVolumePlugin(
    Buffer.from(encodedMasterConfig, "base64").toString("utf8"),
  );
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-cube-posix-volume-"));
  try {
    const cubeletConfigPath = join(temporary, "cubelet-config.toml");
    await writeFile(cubeletConfigPath, cubeletConfig, { mode: 0o600 });
    const configMap = await captureKubectl([
      "-n",
      "cube-system",
      "create",
      "configmap",
      posixVolumePluginConfigMap,
      `--from-file=cubelet-config.toml=${cubeletConfigPath}`,
      `--from-file=cube-volume-picloud-posix=${posixVolumePluginSource}`,
      "--dry-run=client",
      "-o",
      "json",
    ]);
    await runKubectl(["apply", "-f", "-"], { input: configMap });
    await runKubectl([
      "-n",
      "cube-system",
      "patch",
      "secret",
      "cube-master-config",
      "--type=merge",
      "-p",
      JSON.stringify({
        data: { "conf.yaml": Buffer.from(masterConfig, "utf8").toString("base64") },
      }),
    ]);
    await runKubectl([
      "-n",
      "cube-system",
      "patch",
      "deployment",
      "cube-master",
      "--type=strategic",
      "-p",
      JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                "pi-cloud.io/posix-shared-root-identity": sharedRootIdentity,
              },
            },
            spec: {
              containers: [
                {
                  name: "cube-master",
                  volumeMounts: [
                    {
                      name: "picloud-posix-volume-plugin",
                      mountPath:
                        "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
                      subPath: "cube-volume-picloud-posix",
                      readOnly: true,
                    },
                    {
                      name: "picloud-posix-shared",
                      mountPath: "/data/cube-shared",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: "picloud-posix-volume-plugin",
                  configMap: { name: posixVolumePluginConfigMap, defaultMode: 365 },
                },
                {
                  name: "picloud-posix-shared",
                  hostPath: { path: posixSharedRoot, type: "Directory" },
                },
              ],
            },
          },
        },
      }),
    ]);
    await runKubectl([
      "-n",
      "cube-system",
      "patch",
      "daemonset",
      "cube-node",
      "--type=strategic",
      "-p",
      JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                "pi-cloud.io/posix-shared-root-identity": sharedRootIdentity,
              },
            },
            spec: {
              containers: [
                {
                  name: "cubelet",
                  volumeMounts: [
                    {
                      name: "picloud-posix-volume-plugin",
                      mountPath: "/opt/cube-image/Cubelet/plugin/cube-volume-picloud-posix",
                      subPath: "cube-volume-picloud-posix",
                      readOnly: true,
                    },
                    {
                      name: "picloud-posix-volume-plugin",
                      mountPath: "/opt/cube-image/Cubelet/config/config.toml",
                      subPath: "cubelet-config.toml",
                      readOnly: true,
                    },
                    {
                      name: "data-cube-shared",
                      mountPath: "/data/cube-shared",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: "picloud-posix-volume-plugin",
                  configMap: { name: posixVolumePluginConfigMap, defaultMode: 365 },
                },
                {
                  name: "data-cube-shared",
                  hostPath: { path: posixSharedRoot, type: "Directory" },
                },
              ],
            },
          },
        },
      }),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await runKubectl([
    "-n",
    "cube-system",
    "rollout",
    "status",
    "deployment/cube-master",
    "--timeout=600s",
  ]);
  await runKubectl([
    "-n",
    "cube-system",
    "rollout",
    "status",
    "daemonset/cube-node",
    "--timeout=900s",
  ]);
}

async function assertCubePodMtu(expectedMtu) {
  if (expectedMtu === undefined) return;
  for (const deployment of [
    "pi-cloud-cube-api-authorizer",
    "pi-cloud-cube-template-registry",
    "cube-api",
    "cube-master",
    "cube-proxy",
  ]) {
    const mtu = await captureKubectl([
      "-n",
      "cube-system",
      "exec",
      `deployment/${deployment}`,
      "--",
      "cat",
      "/sys/class/net/eth0/mtu",
    ]);
    if (mtu !== String(expectedMtu)) {
      throw new Error(`CubeSandbox ${deployment} Pod MTU was ${mtu}; expected ${expectedMtu}`);
    }
  }
}

async function ensureSharedRootMount() {
  const propagation = await capture("findmnt", ["--noheadings", "--output", "PROPAGATION", "/"]);
  if (!["shared", "rshared"].includes(propagation)) {
    await run("mount", ["--make-rshared", "/"]);
  }
  const verified = await capture("findmnt", ["--noheadings", "--output", "PROPAGATION", "/"]);
  if (!["shared", "rshared"].includes(verified)) {
    throw new Error(`CubeSandbox requires a shared root mount; found ${verified}`);
  }

  let helper;
  try {
    helper = await readFile(k3sWslPreparePath, "utf8");
  } catch {
    return;
  }
  const command = "mount --make-rshared /";
  if (helper.includes(command)) return;
  const updated = helper.replace(/^set -eu$/mu, `set -eu\n\n${command}`);
  if (updated === helper) {
    throw new Error(`${k3sWslPreparePath} has an unexpected format`);
  }
  const temporaryPath = `${k3sWslPreparePath}.pi-cloud.tmp`;
  const mode = (await stat(k3sWslPreparePath)).mode & 0o777;
  await writeFile(temporaryPath, updated, { mode });
  await rename(temporaryPath, k3sWslPreparePath);
}

async function ensureBpfFilesystem() {
  let filesystem = "";
  try {
    filesystem = await capture("findmnt", [
      "--noheadings",
      "--output",
      "FSTYPE",
      "--mountpoint",
      "/sys/fs/bpf",
    ]);
  } catch {
    filesystem = "";
  }
  if (filesystem !== "bpf") {
    await run("mount", ["--types", "bpf", "bpf", "/sys/fs/bpf"]);
  }
  const verified = await capture("findmnt", [
    "--noheadings",
    "--output",
    "FSTYPE",
    "--mountpoint",
    "/sys/fs/bpf",
  ]);
  if (verified !== "bpf") {
    throw new Error(`CubeSandbox requires bpffs at /sys/fs/bpf; found ${verified}`);
  }

  let helper;
  try {
    helper = await readFile(k3sWslPreparePath, "utf8");
  } catch {
    return;
  }
  const command = "mountpoint -q /sys/fs/bpf || mount -t bpf bpf /sys/fs/bpf";
  if (helper.includes(command)) return;
  const anchor = "mount --make-rshared /";
  const updated = helper.replace(anchor, `${anchor}\n${command}`);
  if (updated === helper) {
    throw new Error(`${k3sWslPreparePath} is missing its shared-mount preparation`);
  }
  const temporaryPath = `${k3sWslPreparePath}.pi-cloud.tmp`;
  const mode = (await stat(k3sWslPreparePath)).mode & 0o777;
  await writeFile(temporaryPath, updated, { mode });
  await rename(temporaryPath, k3sWslPreparePath);
}

async function ensureCubeletLoopbackCapacity() {
  let metadata;
  try {
    metadata = await lstat(cubeletLoopbackImagePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${cubeletLoopbackImagePath} must be a regular file`);
  }
  if (metadata.size < cubeletLoopbackBytes) {
    await run("truncate", ["--size", cubeletLoopbackSize, cubeletLoopbackImagePath]);
  }

  let mount;
  try {
    mount = await capture("findmnt", [
      "--noheadings",
      "--output",
      "SOURCE,FSTYPE",
      "--mountpoint",
      cubeletDataPath,
    ]);
  } catch {
    return;
  }
  const [source, filesystem, ...extra] = mount.split(/\s+/u);
  if (extra.length > 0 || !/^\/dev\/loop[0-9]+$/.test(source ?? "") || filesystem !== "xfs") {
    throw new Error(`Cubelet data mount is not a loop-backed XFS filesystem: ${mount}`);
  }
  const associated = (
    await capture("losetup", [
      "--associated",
      cubeletLoopbackImagePath,
      "--noheadings",
      "--output",
      "NAME",
    ])
  )
    .split(/\s+/u)
    .filter(Boolean);
  if (!associated.includes(source)) {
    throw new Error(`${source} is not backed by ${cubeletLoopbackImagePath}`);
  }
  await run("losetup", ["--set-capacity", source]);
  await run("xfs_growfs", [cubeletDataPath]);
  const verified = await lstat(cubeletLoopbackImagePath);
  if (verified.size < cubeletLoopbackBytes) {
    throw new Error(`Cubelet loopback image did not reach at least ${cubeletLoopbackSize}`);
  }
}

async function ensureWslK3sServiceRoute() {
  const release = await readFile("/proc/sys/kernel/osrelease", "utf8");
  if (!release.toLowerCase().includes("microsoft-standard-wsl")) return;

  const addresses = localIpv4Addresses(
    await capture("ip", ["-j", "-4", "address", "show", "dev", "cni0"]),
  );
  const source = [...addresses][0];
  if (source === undefined) {
    throw new Error("K3s cni0 has no IPv4 address");
  }
  await run("ip", ["route", "replace", k3sServiceCidr, "dev", "cni0", "src", source]);
  const route = await capture("ip", ["route", "show", "exact", k3sServiceCidr]);
  if (route !== `${k3sServiceCidr} dev cni0 scope link src ${source}`) {
    throw new Error(`K3s Service route was invalid: ${route}`);
  }

  const routeHelper = `#!/bin/sh
set -eu

if ! grep -qi microsoft-standard-wsl /proc/sys/kernel/osrelease; then
  exit 0
fi

for attempt in $(seq 1 300); do
  address=$(ip -4 -o address show dev cni0 2>/dev/null | sed -n 's/.* inet \\([^/]*\\)\\/.*/\\1/p' | head -n 1)
  if [ -n "$address" ]; then
    ip route replace ${k3sServiceCidr} dev cni0 src "$address"
    exit 0
  fi
  sleep 0.1
done

echo "cni0 did not become ready" >&2
exit 1
`;
  const routeHelperTemporaryPath = `${k3sServiceRouteHelperPath}.pi-cloud.tmp`;
  await writeFile(routeHelperTemporaryPath, routeHelper, { mode: 0o755 });
  await rename(routeHelperTemporaryPath, k3sServiceRouteHelperPath);
  await chmod(k3sServiceRouteHelperPath, 0o755);

  const dropIn = `[Service]
ExecStartPost=${k3sServiceRouteHelperPath}
`;
  const dropInTemporaryPath = `${k3sServiceRouteDropInPath}.pi-cloud.tmp`;
  await writeFile(dropInTemporaryPath, dropIn, { mode: 0o644 });
  await rename(dropInTemporaryPath, k3sServiceRouteDropInPath);
  await run("systemctl", ["daemon-reload"]);

  let helper;
  try {
    helper = await readFile(k3sWslPreparePath, "utf8");
  } catch {
    return;
  }
  const obsoleteCommand = `ip route replace ${k3sServiceCidr} dev lo`;
  if (!helper.includes(obsoleteCommand)) return;
  const updated = helper.replace(`${obsoleteCommand}\n`, "");
  const temporaryPath = `${k3sWslPreparePath}.pi-cloud.tmp`;
  const mode = (await stat(k3sWslPreparePath)).mode & 0o777;
  await writeFile(temporaryPath, updated, { mode });
  await rename(temporaryPath, k3sWslPreparePath);
}

async function repositoryHead(path) {
  const head = (await readFile(join(path, ".git/HEAD"), "utf8")).trim();
  const value = head.startsWith("ref: ")
    ? (await readFile(join(path, ".git", head.slice("ref: ".length)), "utf8")).trim()
    : head;
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Repository HEAD is invalid: ${path}`);
  }
  return value;
}

async function installTemplateRegistry() {
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-cube-registry-"));
  try {
    const caCertificatePath = join(temporary, "cube-root-ca.crt");
    const caKeyPath = join(temporary, "cube-root-ca.key");
    const certificateRequestPath = join(temporary, "registry.csr");
    const certificatePath = join(temporary, "tls.crt");
    const privateKeyPath = join(temporary, "tls.key");
    const extensionsPath = join(temporary, "registry.ext");
    const serialPath = join(temporary, "cube-root-ca.srl");

    const encodedCertificate = await captureKubectl([
      "-n",
      "cube-system",
      "get",
      "secret",
      "cube-egress-ca",
      "-o",
      "jsonpath={.data.cube-root-ca\\.crt}",
    ]);
    const encodedKey = await captureKubectl([
      "-n",
      "cube-system",
      "get",
      "secret",
      "cube-egress-ca",
      "-o",
      "jsonpath={.data.cube-root-ca\\.key}",
    ]);
    const caCertificate = Buffer.from(encodedCertificate, "base64");
    const caKey = Buffer.from(encodedKey, "base64");
    if (caCertificate.byteLength < 256 || caKey.byteLength < 256) {
      throw new Error("CubeEgress CA material was invalid");
    }
    await writeFile(caCertificatePath, caCertificate, { mode: 0o600 });
    await writeFile(caKeyPath, caKey, { mode: 0o600 });
    await writeFile(
      extensionsPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:pi-cloud-cube-template-registry,DNS:pi-cloud-cube-template-registry.cube-system,DNS:pi-cloud-cube-template-registry.cube-system.svc,DNS:pi-cloud-cube-template-registry.cube-system.svc.cluster.local",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await run("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-subj",
      "/CN=pi-cloud-cube-template-registry.cube-system.svc.cluster.local",
      "-keyout",
      privateKeyPath,
      "-out",
      certificateRequestPath,
    ]);
    await run("openssl", [
      "x509",
      "-req",
      "-in",
      certificateRequestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      caKeyPath,
      "-CAserial",
      serialPath,
      "-CAcreateserial",
      "-days",
      "365",
      "-sha256",
      "-extfile",
      extensionsPath,
      "-out",
      certificatePath,
    ]);
    await run("openssl", ["verify", "-CAfile", caCertificatePath, certificatePath]);

    const secret = await captureKubectl([
      "-n",
      "cube-system",
      "create",
      "secret",
      "tls",
      templateRegistryTlsSecret,
      `--cert=${certificatePath}`,
      `--key=${privateKeyPath}`,
      "--dry-run=client",
      "-o",
      "json",
    ]);
    await runKubectl(["apply", "-f", "-"], { input: secret });
    await runKubectl(["apply", "-f", "deploy/cubesandbox/template-registry.yaml"]);
    await runKubectl([
      "-n",
      "cube-system",
      "rollout",
      "restart",
      "deployment/pi-cloud-cube-template-registry",
    ]);
    await runKubectl([
      "-n",
      "cube-system",
      "rollout",
      "status",
      "deployment/pi-cloud-cube-template-registry",
      "--timeout=300s",
    ]);

    await mkdir(templateRegistryDockerTrustDirectory, {
      recursive: true,
      mode: 0o755,
    });
    const dockerCaPath = join(templateRegistryDockerTrustDirectory, "ca.crt");
    await writeFile(dockerCaPath, caCertificate, { mode: 0o644 });
    await chmod(dockerCaPath, 0o644);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if ((await repositoryHead(cubeRepository)) !== CUBE_COMMIT) {
  throw new Error(`CubeSandbox checkout must be pinned to ${CUBE_COMMIT}`);
}
const agentDockRevision = await repositoryHead(repositoryRoot);
const authorizerImage = `${authorizerImageRepository}:${agentDockRevision}`;
const cubeEgressGatewayImage = `${cubeEgressGatewayImageRepository}:${agentDockRevision}`;
await capture("test", ["-r", kubeconfig]);
await capture("test", ["-r", credentialPath]);
await capture("test", ["-r", secretValuesPath]);
await capture("test", ["-r", cubeEgressConfigTokenPath]);
await capture("test", ["-c", "/dev/kvm"]);
await capture("which", ["mkfs.xfs"]);
await capture("which", ["xfs_growfs"]);
await capture("which", ["losetup"]);
await capture("which", ["truncate"]);
await capture("which", ["helm"]);
if (kubectlCommand.startsWith("/")) {
  await capture("test", ["-x", kubectlCommand]);
} else {
  await capture("which", [kubectlCommand]);
}
await ensureHostInotifyCapacity();
const nodeNetwork = await ensureStableWslNodeAddress();
await ensureSharedRootMount();
await ensureBpfFilesystem();
await ensureWslK3sServiceRoute();
await ensureCubeletLoopbackCapacity();

const nodeName = assertSingleNode(await captureKubectl(["get", "nodes", "-o", "json"]));
await runKubectl([
  "label",
  "node",
  nodeName,
  "cube.tencent.com/cube-control=true",
  "cube.tencent.com/cube-node=true",
  "--overwrite",
]);

await run("docker", [
  "build",
  "--file",
  "packages/cube-api-authorizer/Dockerfile",
  "--build-arg",
  `PI_CLOUD_VERSION=cube-primary`,
  "--build-arg",
  `PI_CLOUD_REVISION=${agentDockRevision}`,
  "--tag",
  authorizerImage,
  ".",
]);
await run("docker", [
  "build",
  "--file",
  "packages/cube-egress-gateway/Dockerfile",
  "--build-arg",
  "PI_CLOUD_VERSION=cube-primary",
  "--build-arg",
  `PI_CLOUD_REVISION=${agentDockRevision}`,
  "--tag",
  cubeEgressGatewayImage,
  ".",
]);

await stagePinnedK3sImages("pi-cloud-cube-platform-local.tar", [
  authorizerImage,
  cubeEgressGatewayImage,
]);
// `kubectl apply` owns the namespace declaratively without printing any
// credential. Generate the Secret JSON in memory and stream it to apply.
const namespace = await captureKubectl([
  "create",
  "namespace",
  "cube-system",
  "--dry-run=client",
  "-o",
  "json",
]);
await runKubectl(["apply", "-f", "-"], { input: namespace });
const secret = await captureKubectl([
  "-n",
  "cube-system",
  "create",
  "secret",
  "generic",
  "pi-cloud-cube-api-credential",
  `--from-file=api-key=${credentialPath}`,
  "--dry-run=client",
  "-o",
  "json",
]);
await runKubectl(["apply", "-f", "-"], { input: secret });
const egressSecret = await captureKubectl([
  "-n",
  "cube-system",
  "create",
  "secret",
  "generic",
  "pi-cloud-cube-egress-config",
  `--from-file=config-token=${cubeEgressConfigTokenPath}`,
  "--dry-run=client",
  "-o",
  "json",
]);
await runKubectl(["apply", "-f", "-"], { input: egressSecret });
await runKubectl(["apply", "-f", "deploy/cubesandbox/authorizer.yaml"]);
await runKubectl(["apply", "-f", "deploy/cubesandbox/egress-gateway.yaml"]);
await runKubectl([
  "-n",
  "cube-system",
  "set",
  "image",
  "deployment/pi-cloud-cube-api-authorizer",
  `authorizer=${authorizerImage}`,
]);
await runKubectl([
  "-n",
  "cube-system",
  "set",
  "image",
  "deployment/pi-cloud-cube-egress-gateway",
  `gateway=${cubeEgressGatewayImage}`,
]);
await runKubectl([
  "-n",
  "cube-system",
  "rollout",
  "status",
  "deployment/pi-cloud-cube-api-authorizer",
  "--timeout=180s",
]);
await waitForRunningPod("app.kubernetes.io/name=pi-cloud-cube-egress-gateway", 180_000);

await run("helm", [
  "upgrade",
  "--install",
  "cube",
  join(cubeRepository, "deploy/kubernetes/chart"),
  "--namespace",
  "cube-system",
  "--values",
  join(cubeRepository, "deploy/kubernetes/chart/values-single-node.yaml"),
  "--values",
  resolve(repositoryRoot, "deploy/cubesandbox/values-pi-cloud-single-node.yaml"),
  "--values",
  secretValuesPath,
  "--wait",
  "--timeout",
  "90m",
]);
await ensureCubeletLoopbackCapacity();
await installPosixVolumePlugin();
if (nodeNetwork.changed) {
  await restartCubeWorkloadsAfterNetworkChange();
}
await installTemplateRegistry();
await assertCubePodMtu(nodeNetwork.podNetworkMtu);

const services = JSON.parse(
  await captureKubectl(["-n", "cube-system", "get", "services", "-o", "json"]),
);
const serviceAddress = (component, portName) => {
  const service = services.items.find(
    (candidate) => candidate.metadata?.labels?.["app.kubernetes.io/component"] === component,
  );
  const port = service?.spec?.ports?.find((candidate) => candidate.name === portName)?.port;
  const host = service?.spec?.clusterIP;
  if (
    typeof host !== "string" ||
    !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host) ||
    !Number.isSafeInteger(port)
  ) {
    throw new Error(`CubeSandbox ${component} Service address is invalid`);
  }
  return { host, port };
};
const cluster = {
  formatVersion: 1,
  cubeCommit: CUBE_COMMIT,
  nodeName,
  api: serviceAddress("api", "http-api"),
  master: serviceAddress("master", "cubemaster"),
  proxy: serviceAddress("cube-proxy", "http"),
  registry: serviceAddress("template-registry", "https-registry"),
  sandboxDomain: "cube.app",
  pvmHostBootstrap: false,
  ...(nodeNetwork.podNetworkMtu === undefined ? {} : { podNetworkMtu: nodeNetwork.podNetworkMtu }),
};
const evidencePath = resolve(runtimeDirectory, "cubesandbox/cluster.json");
await writeFile(evidencePath, `${JSON.stringify(cluster, null, 2)}\n`, { mode: 0o600 });
const credentialOwner = await stat(credentialPath);
await chown(evidencePath, credentialOwner.uid, credentialOwner.gid);
await chmod(evidencePath, 0o600);
const cliPod = await captureKubectl([
  "-n",
  "cube-system",
  "get",
  "pods",
  "-l",
  "app.kubernetes.io/component=cubemastercli",
  "-o",
  "jsonpath={.items[0].metadata.name}",
]);
if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(cliPod)) {
  throw new Error("CubeMaster CLI Pod identity is invalid");
}
const cliTemporaryDirectory = await mkdtemp(
  resolve(runtimeDirectory, "cubesandbox/.cubemastercli-"),
);
const cliTemporaryPath = join(cliTemporaryDirectory, "cubemastercli");
try {
  await runKubectl([
    "-n",
    "cube-system",
    "cp",
    `${cliPod}:/usr/local/bin/cubemastercli`,
    cliTemporaryPath,
  ]);
  const cliMetadata = await lstat(cliTemporaryPath);
  if (
    !cliMetadata.isFile() ||
    cliMetadata.isSymbolicLink() ||
    cliMetadata.size < 1_000_000 ||
    cliMetadata.size > 128 * 1024 * 1024
  ) {
    throw new Error("Pinned CubeMaster CLI is not a bounded regular executable");
  }
  await chown(cliTemporaryPath, credentialOwner.uid, credentialOwner.gid);
  await chmod(cliTemporaryPath, 0o700);
  await rename(cliTemporaryPath, cubeMasterCliPath);
} finally {
  await rm(cliTemporaryDirectory, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ installed: true, evidencePath, ...cluster })}\n`);
