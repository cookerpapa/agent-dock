import { execFile, spawn } from "node:child_process";
import {
  chmod,
  chown,
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
  process.env.AGENT_DOCK_CUBESANDBOX_REPOSITORY ?? "../CubeSandbox",
);
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const credentialPath = resolve(runtimeDirectory, "secrets/cubesandbox-api-key");
const secretValuesPath = resolve(runtimeDirectory, "cubesandbox/secret-values.yaml");
const authorizerImage = "agent-dock/cube-api-authorizer:local";
const cubeEgressGatewayImage = "agent-dock/cube-egress-gateway:local";
const cubeEgressConfigTokenPath = resolve(runtimeDirectory, "secrets/cube-egress-config-token");
const wslStableNodeIp = "10.255.255.254";
const wslStableNodeInterface = "agentdock0";
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
const k3sConfigPath = "/etc/rancher/k3s/config.yaml";
const k3sWslPreparePath = "/usr/local/libexec/agent-dock-prepare-k3s-wsl";
const k3sServiceRouteHelperPath = "/usr/local/libexec/agent-dock-route-k3s-services";
const k3sServiceRouteDropInPath =
  "/etc/systemd/system/k3s.service.d/agent-dock-cube-service-route.conf";
const k3sServiceCidr = "10.43.0.0/16";
const templateRegistryTlsSecret = "agent-dock-cube-template-registry-tls";
const templateRegistryDockerTrustDirectory = "/etc/docker/certs.d/localhost:5000";

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

function stableWslInterfacePreparation() {
  return `# AgentDock gives K3s a stable WSL node address on an MTU-bounded
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
  const start = "# BEGIN AGENT_DOCK_WSL_NODE_INTERFACE";
  const end = "# END AGENT_DOCK_WSL_NODE_INTERFACE";
  const block = `${start}\n${stableWslInterfacePreparation()}\n${end}`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`, "u");
  const updated = expression.test(helper)
    ? helper.replace(expression, block)
    : helper.replace(/^set -eu$/mu, `set -eu\n\n${block}`);
  if (updated === helper) return false;
  if (!updated.includes(block)) {
    throw new Error(`${k3sWslPreparePath} has an unexpected format`);
  }
  const temporaryPath = `${k3sWslPreparePath}.agent-dock.tmp`;
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
    const nodes = JSON.parse(
      await capture("kubectl", ["get", "nodes", "-o", "json"], 5_000),
    )?.items;
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

  const temporaryPath = `${k3sConfigPath}.agent-dock.tmp`;
  const mode = (await stat(k3sConfigPath)).mode & 0o777;
  if (updated !== original) {
    await writeFile(temporaryPath, updated, { mode });
    await rename(temporaryPath, k3sConfigPath);
  }

  await run("systemctl", ["restart", "k3s"]);
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const value = JSON.parse(await capture("kubectl", ["get", "nodes", "-o", "json"], 5_000));
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
    await run("kubectl", ["-n", "cube-system", "rollout", "restart", kind]);
  }
  const resources = (
    await capture("kubectl", [
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
    await run("kubectl", ["-n", "cube-system", "rollout", "status", resource, "--timeout=600s"]);
  }
}

async function assertCubePodMtu(expectedMtu) {
  if (expectedMtu === undefined) return;
  for (const deployment of [
    "agent-dock-cube-api-authorizer",
    "agent-dock-cube-template-registry",
    "cube-api",
    "cube-master",
    "cube-proxy",
  ]) {
    const mtu = await capture("kubectl", [
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
  const temporaryPath = `${k3sWslPreparePath}.agent-dock.tmp`;
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
  const temporaryPath = `${k3sWslPreparePath}.agent-dock.tmp`;
  const mode = (await stat(k3sWslPreparePath)).mode & 0o777;
  await writeFile(temporaryPath, updated, { mode });
  await rename(temporaryPath, k3sWslPreparePath);
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
  const routeHelperTemporaryPath = `${k3sServiceRouteHelperPath}.agent-dock.tmp`;
  await writeFile(routeHelperTemporaryPath, routeHelper, { mode: 0o755 });
  await rename(routeHelperTemporaryPath, k3sServiceRouteHelperPath);
  await chmod(k3sServiceRouteHelperPath, 0o755);

  const dropIn = `[Service]
ExecStartPost=${k3sServiceRouteHelperPath}
`;
  const dropInTemporaryPath = `${k3sServiceRouteDropInPath}.agent-dock.tmp`;
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
  const temporaryPath = `${k3sWslPreparePath}.agent-dock.tmp`;
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
  const temporary = await mkdtemp(join(tmpdir(), "agent-dock-cube-registry-"));
  try {
    const caCertificatePath = join(temporary, "cube-root-ca.crt");
    const caKeyPath = join(temporary, "cube-root-ca.key");
    const certificateRequestPath = join(temporary, "registry.csr");
    const certificatePath = join(temporary, "tls.crt");
    const privateKeyPath = join(temporary, "tls.key");
    const extensionsPath = join(temporary, "registry.ext");
    const serialPath = join(temporary, "cube-root-ca.srl");

    const encodedCertificate = await capture("kubectl", [
      "-n",
      "cube-system",
      "get",
      "secret",
      "cube-egress-ca",
      "-o",
      "jsonpath={.data.cube-root-ca\\.crt}",
    ]);
    const encodedKey = await capture("kubectl", [
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
        "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:agent-dock-cube-template-registry,DNS:agent-dock-cube-template-registry.cube-system,DNS:agent-dock-cube-template-registry.cube-system.svc,DNS:agent-dock-cube-template-registry.cube-system.svc.cluster.local",
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
      "/CN=agent-dock-cube-template-registry.cube-system.svc.cluster.local",
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

    const secret = await capture("kubectl", [
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
    await run("kubectl", ["apply", "-f", "-"], { input: secret });
    await run("kubectl", ["apply", "-f", "deploy/cubesandbox/template-registry.yaml"]);
    await run("kubectl", [
      "-n",
      "cube-system",
      "rollout",
      "restart",
      "deployment/agent-dock-cube-template-registry",
    ]);
    await run("kubectl", [
      "-n",
      "cube-system",
      "rollout",
      "status",
      "deployment/agent-dock-cube-template-registry",
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
await capture("test", ["-r", kubeconfig]);
await capture("test", ["-r", credentialPath]);
await capture("test", ["-r", secretValuesPath]);
await capture("test", ["-r", cubeEgressConfigTokenPath]);
await capture("test", ["-c", "/dev/kvm"]);
await capture("which", ["mkfs.xfs"]);
await capture("which", ["helm"]);
const nodeNetwork = await ensureStableWslNodeAddress();
await ensureSharedRootMount();
await ensureBpfFilesystem();
await ensureWslK3sServiceRoute();

const nodeName = assertSingleNode(await capture("kubectl", ["get", "nodes", "-o", "json"]));
await run("kubectl", [
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
  `AGENT_DOCK_VERSION=cube-primary`,
  "--build-arg",
  `AGENT_DOCK_REVISION=${await repositoryHead(repositoryRoot)}`,
  "--tag",
  authorizerImage,
  ".",
]);
await run("docker", [
  "build",
  "--file",
  "packages/cube-egress-gateway/Dockerfile",
  "--build-arg",
  "AGENT_DOCK_VERSION=cube-primary",
  "--build-arg",
  `AGENT_DOCK_REVISION=${await repositoryHead(repositoryRoot)}`,
  "--tag",
  cubeEgressGatewayImage,
  ".",
]);

const temporary = await mkdtemp(join(tmpdir(), "agent-dock-cube-install-"));
try {
  const archive = join(temporary, "cube-api-authorizer.tar");
  await run("docker", ["image", "save", "--output", archive, authorizerImage]);
  await run("ctr", [
    "--address",
    "/run/k3s/containerd/containerd.sock",
    "--namespace",
    "k8s.io",
    "images",
    "import",
    "--all-platforms",
    archive,
  ]);
  const egressArchive = join(temporary, "cube-egress-gateway.tar");
  await run("docker", ["image", "save", "--output", egressArchive, cubeEgressGatewayImage]);
  await run("ctr", [
    "--address",
    "/run/k3s/containerd/containerd.sock",
    "--namespace",
    "k8s.io",
    "images",
    "import",
    "--all-platforms",
    egressArchive,
  ]);

  // `kubectl apply` owns the namespace declaratively without printing any
  // credential. Generate the Secret JSON in memory and stream it to apply.
  const namespace = await capture("kubectl", [
    "create",
    "namespace",
    "cube-system",
    "--dry-run=client",
    "-o",
    "json",
  ]);
  await run("kubectl", ["apply", "-f", "-"], { input: namespace });
  const secret = await capture("kubectl", [
    "-n",
    "cube-system",
    "create",
    "secret",
    "generic",
    "agent-dock-cube-api-credential",
    `--from-file=api-key=${credentialPath}`,
    "--dry-run=client",
    "-o",
    "json",
  ]);
  await run("kubectl", ["apply", "-f", "-"], { input: secret });
  const egressSecret = await capture("kubectl", [
    "-n",
    "cube-system",
    "create",
    "secret",
    "generic",
    "agent-dock-cube-egress-config",
    `--from-file=config-token=${cubeEgressConfigTokenPath}`,
    "--dry-run=client",
    "-o",
    "json",
  ]);
  await run("kubectl", ["apply", "-f", "-"], { input: egressSecret });
  await run("kubectl", ["apply", "-f", "deploy/cubesandbox/authorizer.yaml"]);
  await run("kubectl", ["apply", "-f", "deploy/cubesandbox/egress-gateway.yaml"]);
  await run("kubectl", [
    "-n",
    "cube-system",
    "rollout",
    "status",
    "deployment/agent-dock-cube-api-authorizer",
    "--timeout=180s",
  ]);
  await run("kubectl", [
    "-n",
    "cube-system",
    "rollout",
    "status",
    "deployment/agent-dock-cube-egress-gateway",
    "--timeout=180s",
  ]);

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
    resolve(repositoryRoot, "deploy/cubesandbox/values-agent-dock-single-node.yaml"),
    "--values",
    secretValuesPath,
    "--wait",
    "--timeout",
    "90m",
  ]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (nodeNetwork.changed) {
  await restartCubeWorkloadsAfterNetworkChange();
}
await installTemplateRegistry();
await assertCubePodMtu(nodeNetwork.podNetworkMtu);

const services = JSON.parse(
  await capture("kubectl", ["-n", "cube-system", "get", "services", "-o", "json"]),
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
  proxy: serviceAddress("cube-proxy", "http"),
  sandboxDomain: "cube.app",
  pvmHostBootstrap: false,
  ...(nodeNetwork.podNetworkMtu === undefined ? {} : { podNetworkMtu: nodeNetwork.podNetworkMtu }),
};
const evidencePath = resolve(runtimeDirectory, "cubesandbox/cluster.json");
await writeFile(evidencePath, `${JSON.stringify(cluster, null, 2)}\n`, { mode: 0o600 });
const credentialOwner = await stat(credentialPath);
await chown(evidencePath, credentialOwner.uid, credentialOwner.gid);
await chmod(evidencePath, 0o600);
process.stdout.write(`${JSON.stringify({ installed: true, evidencePath, ...cluster })}\n`);
