import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_VOLUMES,
  assertNoRunningProjectContainers,
  capture,
  decryptBackup,
  dockerVolumeExists,
  exists,
  readPassphrase,
  restoreVolume,
  run,
  sha256File,
  validateProjectName,
  volumeName,
} from "./production-backup-common.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function parseArguments(argv) {
  const result = {
    input: undefined,
    passphraseFile: undefined,
    runtimeDirectory: undefined,
    projectName: undefined,
    confirmedEmpty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--input", "--passphrase-file", "--runtime-dir", "--project-name"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--input") result.input = value;
      if (argument === "--passphrase-file") result.passphraseFile = value;
      if (argument === "--runtime-dir") result.runtimeDirectory = value;
      if (argument === "--project-name") result.projectName = value;
      index += 1;
      continue;
    }
    if (argument === "--confirm-empty") {
      result.confirmedEmpty = true;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run production:restore -- --input FILE.adbackup --passphrase-file PRIVATE_FILE --runtime-dir EMPTY_PATH --project-name NEW_NAME --confirm-empty\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown restore argument: ${argument}`);
  }
  if (
    result.input === undefined ||
    result.passphraseFile === undefined ||
    result.runtimeDirectory === undefined ||
    result.projectName === undefined ||
    !result.confirmedEmpty
  ) {
    throw new Error(
      "--input, --passphrase-file, --runtime-dir, --project-name, and --confirm-empty are required",
    );
  }
  return {
    input: resolve(repositoryRoot, result.input),
    passphraseFile: resolve(repositoryRoot, result.passphraseFile),
    runtimeDirectory: resolve(repositoryRoot, result.runtimeDirectory),
    projectName: validateProjectName(result.projectName),
  };
}

function safeArchivePath(raw) {
  const value = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (value === "") return "";
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`Backup archive contains an unsafe path: ${raw}`);
  }
  return value;
}

async function validatePayloadArchive(path) {
  const entries = (await capture("tar", ["-tzf", path]))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(safeArchivePath)
    .filter(Boolean);
  const allowed = new Set([
    "manifest.json",
    "runtime.tar.gz",
    "volumes",
    ...BACKUP_VOLUMES.map((name) => `volumes/${name}.tar.gz`),
  ]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error("Backup payload contains an unexpected entry");
  }
  for (const required of [
    "manifest.json",
    "runtime.tar.gz",
    ...BACKUP_VOLUMES.map((name) => `volumes/${name}.tar.gz`),
  ]) {
    if (!entries.includes(required)) throw new Error(`Backup payload is missing ${required}`);
  }
}

function validateManifest(value) {
  if (
    value?.formatVersion !== BACKUP_FORMAT_VERSION ||
    typeof value?.createdAt !== "string" ||
    typeof value?.sourceProjectName !== "string" ||
    typeof value?.gitCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.gitCommit) ||
    typeof value?.gitDirty !== "boolean" ||
    typeof value?.imageVersion !== "string" ||
    !Array.isArray(value?.images) ||
    !Array.isArray(value?.volumes) ||
    !Array.isArray(value?.files) ||
    JSON.stringify(value.volumes) !== JSON.stringify(BACKUP_VOLUMES)
  ) {
    throw new Error("Backup manifest is invalid or unsupported");
  }
  const expectedImages = new Set([
    ...[
      "control-plane",
      "supervisor-host",
      "sandbox-manager",
      "github-gateway",
      "web-ui",
      "provider-egress-relay",
    ].map((repository) => `agent-dock/${repository}:${value.imageVersion}`),
    "agent-dock/cube-api-authorizer:local",
    "agent-dock/cube-egress-gateway:local",
    `localhost:5000/agent-dock/cubesandbox-tool:${value.gitCommit}`,
  ]);
  for (const image of value.images) {
    if (typeof image?.reference !== "string" || !expectedImages.delete(image.reference)) {
      throw new Error("Backup image evidence is invalid or duplicated");
    }
  }
  if (expectedImages.size !== 0) {
    throw new Error("Backup image evidence does not cover the current execution architecture");
  }
  const expectedFiles = new Set([
    "runtime.tar.gz",
    ...BACKUP_VOLUMES.map((name) => `volumes/${name}.tar.gz`),
  ]);
  for (const file of value.files) {
    if (
      typeof file?.path !== "string" ||
      !expectedFiles.delete(file.path) ||
      typeof file?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file?.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      throw new Error("Backup manifest file evidence is invalid");
    }
  }
  if (expectedFiles.size !== 0) throw new Error("Backup manifest does not cover every authority");
  return value;
}

async function verifyImages(images) {
  for (const image of images) {
    if (
      typeof image?.reference !== "string" ||
      !/^(?:agent-dock\/[a-z-]+:[A-Za-z0-9][A-Za-z0-9_.-]*|localhost:5000\/agent-dock\/cubesandbox-tool:[0-9a-f]{40})$/.test(
        image.reference,
      ) ||
      typeof image?.imageId !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.imageId)
    ) {
      throw new Error("Backup image evidence is invalid");
    }
    const localId = await capture("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image.reference,
    ]);
    if (localId !== image.imageId) {
      throw new Error(`Local image does not match backup evidence: ${image.reference}`);
    }
  }
}

async function validateInnerArchive(path, maximumEntries = 10_000) {
  const entries = (await capture("tar", ["-tzf", path])).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > maximumEntries) {
    throw new Error("Runtime archive entry count is invalid");
  }
  entries.forEach(safeArchivePath);
}

async function hardenRuntimeTree(path, uid, gid) {
  async function walk(current) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Restored runtime contains an unsupported entry: ${current}`);
    }
    await chmod(current, metadata.isDirectory() ? 0o700 : 0o600);
    if (process.getuid?.() === 0) await chown(current, uid, gid);
    if (metadata.isDirectory()) {
      for (const name of await readdir(current)) await walk(resolve(current, name));
    }
  }
  await walk(path);
}

async function rebindRuntime(path) {
  const environmentPath = resolve(path, ".env");
  const lines = (await readFile(environmentPath, "utf8")).split(/\r?\n/);
  let replaced = false;
  const rebound = lines.map((line) => {
    if (!line.startsWith("AGENT_DOCK_RUNTIME_DIRECTORY=")) return line;
    replaced = true;
    return `AGENT_DOCK_RUNTIME_DIRECTORY=${path}`;
  });
  if (!replaced) throw new Error("Restored runtime environment has no runtime-directory binding");
  const environment = Object.fromEntries(
    rebound.filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Restored production environment is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  let uid = Number(environment.AGENT_DOCK_APPLICATION_UID);
  let gid = Number(environment.AGENT_DOCK_APPLICATION_GID);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 0) {
    const applicationSecret = await lstat(resolve(path, "secrets", "api-token"));
    if (
      !applicationSecret.isFile() ||
      applicationSecret.isSymbolicLink() ||
      applicationSecret.uid < 1 ||
      applicationSecret.gid < 0
    ) {
      throw new Error("Restored application identity is invalid");
    }
    uid = applicationSecret.uid;
    gid = applicationSecret.gid;
  }
  const normalizedEnvironment = rebound.filter(
    (line) =>
      !line.startsWith("AGENT_DOCK_APPLICATION_UID=") &&
      !line.startsWith("AGENT_DOCK_APPLICATION_GID=") &&
      line.length > 0,
  );
  normalizedEnvironment.push(
    `AGENT_DOCK_APPLICATION_UID=${String(uid)}`,
    `AGENT_DOCK_APPLICATION_GID=${String(gid)}`,
    "",
  );
  await writeFile(environmentPath, normalizedEnvironment.join("\n"), { mode: 0o600 });
  const deploymentPath = resolve(path, "deployment.json");
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  if (deployment?.formatVersion !== 1) throw new Error("Restored deployment manifest is invalid");
  deployment.runtimeDirectory = path;
  deployment.restoredAt = new Date().toISOString();
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  await hardenRuntimeTree(path, uid, gid);
}

const options = parseArguments(process.argv.slice(2));
if (!(await exists(options.input))) throw new Error("Encrypted backup does not exist");
await assertNoRunningProjectContainers(options.projectName);
const anyProjectContainer = await capture("docker", [
  "ps",
  "--all",
  "--quiet",
  "--filter",
  `label=com.docker.compose.project=${options.projectName}`,
]);
if (anyProjectContainer.length > 0) {
  throw new Error("Target Compose project still has containers; run compose down first");
}
for (const logicalName of BACKUP_VOLUMES) {
  if (await dockerVolumeExists(volumeName(options.projectName, logicalName))) {
    throw new Error(
      `Target production volume already exists: ${volumeName(options.projectName, logicalName)}`,
    );
  }
}
let runtimeCreated = false;
if (await exists(options.runtimeDirectory)) {
  const metadata = await lstat(options.runtimeDirectory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await readdir(options.runtimeDirectory)).length > 0
  ) {
    throw new Error("Target runtime directory must not exist or must be an empty real directory");
  }
} else {
  await mkdir(dirname(options.runtimeDirectory), { recursive: true, mode: 0o700 });
  await mkdir(options.runtimeDirectory, { mode: 0o700 });
  runtimeCreated = true;
}

const passphrase = await readPassphrase(options.passphraseFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-dock-restore-"));
const createdVolumes = [];
let runtimePopulated = false;
try {
  const payloadArchive = resolve(temporaryDirectory, "payload.tar.gz");
  await decryptBackup(options.input, payloadArchive, passphrase);
  await validatePayloadArchive(payloadArchive);
  const stageDirectory = resolve(temporaryDirectory, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  await run("tar", ["-C", stageDirectory, "-xzf", payloadArchive]);
  const manifest = validateManifest(
    JSON.parse(await readFile(resolve(stageDirectory, "manifest.json"), "utf8")),
  );
  for (const file of manifest.files) {
    const absolute = resolve(stageDirectory, file.path);
    const metadata = await stat(absolute);
    if (metadata.size !== file.sizeBytes || (await sha256File(absolute)) !== file.sha256) {
      throw new Error(`Backup authority hash mismatch: ${file.path}`);
    }
  }
  await verifyImages(manifest.images);
  const runtimeArchive = resolve(stageDirectory, "runtime.tar.gz");
  await validateInnerArchive(runtimeArchive);
  for (const logicalName of BACKUP_VOLUMES) {
    await validateInnerArchive(
      resolve(stageDirectory, "volumes", `${logicalName}.tar.gz`),
      1_000_000,
    );
  }
  await run("tar", ["-C", options.runtimeDirectory, "-xzf", runtimeArchive]);
  runtimePopulated = true;
  await rebindRuntime(options.runtimeDirectory);
  for (const logicalName of BACKUP_VOLUMES) {
    const actualName = volumeName(options.projectName, logicalName);
    await capture("docker", [
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${options.projectName}`,
      "--label",
      `com.docker.compose.volume=${logicalName}`,
      actualName,
    ]);
    createdVolumes.push(actualName);
    await restoreVolume(actualName, resolve(stageDirectory, "volumes"), `${logicalName}.tar.gz`);
  }
  await capture(process.execPath, ["scripts/production-compose.mjs", "config", "--quiet"], {
    cwd: repositoryRoot,
    environment: {
      ...process.env,
      AGENT_DOCK_RUNTIME_DIRECTORY: options.runtimeDirectory,
      COMPOSE_PROJECT_NAME: options.projectName,
    },
  });
  process.stdout.write(
    `${JSON.stringify({ restored: true, projectName: options.projectName, runtimeDirectory: options.runtimeDirectory, sourceProjectName: manifest.sourceProjectName, gitCommit: manifest.gitCommit, imageVersion: manifest.imageVersion })}\n`,
  );
} catch (error) {
  for (const name of createdVolumes.reverse()) {
    await capture("docker", ["volume", "rm", name]).catch(() => undefined);
  }
  if (runtimePopulated || runtimeCreated) {
    await rm(options.runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
