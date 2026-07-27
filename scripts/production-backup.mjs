import {
  mkdtemp,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_VOLUMES,
  archiveVolume,
  assertNoRunningProjectContainers,
  capture,
  dockerVolumeExists,
  encryptBackup,
  exists,
  readPassphrase,
  run,
  sha256File,
  validateProjectName,
  volumeName,
} from "./production-backup-common.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function parseArguments(argv) {
  const result = {
    output: undefined,
    passphraseFile: undefined,
    runtimeDirectory:
      process.env.AGENT_DOCK_RUNTIME_DIRECTORY ??
      resolve(repositoryRoot, "deploy/production/runtime"),
    projectName: process.env.COMPOSE_PROJECT_NAME ?? "agent-dock-production",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--output", "--passphrase-file", "--runtime-dir", "--project-name"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--output") result.output = value;
      if (argument === "--passphrase-file") result.passphraseFile = value;
      if (argument === "--runtime-dir") result.runtimeDirectory = value;
      if (argument === "--project-name") result.projectName = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run production:backup -- --output FILE.adbackup --passphrase-file PRIVATE_FILE [--runtime-dir PATH] [--project-name NAME]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown backup argument: ${argument}`);
  }
  if (result.output === undefined || result.passphraseFile === undefined) {
    throw new Error("--output and --passphrase-file are required");
  }
  result.output = resolve(repositoryRoot, result.output);
  result.passphraseFile = resolve(repositoryRoot, result.passphraseFile);
  result.runtimeDirectory = resolve(repositoryRoot, result.runtimeDirectory);
  result.projectName = validateProjectName(result.projectName);
  if (!isAbsolute(result.output) || !isAbsolute(result.runtimeDirectory)) {
    throw new Error("Resolved backup paths must be absolute");
  }
  return result;
}

async function assertRuntimeTree(path) {
  let entries = 0;
  async function walk(current) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Production runtime contains an unsupported entry: ${current}`);
    }
    entries += 1;
    if (entries > 10_000) throw new Error("Production runtime contains too many entries");
    if (!metadata.isDirectory()) return;
    for (const name of await readdir(current)) await walk(resolve(current, name));
  }
  await walk(path);
}

async function imageEvidence(imageVersion) {
  const repositories = [
    "control-plane",
    "supervisor-host",
    "sandbox-manager",
    "github-gateway",
    "web-ui",
    "tool-sandbox",
    "cube-egress-gateway",
  ];
  return Promise.all(
    repositories.map(async (repository) => {
      const reference = `agent-dock/${repository}:${imageVersion}`;
      return {
        reference,
        imageId: await capture("docker", ["image", "inspect", "--format", "{{.Id}}", reference]),
      };
    }),
  );
}

const options = parseArguments(process.argv.slice(2));
if (await exists(options.output))
  throw new Error(`Refusing to overwrite backup: ${options.output}`);
await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
const outputParent = await lstat(dirname(options.output));
if (!outputParent.isDirectory() || outputParent.isSymbolicLink()) {
  throw new Error("Backup output parent must be a real directory");
}
await assertRuntimeTree(options.runtimeDirectory);
await assertNoRunningProjectContainers(options.projectName);

const environmentPath = resolve(options.runtimeDirectory, ".env");
const environment = Object.fromEntries(
  (await readFile(environmentPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const imageVersion = environment.AGENT_DOCK_IMAGE_VERSION;
if (imageVersion === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(imageVersion)) {
  throw new Error("Production image version is missing or invalid");
}
await capture(process.execPath, ["scripts/production-compose.mjs", "config", "--quiet"], {
  cwd: repositoryRoot,
  environment: {
    ...process.env,
    AGENT_DOCK_RUNTIME_DIRECTORY: options.runtimeDirectory,
    COMPOSE_PROJECT_NAME: options.projectName,
  },
});
for (const logicalName of BACKUP_VOLUMES) {
  const actualName = volumeName(options.projectName, logicalName);
  if (!(await dockerVolumeExists(actualName))) {
    throw new Error(`Production volume does not exist: ${actualName}`);
  }
}

const passphrase = await readPassphrase(options.passphraseFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-dock-backup-"));
try {
  const stageDirectory = resolve(temporaryDirectory, "stage");
  const volumeDirectory = resolve(stageDirectory, "volumes");
  await mkdir(volumeDirectory, { recursive: true, mode: 0o700 });
  const runtimeArchive = resolve(stageDirectory, "runtime.tar.gz");
  await run("tar", ["-C", options.runtimeDirectory, "-czf", runtimeArchive, "."]);
  await chmod(runtimeArchive, 0o600);
  for (const logicalName of BACKUP_VOLUMES) {
    const archiveName = `${logicalName}.tar.gz`;
    await archiveVolume(volumeName(options.projectName, logicalName), volumeDirectory, archiveName);
    await chmod(resolve(volumeDirectory, archiveName), 0o600);
  }
  const relativeFiles = [
    "runtime.tar.gz",
    ...BACKUP_VOLUMES.map((name) => `volumes/${name}.tar.gz`),
  ];
  const files = await Promise.all(
    relativeFiles.map(async (path) => {
      const absolute = resolve(stageDirectory, path);
      return {
        path,
        sha256: await sha256File(absolute),
        sizeBytes: (await stat(absolute)).size,
      };
    }),
  );
  const gitCommit = await capture("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const gitDirty =
    (await capture("git", ["status", "--porcelain"], { cwd: repositoryRoot })).length > 0;
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    sourceProjectName: options.projectName,
    gitCommit,
    gitDirty,
    imageVersion,
    images: await imageEvidence(imageVersion),
    volumes: BACKUP_VOLUMES,
    files,
  };
  await writeFile(
    resolve(stageDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  const payloadArchive = resolve(temporaryDirectory, "payload.tar.gz");
  await run("tar", ["-C", stageDirectory, "-czf", payloadArchive, "."]);
  await encryptBackup(payloadArchive, options.output, passphrase);
  const backupMetadata = await stat(options.output);
  process.stdout.write(
    `${JSON.stringify({ backedUp: true, output: options.output, sizeBytes: backupMetadata.size, manifest })}\n`,
  );
} catch (error) {
  await rm(options.output, { force: true }).catch(() => undefined);
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
