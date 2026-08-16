import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRuntimeDirectory = resolve(repositoryRoot, "deploy/production/runtime");
const maximumFileBytes = 16 * 1_024;

function runtimeDirectory() {
  const configured = process.env.PI_CLOUD_RUNTIME_DIRECTORY;
  const value = resolve(repositoryRoot, configured ?? defaultRuntimeDirectory);
  if (value.includes("\0") || /\r|\n/.test(value)) {
    throw new Error("CubeSandbox runtime directory is invalid");
  }
  return value;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`CubeSandbox runtime directory is not private: ${path}`);
  }
}

async function writePrivate(path, value) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function replacePrivate(path, value) {
  const temporary = resolve(dirname(path), `.tmp-${randomUUID()}`);
  try {
    await writePrivate(temporary, value);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readPrivate(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumFileBytes
    ) {
      throw new Error(`CubeSandbox runtime file is not private and bounded: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function secret() {
  return randomBytes(48).toString("base64url");
}

async function ensureCredential(path) {
  try {
    const value = (await readPrivate(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(value)) {
      throw new Error("Existing CubeAPI credential is invalid");
    }
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivate(path, `${secret()}\n`);
  return true;
}

function validSecret(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{64}$/.test(value);
}

async function ensureSecretValues(path) {
  try {
    const document = parse(await readPrivate(path));
    if (
      !validSecret(document?.mysql?.password) ||
      !validSecret(document?.mysql?.rootPassword) ||
      !validSecret(document?.redis?.password)
    ) {
      throw new Error("Existing CubeSandbox Helm secret values are invalid");
    }
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value =
    `mysql:\n` +
    `  password: "${secret()}"\n` +
    `  rootPassword: "${secret()}"\n` +
    `redis:\n` +
    `  password: "${secret()}"\n`;
  await replacePrivate(path, value);
  return true;
}

const root = runtimeDirectory();
const secretsDirectory = resolve(root, "secrets");
const cubeDirectory = resolve(root, "cubesandbox");
await privateDirectory(root);
await privateDirectory(secretsDirectory);
await privateDirectory(cubeDirectory);

const credentialPath = resolve(secretsDirectory, "cubesandbox-api-key");
const helmValuesPath = resolve(cubeDirectory, "secret-values.yaml");
const createdCredential = await ensureCredential(credentialPath);
const createdHelmValues = await ensureSecretValues(helmValuesPath);

process.stdout.write(
  `${JSON.stringify({
    runtimeDirectory: root,
    credentialPath,
    helmValuesPath,
    createdCredential,
    createdHelmValues,
  })}\n`,
);
