import { execFile, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, lstat, open, readFile, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const BACKUP_MAGIC = Buffer.from("AGENTDOCK-BACKUP-V1\0", "utf8");
export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_VOLUMES = [
  "postgres-data",
  "minio-data",
  "supervisor-boot",
  "supervisor-spool",
  "supervisor-1-boot",
  "supervisor-1-spool",
  "prometheus-data",
  "grafana-data",
  "jaeger-data",
];
const BACKUP_HELPER_IMAGE =
  "busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028";

const scrypt = promisify(scryptCallback);
const MAX_CAPTURE_BYTES = 8 * 1_024 * 1_024;

export function validateProjectName(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(
      "Compose project name must be 1-63 lowercase letters, digits, hyphens, or underscores",
    );
  }
  return value;
}

export function volumeName(projectName, logicalName) {
  validateProjectName(projectName);
  if (!BACKUP_VOLUMES.includes(logicalName)) throw new Error("Unknown production volume");
  return `${projectName}_${logicalName}`;
}

export function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${command} could not start`)));
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

export function capture(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      arguments_,
      {
        cwd: options.cwd,
        env: options.environment ?? process.env,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              `${command} ${arguments_.join(" ")} failed: ${stderr.trim().slice(-2_000) || error.message}`,
            ),
          );
        } else resolvePromise(stdout.trim());
      },
    );
  });
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

export async function readPassphrase(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 20 ||
    metadata.size > 4_096
  ) {
    throw new Error(
      "Backup passphrase file must be a private regular file containing 20-4096 bytes",
    );
  }
  const value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (Buffer.byteLength(value, "utf8") < 20 || /[\r\n\0]/.test(value)) {
    throw new Error("Backup passphrase must contain at least 20 bytes and no embedded newline");
  }
  return value;
}

async function deriveKey(passphrase, salt, parameters) {
  return scrypt(passphrase, salt, 32, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: 128 * 1_024 * 1_024,
  });
}

export async function encryptBackup(inputPath, outputPath, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { name: "scrypt", N: 32_768, r: 8, p: 1 };
  const header = Buffer.from(
    JSON.stringify({
      formatVersion: BACKUP_FORMAT_VERSION,
      cipher: "aes-256-gcm",
      kdf,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
    }),
    "utf8",
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.byteLength);
  const authenticatedHeader = Buffer.concat([BACKUP_MAGIC, headerLength, header]);
  await writeFile(outputPath, authenticatedHeader, { flag: "wx", mode: 0o600 });
  await chmod(outputPath, 0o600);
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(authenticatedHeader);
  try {
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: "a" }),
    );
    await appendFile(outputPath, cipher.getAuthTag());
  } finally {
    key.fill(0);
  }
}

async function readExactly(handle, length, position) {
  const value = Buffer.alloc(length);
  const result = await handle.read(value, 0, length, position);
  if (result.bytesRead !== length) throw new Error("Encrypted backup is truncated");
  return value;
}

export async function decryptBackup(inputPath, outputPath, passphrase) {
  const metadata = await stat(inputPath);
  const handle = await open(inputPath, "r");
  try {
    const prefix = await readExactly(handle, BACKUP_MAGIC.byteLength + 4, 0);
    if (!prefix.subarray(0, BACKUP_MAGIC.byteLength).equals(BACKUP_MAGIC)) {
      throw new Error("Backup magic is invalid");
    }
    const headerLength = prefix.readUInt32BE(BACKUP_MAGIC.byteLength);
    if (headerLength < 32 || headerLength > 4_096) throw new Error("Backup header is invalid");
    const headerBytes = await readExactly(handle, headerLength, prefix.byteLength);
    let header;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new Error("Backup header JSON is invalid");
    }
    if (
      header?.formatVersion !== BACKUP_FORMAT_VERSION ||
      header?.cipher !== "aes-256-gcm" ||
      header?.kdf?.name !== "scrypt" ||
      header?.kdf?.N !== 32_768 ||
      header?.kdf?.r !== 8 ||
      header?.kdf?.p !== 1 ||
      typeof header?.salt !== "string" ||
      typeof header?.iv !== "string"
    ) {
      throw new Error("Backup cryptographic header is unsupported");
    }
    const salt = Buffer.from(header.salt, "base64");
    const iv = Buffer.from(header.iv, "base64");
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error("Backup nonce is invalid");
    const ciphertextStart = prefix.byteLength + headerLength;
    const tagLength = 16;
    if (metadata.size <= ciphertextStart + tagLength) throw new Error("Encrypted backup is empty");
    const tag = await readExactly(handle, tagLength, metadata.size - tagLength);
    const authenticatedHeader = Buffer.concat([prefix, headerBytes]);
    const key = await deriveKey(passphrase, salt, header.kdf);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(authenticatedHeader);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(inputPath, {
          start: ciphertextStart,
          end: metadata.size - tagLength - 1,
        }),
        decipher,
        createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      throw new Error("Backup authentication failed; passphrase or bytes are incorrect");
    } finally {
      key.fill(0);
    }
  } finally {
    await handle.close();
  }
}

export async function assertNoRunningProjectContainers(projectName) {
  const running = await capture("docker", [
    "ps",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]);
  if (running.length > 0) {
    throw new Error(
      `Compose project ${projectName} is still running; stop it before backup/restore`,
    );
  }
}

export async function dockerVolumeExists(name) {
  try {
    await capture("docker", ["volume", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

export async function archiveVolume(name, outputDirectory, archiveName) {
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_READ_SEARCH",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=volume,source=${name},target=/source,readonly`,
    "--mount",
    `type=bind,source=${outputDirectory},target=/backup`,
    BACKUP_HELPER_IMAGE,
    "tar",
    "-C",
    "/source",
    "-czf",
    `/backup/${archiveName}`,
    ".",
  ]);
  const uid = process.getuid?.() ?? 1_000;
  const gid = process.getgid?.() ?? 1_000;
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=bind,source=${outputDirectory},target=/backup`,
    BACKUP_HELPER_IMAGE,
    "chown",
    `${String(uid)}:${String(gid)}`,
    `/backup/${archiveName}`,
  ]);
}

export async function restoreVolume(name, archiveDirectory, archiveName) {
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=volume,source=${name},target=/target`,
    "--mount",
    `type=bind,source=${archiveDirectory},target=/backup,readonly`,
    BACKUP_HELPER_IMAGE,
    "tar",
    "-C",
    "/target",
    "-xzf",
    `/backup/${archiveName}`,
  ]);
}
