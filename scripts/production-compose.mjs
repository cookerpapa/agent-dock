import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = resolve(repositoryRoot, "deploy/production/compose.yaml");
const configuredOverride = process.env.PI_CLOUD_PRODUCTION_COMPOSE_OVERRIDE;
const composeOverride =
  configuredOverride === undefined
    ? resolve(repositoryRoot, "deploy/cubesandbox/compose.primary.yaml")
    : resolve(repositoryRoot, configuredOverride);
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environmentFile = resolve(runtimeDirectory, ".env");
const input = process.argv.slice(2);
if (input.length === 0) throw new Error("A Docker Compose command is required");
const [command, ...commandArguments] = input;
const positionalCommandArguments = commandArguments.filter((argument) => !argument.startsWith("-"));
const recreatesOnlyControlPlane =
  command === "up" &&
  positionalCommandArguments.length === 1 &&
  positionalCommandArguments[0] === "control-plane";
const runtimeEnvironment = Object.fromEntries(
  (await readFile(environmentFile, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const delimiter = line.indexOf("=");
      if (delimiter < 1) throw new Error("Production environment contains a malformed entry");
      return [line.slice(0, delimiter), line.slice(delimiter + 1)];
    }),
);
const piWorkerDeployment =
  process.env.PI_CLOUD_PI_WORKER_DEPLOYMENT ??
  runtimeEnvironment.PI_CLOUD_PI_WORKER_DEPLOYMENT ??
  "compose";
if (piWorkerDeployment !== "compose" && piWorkerDeployment !== "kubernetes") {
  throw new Error("PI_CLOUD_PI_WORKER_DEPLOYMENT must be compose or kubernetes");
}
const supportedOptionalProfiles = new Set(["observability", "github"]);
const requestedOptionalProfiles = (
  process.env.PI_CLOUD_PRODUCTION_PROFILES ??
  runtimeEnvironment.PI_CLOUD_PRODUCTION_PROFILES ??
  ""
)
  .split(",")
  .map((profile) => profile.trim())
  .filter((profile) => profile.length > 0);
const unsupportedOptionalProfiles = requestedOptionalProfiles.filter(
  (profile) => !supportedOptionalProfiles.has(profile),
);
if (unsupportedOptionalProfiles.length > 0) {
  throw new Error(
    `PI_CLOUD_PRODUCTION_PROFILES contains unsupported profiles: ${unsupportedOptionalProfiles.join(", ")}`,
  );
}
const allowsStaleCubeTemplate =
  recreatesOnlyControlPlane ||
  new Set(["build", "down", "stop", "kill", "rm", "ps", "logs", "exec"]).has(command);
await access(environmentFile);
if (composeOverride !== undefined) await access(composeOverride);

const applicationSecretNames = [
  "api-token",
  "database-url",
  "github-app-private-key.pem",
  "github-gateway-token",
  "github-webhook-secret",
  "grafana-admin-password",
  "metrics-token",
  "model-credential-master-key",
  "tool-broker-token",
  "sandbox-materializer-token",
  "workspace-terminal-token",
  "workspace-volume-gateway-token",
  "supervisor-enrollment-token",
  "supervisor-management-token",
  ...(!allowsStaleCubeTemplate ? ["cubesandbox-api-key"] : []),
];
const applicationSecrets = await Promise.all(
  applicationSecretNames.map((name) => lstat(resolve(runtimeDirectory, "secrets", name))),
);
const [applicationOwner] = applicationSecrets;
if (
  applicationOwner === undefined ||
  applicationOwner.uid === 0 ||
  applicationSecrets.some(
    (metadata) =>
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== applicationOwner.uid ||
      metadata.gid !== applicationOwner.gid,
  )
) {
  throw new Error("Production application secrets must share one private non-root owner");
}
for (const [relativePath, label] of [
  ["state/workspace-volume-gateway", "Workspace Volume Gateway"],
  ["state/cube-shared", "Cube shared Workspace"],
  ["state/cube-shared/volume", "Cube shared Workspace volume"],
]) {
  const state = await lstat(resolve(runtimeDirectory, relativePath));
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (state.mode & 0o077) !== 0 ||
    state.uid !== applicationOwner.uid ||
    state.gid !== applicationOwner.gid
  ) {
    throw new Error(`Production ${label} state directory must be private and non-root`);
  }
}

async function readPrivateRuntimeJson(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  let value;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== applicationOwner.uid ||
      metadata.gid !== applicationOwner.gid ||
      metadata.size < 2 ||
      metadata.size > 64 * 1_024
    ) {
      throw new Error(`${label} must be a bounded private runtime file`);
    }
    value = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const clusterPath = resolve(runtimeDirectory, "cubesandbox/cluster.json");
const templatePath = resolve(runtimeDirectory, "cubesandbox/template.json");
const cluster = allowsStaleCubeTemplate
  ? await readPrivateRuntimeJson(clusterPath, "CubeSandbox cluster evidence").catch(() => undefined)
  : await readPrivateRuntimeJson(clusterPath, "CubeSandbox cluster evidence");
const template = allowsStaleCubeTemplate
  ? await readPrivateRuntimeJson(templatePath, "CubeSandbox template evidence").catch(
      () => undefined,
    )
  : await readPrivateRuntimeJson(templatePath, "CubeSandbox template evidence");
const invalidClusterEvidence =
  cluster?.formatVersion !== 1 ||
  cluster?.cubeCommit !== "8721dd151971ce3c2966482bbd32904ad98f378e" ||
  cluster?.podNetworkMtu !== 1_450 ||
  isIP(cluster?.master?.host ?? "") !== 4 ||
  !Number.isSafeInteger(cluster?.master?.port) ||
  cluster.master.port < 1 ||
  cluster.master.port > 65_535 ||
  isIP(cluster?.registry?.host ?? "") !== 4 ||
  !Number.isSafeInteger(cluster?.registry?.port) ||
  cluster.registry.port < 1 ||
  cluster.registry.port > 65_535 ||
  isIP(cluster?.api?.host ?? "") !== 4 ||
  !Number.isSafeInteger(cluster?.api?.port) ||
  cluster.api.port < 1 ||
  cluster.api.port > 65_535 ||
  isIP(cluster?.proxy?.host ?? "") !== 4 ||
  !Number.isSafeInteger(cluster?.proxy?.port) ||
  cluster.proxy.port < 1 ||
  cluster.proxy.port > 65_535 ||
  cluster?.sandboxDomain !== "cube.app";
if (!allowsStaleCubeTemplate && invalidClusterEvidence) {
  throw new Error("CubeSandbox cluster evidence is not the validated primary profile");
}
const invalidTemplateEvidence =
  template?.formatVersion !== 2 ||
  template?.cubeCommit !== cluster?.cubeCommit ||
  !/^sha256:[a-f0-9]{64}$/.test(template?.imageDigest ?? "") ||
  !/^[a-f0-9]{40}$/.test(template?.imageRevision ?? "") ||
  !/^tpl-[a-z0-9]{24}$/.test(template?.agent?.templateId ?? "") ||
  !/^[a-f0-9]{64}$/.test(template?.agent?.templateSpecSha256 ?? "") ||
  !["starter", "standard", "performance"].every(
    (key) =>
      /^tpl-[a-z0-9]{24}$/.test(template?.development?.[key]?.templateId ?? "") &&
      /^[a-f0-9]{64}$/.test(template?.development?.[key]?.templateSpecSha256 ?? ""),
  );
if (!allowsStaleCubeTemplate && invalidTemplateEvidence) {
  throw new Error("CubeSandbox READY template evidence is invalid");
}
const repositoryRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();
const imageRevision =
  process.env.PI_CLOUD_IMAGE_REVISION ??
  (command === "build" || invalidTemplateEvidence ? repositoryRevision : template.imageRevision);
if (!/^[0-9a-f]{40}$/.test(imageRevision)) {
  throw new Error("PI_CLOUD_IMAGE_REVISION must be a full lowercase Git commit");
}
if (
  !allowsStaleCubeTemplate &&
  template !== undefined &&
  template.imageRevision !== imageRevision
) {
  throw new Error(
    "CubeSandbox READY template does not match this PiCloud Git revision; register a fresh immutable template",
  );
}
const cubeEnvironment = {
  PI_CLOUD_CUBESANDBOX_TEMPLATE_ID:
    invalidTemplateEvidence || template === undefined
      ? "tpl-000000000000000000000000"
      : template.agent.templateId,
  PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS:
    invalidTemplateEvidence || template === undefined
      ? JSON.stringify({
          starter: "tpl-000000000000000000000000",
          standard: "tpl-000000000000000000000000",
          performance: "tpl-000000000000000000000000",
        })
      : JSON.stringify(
          Object.fromEntries(
            ["starter", "standard", "performance"].map((key) => [
              key,
              template.development[key].templateId,
            ]),
          ),
        ),
  PI_CLOUD_CUBESANDBOX_DOMAIN:
    invalidClusterEvidence || cluster === undefined ? "cube.app" : cluster.sandboxDomain,
  PI_CLOUD_CUBESANDBOX_API_NODE_IP:
    invalidClusterEvidence || cluster === undefined ? "127.0.0.1" : cluster.api.host,
  PI_CLOUD_CUBESANDBOX_API_NODE_PORT:
    invalidClusterEvidence || cluster === undefined ? "3000" : String(cluster.api.port),
  PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP:
    invalidClusterEvidence || cluster === undefined ? "127.0.0.1" : cluster.proxy.host,
  PI_CLOUD_CUBESANDBOX_PROXY_NODE_PORT:
    invalidClusterEvidence || cluster === undefined ? "80" : String(cluster.proxy.port),
};

const profileArguments = [
  ...(command === "build" ? ["--profile", "image-only"] : []),
  ...(piWorkerDeployment === "compose" || new Set(["down", "stop", "kill", "rm"]).has(command)
    ? ["--profile", "compose-pi-workers"]
    : []),
  ...[
    ...new Set([
      ...requestedOptionalProfiles,
      ...(new Set(["down", "stop", "kill", "rm"]).has(command)
        ? [...supportedOptionalProfiles]
        : []),
    ]),
  ].flatMap((profile) => ["--profile", profile]),
];
const serviceArguments =
  command === "build" && commandArguments.length === 0
    ? [
        "control-plane",
        "supervisor-host",
        "tool-broker",
        "web",
        "provider-egress-relay-image",
        ...(requestedOptionalProfiles.includes("github") ? ["github-gateway"] : []),
      ]
    : commandArguments;
const args = [
  "compose",
  "--env-file",
  environmentFile,
  "--file",
  composeFile,
  ...(composeOverride === undefined ? [] : ["--file", composeOverride]),
  ...profileArguments,
  command,
  ...serviceArguments,
];

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("docker", args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PI_CLOUD_IMAGE_REVISION: imageRevision,
      PI_CLOUD_APPLICATION_UID: String(applicationOwner.uid),
      PI_CLOUD_APPLICATION_GID: String(applicationOwner.gid),
      PI_CLOUD_OTLP_TRACES_ENDPOINT:
        process.env.PI_CLOUD_OTLP_TRACES_ENDPOINT ??
        (requestedOptionalProfiles.includes("observability") ? "http://jaeger:4318/v1/traces" : ""),
      ...cubeEnvironment,
    },
    stdio: "inherit",
  });
  child.once("error", () => rejectPromise(new Error("Docker Compose could not start")));
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else {
      rejectPromise(
        new Error(`Docker Compose failed (code=${String(code)}, signal=${String(signal)})`),
      );
    }
  });
});
