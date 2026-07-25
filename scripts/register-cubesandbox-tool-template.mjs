import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CUBE_COMMIT = "8721dd151971ce3c2966482bbd32904ad98f378e";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const kubeconfig = process.env.KUBECONFIG ?? "/etc/rancher/k3s/k3s.yaml";
const registryHost = "localhost:5000";
const registryRepository = `${registryHost}/agent-dock/cubesandbox-tool`;
const clusterRegistryRepository =
  "agent-dock-cube-template-registry.cube-system.svc.cluster.local:5000/agent-dock/cubesandbox-tool";
const templatePath = resolve(runtimeDirectory, "cubesandbox/template.json");
const clusterPath = resolve(runtimeDirectory, "cubesandbox/cluster.json");
const credentialPath = resolve(runtimeDirectory, "secrets/cubesandbox-api-key");
const nodeDirectory = dirname(process.execPath);
const environment = {
  ...process.env,
  KUBECONFIG: kubeconfig,
  PATH: `${nodeDirectory}:${process.env.PATH ?? ""}`,
};
const dockerProxyBuildArguments = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
].flatMap((name) =>
  typeof environment[name] === "string" && environment[name].length > 0
    ? ["--build-arg", name]
    : [],
);

if (process.getuid?.() !== 0) {
  throw new Error(
    "CubeSandbox template registration must run as root because it reads the K3s control-plane kubeconfig",
  );
}

function capture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: options.environment ?? environment,
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
        timeout: options.timeout ?? 30_000,
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
      env: options.environment ?? environment,
      stdio: "inherit",
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
  });
}

async function repositoryHead() {
  const revision = await capture("git", [
    "-c",
    `safe.directory=${repositoryRoot}`,
    "rev-parse",
    "HEAD",
  ]);
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("AgentDock Git revision is invalid");
  }
  return revision;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function nestedString(value, key) {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = nestedString(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function assertSuccessfulCubeResponse(value, label) {
  const code = value?.ret?.ret_code;
  if (code !== undefined && code !== 200) {
    throw new Error(`${label} failed with Cube return code ${String(code)}`);
  }
}

async function writePrivate(path, value, owner) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(dirname(path), ".template-"));
  const temporaryPath = join(temporaryDirectory, "template.json");
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chown(temporaryPath, owner.uid, owner.gid);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return { value: await handle.readFile("utf8"), metadata };
  } finally {
    await handle.close();
  }
}

async function startRegistryForward() {
  const child = spawn(
    "kubectl",
    [
      "-n",
      "cube-system",
      "port-forward",
      "service/agent-dock-cube-template-registry",
      "5000:5000",
      "--address",
      "127.0.0.1",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const ready = new Promise((resolvePromise, rejectPromise) => {
    const accept = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
      if (output.includes("Forwarding from 127.0.0.1:5000")) resolvePromise();
    };
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      rejectPromise(
        new Error(
          `Cube registry port-forward exited before readiness (code=${String(code)}, signal=${String(signal)}): ${output.trim()}`,
        ),
      );
    });
  });
  await Promise.race([
    ready,
    new Promise((_, rejectPromise) =>
      setTimeout(
        () => rejectPromise(new Error("Cube registry port-forward timed out")),
        15_000,
      ).unref(),
    ),
  ]);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const revision = await repositoryHead();
const dirty = await capture(
  "git",
  ["-c", `safe.directory=${repositoryRoot}`, "status", "--porcelain", "--untracked-files=all"],
  { timeout: 10_000 },
);
if (dirty.length > 0) {
  throw new Error("Commit AgentDock changes before registering an immutable Cube template");
}
const clusterFile = await readPrivate(clusterPath, 64 * 1_024, "Cube cluster evidence");
const cluster = parseJson(clusterFile.value, "Cube cluster evidence");
if (
  cluster?.formatVersion !== 1 ||
  cluster?.cubeCommit !== CUBE_COMMIT ||
  cluster?.podNetworkMtu !== 1_450
) {
  throw new Error("Cube cluster evidence is missing the pinned release or validated Pod MTU");
}
const credentialFile = await readPrivate(credentialPath, 4_096, "CubeAPI credential");
const credentialOwner = credentialFile.metadata;
if (
  credentialFile.value.length < 32 ||
  credentialFile.value.length > 4_096 ||
  /[\u0000-\u001f\u007f]/.test(credentialFile.value.replace(/\r?\n$/, ""))
) {
  throw new Error("CubeAPI credential is not a private bounded file");
}
if (
  clusterFile.metadata.uid !== credentialOwner.uid ||
  clusterFile.metadata.gid !== credentialOwner.gid
) {
  throw new Error("Cube cluster evidence and API credential ownership do not match");
}
await capture("test", ["-r", kubeconfig]);
await capture("test", ["-r", "/etc/docker/certs.d/localhost:5000/ca.crt"]);
await capture("kubectl", [
  "-n",
  "cube-system",
  "rollout",
  "status",
  "deployment/agent-dock-cube-template-registry",
  "--timeout=120s",
]);

const imageTag = `${registryRepository}:${revision}`;
await run("docker", [
  "build",
  "--network",
  "host",
  ...dockerProxyBuildArguments,
  "--file",
  "deploy/cubesandbox/Dockerfile.tool",
  "--build-arg",
  "AGENT_DOCK_VERSION=cube-primary",
  "--build-arg",
  `AGENT_DOCK_REVISION=${revision}`,
  "--tag",
  imageTag,
  ".",
]);
await run("npm", ["run", "cubesandbox:template-check"], {
  environment: {
    ...environment,
    AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE: imageTag,
    AGENT_DOCK_IMAGE_REVISION: revision,
  },
});

const forward = await startRegistryForward();
let digest;
try {
  await run("docker", ["push", imageTag]);
  const repoDigests = parseJson(
    await capture("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", imageTag]),
    "Docker RepoDigests",
  );
  if (!Array.isArray(repoDigests)) {
    throw new Error("Docker RepoDigests response was invalid");
  }
  const pushed = repoDigests.find((value) => value.startsWith(`${registryRepository}@sha256:`));
  digest = pushed?.slice(`${registryRepository}@`.length);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) {
    throw new Error("Pushed Cube Tool image digest was unavailable");
  }
} finally {
  await stopChild(forward);
}

const clusterImage = `${clusterRegistryRepository}@${digest}`;
const templateSpecification = Object.freeze({
  image: clusterImage,
  writableLayerSize: "1G",
  exposedPorts: [49_984],
  probePort: 49_984,
  probePath: "/health",
  cpuMillicores: 2_000,
  memoryMb: 2_000,
  cubeCaInjected: false,
  allowInternetAccess: false,
});
const templateSpecSha256 = createHash("sha256")
  .update(JSON.stringify(templateSpecification), "utf8")
  .digest("hex");
const created = parseJson(
  await capture(
    "kubectl",
    [
      "-n",
      "cube-system",
      "exec",
      "deployment/cube-cubemastercli",
      "--",
      "cubemastercli",
      "--address",
      "cube-master",
      "--port",
      "8089",
      "tpl",
      "create-from-image",
      "--image",
      clusterImage,
      "--writable-layer-size",
      "1G",
      "--expose-port",
      "49984",
      "--probe",
      "49984",
      "--probe-path",
      "/health",
      "--cpu",
      "2000",
      "--memory",
      "2000",
      "--with-cube-ca=false",
      "--detach",
      "--json",
    ],
    { timeout: 120_000 },
  ),
  "Cube template create response",
);
assertSuccessfulCubeResponse(created, "Cube template create");
const jobId = nestedString(created, "job_id");
if (!/^[0-9a-f-]{36}$/.test(jobId ?? "")) {
  throw new Error("Cube template create response did not contain a valid job ID");
}
const watched = parseJson(
  await capture(
    "kubectl",
    [
      "-n",
      "cube-system",
      "exec",
      "deployment/cube-cubemastercli",
      "--",
      "cubemastercli",
      "--address",
      "cube-master",
      "--port",
      "8089",
      "tpl",
      "watch",
      "--job-id",
      jobId,
      "--interval",
      "2s",
      "--json",
    ],
    { timeout: 30 * 60_000 },
  ),
  "Cube template watch response",
);
assertSuccessfulCubeResponse(watched, "Cube template watch");
const templateId = nestedString(watched, "template_id");
if (!/^tpl-[a-z0-9]{24}$/.test(templateId ?? "")) {
  throw new Error("Cube template watch response did not contain a valid template ID");
}

const listed = parseJson(
  await capture(
    "kubectl",
    [
      "-n",
      "cube-system",
      "exec",
      "deployment/cube-cubemastercli",
      "--",
      "cubemastercli",
      "--address",
      "cube-master",
      "--port",
      "8089",
      "tpl",
      "list",
      "--json",
    ],
    { timeout: 60_000 },
  ),
  "Cube template inventory",
);
assertSuccessfulCubeResponse(listed, "Cube template inventory");
const template = listed?.data?.find((value) => value?.template_id === templateId);
if (
  template?.status !== "READY" ||
  template?.job_id !== jobId ||
  template?.image_info !== clusterImage
) {
  throw new Error("Cube template inventory did not confirm the immutable READY template");
}

const evidence = {
  formatVersion: 1,
  cubeCommit: CUBE_COMMIT,
  imageRevision: revision,
  imageDigest: digest,
  imageReference: clusterImage,
  templateId,
  jobId,
  templateSpecSha256,
  templateSpecification,
  registeredAt: new Date().toISOString(),
};
await writePrivate(templatePath, `${JSON.stringify(evidence, null, 2)}\n`, credentialOwner);
process.stdout.write(
  `${JSON.stringify({
    registered: true,
    templatePath,
    templateId,
    imageRevision: revision,
    imageDigest: digest,
    templateSpecSha256,
  })}\n`,
);
