import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRuntimeDirectory = resolve(repositoryRoot, "deploy/production/runtime");
const deploymentVersion = 1;
const maxRuntimeFileBytes = 64 * 1_024;

function parseRuntimeDirectory(argv) {
  let configured = process.env.AGENT_DOCK_RUNTIME_DIRECTORY;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runtime-dir") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--runtime-dir requires a path");
      configured = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: node scripts/init-production.mjs [--runtime-dir ABSOLUTE_OR_RELATIVE_PATH]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown production initialization argument: ${argument}`);
  }
  const runtimeDirectory = resolve(repositoryRoot, configured ?? defaultRuntimeDirectory);
  if (/\r|\n|\0/.test(runtimeDirectory)) throw new Error("Runtime directory path is invalid");
  return runtimeDirectory;
}

async function writePrivateFile(path, contents) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function assertPrivateRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Production runtime file is not private and regular: ${path}`);
  }
}

async function assertPrivateDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Production runtime directory is not private: ${path}`);
  }
}

async function readPrivateFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maxRuntimeFileBytes
    ) {
      throw new Error(`Production runtime file is not private and bounded: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replacePrivateFile(path, contents) {
  const temporary = resolve(dirname(path), `.tmp-${randomUUID()}`);
  try {
    await writePrivateFile(temporary, contents);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseAwsCredentials(value) {
  const match =
    /^\[default\]\naws_access_key_id = ([A-Za-z0-9][A-Za-z0-9_-]{15,63})\naws_secret_access_key = ([A-Za-z0-9_-]{43,128})\n?$/.exec(
      value,
    );
  if (match === null) throw new Error("Production AWS credential file is invalid");
  return { accessKey: match[1], secretKey: match[2] };
}

async function ensureDedicatedObjectStoreCredential(runtimeDirectory) {
  const secretsDirectory = resolve(runtimeDirectory, "secrets");
  const rootUser = (await readPrivateFile(resolve(secretsDirectory, "minio-root-user"))).trim();
  const credentialsPath = resolve(secretsDirectory, "aws-credentials");
  const existing = parseAwsCredentials(await readPrivateFile(credentialsPath));
  if (existing.accessKey !== rootUser) return false;
  const accessKey = `agentdockapp${randomBytes(8).toString("hex")}`;
  const secretKey = randomSecret();
  await replacePrivateFile(
    credentialsPath,
    `[default]\naws_access_key_id = ${accessKey}\naws_secret_access_key = ${secretKey}\n`,
  );
  return true;
}

async function ensureModelCredentialMasterKey(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/model-credential-master-key");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing) || Buffer.from(existing, "base64url").length !== 32) {
      throw new Error("Production model credential master key is invalid");
    }
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateFile(path, `${randomBytes(32).toString("base64url")}\n`);
  const application = applicationIdentity();
  if (application.changeOwnership) await chown(path, application.uid, application.gid);
  return true;
}

async function ensureSandboxManagerToken(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/sandbox-manager-token");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
      throw new Error("Production Sandbox Manager token is invalid");
    }
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateFile(path, `${randomSecret()}\n`);
  const application = applicationIdentity();
  if (application.changeOwnership) await chown(path, application.uid, application.gid);
  return true;
}

async function ensureObservabilitySecrets(runtimeDirectory) {
  const application = applicationIdentity();
  const created = [];
  for (const name of ["metrics-token", "grafana-admin-password"]) {
    const path = resolve(runtimeDirectory, "secrets", name);
    try {
      const existing = (await readPrivateFile(path)).trim();
      if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
        throw new Error(`Production ${name} is invalid`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writePrivateFile(path, `${randomSecret()}\n`);
      if (application.changeOwnership) await chown(path, application.uid, application.gid);
      created.push(name);
    }
  }
  return created;
}

async function ensureGitHubGatewaySecrets(runtimeDirectory) {
  const application = applicationIdentity();
  const specs = [
    ["github-gateway-token", `${randomSecret()}\n`, /^[A-Za-z0-9_-]{64}$/],
    ["github-webhook-secret", `${randomSecret()}\n`, /^[A-Za-z0-9_-]{64}$/],
    ["github-app-private-key.pem", "not-configured\n", /^not-configured$/],
  ];
  const created = [];
  for (const [name, contents, pattern] of specs) {
    const path = resolve(runtimeDirectory, "secrets", name);
    try {
      const existing = (await readPrivateFile(path)).trim();
      if (!pattern.test(existing) && name !== "github-app-private-key.pem") {
        throw new Error(`Production ${name} is invalid`);
      }
      if (
        name === "github-app-private-key.pem" &&
        existing !== "not-configured" &&
        !existing.includes("PRIVATE KEY")
      ) {
        throw new Error("Production GitHub App private key file is invalid");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writePrivateFile(path, contents);
      if (application.changeOwnership) await chown(path, application.uid, application.gid);
      created.push(name);
    }
  }
  return created;
}

async function validateExisting(runtimeDirectory) {
  const manifestPath = resolve(runtimeDirectory, "deployment.json");
  let manifestBytes;
  try {
    manifestBytes = await readPrivateFile(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error("Production deployment manifest is invalid");
  }
  if (manifest?.formatVersion !== deploymentVersion) {
    throw new Error("Production runtime has an unsupported deployment format");
  }
  const expected = [
    ".env",
    "deployment.json",
    "secrets/api-token",
    "secrets/aws-credentials",
    "secrets/database-url",
    "secrets/minio-root-password",
    "secrets/minio-root-user",
    "secrets/postgres-password",
    "secrets/supervisor-enrollment-token",
    "secrets/supervisor-management-token",
  ];
  await Promise.all(
    expected.map((relativePath) =>
      assertPrivateRegularFile(resolve(runtimeDirectory, relativePath)),
    ),
  );
  await assertPrivateDirectory(resolve(runtimeDirectory, "secrets"));
  return true;
}

function randomSecret() {
  return randomBytes(48).toString("base64url");
}

function boundedEnvironmentValue(name, fallback, pattern, maximum = 256) {
  const value = process.env[name] ?? fallback;
  if (value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function httpPort() {
  const value = process.env.AGENT_DOCK_HTTP_PORT ?? "8080";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("AGENT_DOCK_HTTP_PORT must be an integer from 1 to 65535");
  }
  return String(parsed);
}

function booleanEnvironmentValue(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value;
}

function integerEnvironmentValue(name, fallback, minimum, maximum) {
  const value = process.env[name] ?? String(fallback);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return String(parsed);
}

function applicationIdentity() {
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (
    hostUid === undefined ||
    hostGid === undefined ||
    !Number.isSafeInteger(hostUid) ||
    !Number.isSafeInteger(hostGid) ||
    hostUid < 0 ||
    hostUid > 2_147_483_647 ||
    hostGid < 0 ||
    hostGid > 2_147_483_647
  ) {
    throw new Error("Production initialization requires a Linux numeric user identity");
  }
  return hostUid === 0
    ? { uid: 1_000, gid: 1_000, changeOwnership: true }
    : { uid: hostUid, gid: hostGid, changeOwnership: false };
}

const runtimeDirectory = parseRuntimeDirectory(process.argv.slice(2));
await mkdir(dirname(runtimeDirectory), { recursive: true });
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
const runtimeMetadata = await lstat(runtimeDirectory);
if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
  throw new Error("Production runtime path must be a real directory");
}
await chmod(runtimeDirectory, 0o700);
await assertPrivateDirectory(runtimeDirectory);

if (await validateExisting(runtimeDirectory)) {
  const modelCredentialMasterKeyCreated = await ensureModelCredentialMasterKey(runtimeDirectory);
  const sandboxManagerTokenCreated = await ensureSandboxManagerToken(runtimeDirectory);
  const githubGatewaySecretsCreated = await ensureGitHubGatewaySecrets(runtimeDirectory);
  const observabilitySecretsCreated = await ensureObservabilitySecrets(runtimeDirectory);
  const objectStoreCredentialMigrated =
    await ensureDedicatedObjectStoreCredential(runtimeDirectory);
  process.stdout.write(
    `${JSON.stringify({
      initialized: true,
      reused: true,
      modelCredentialMasterKeyCreated,
      sandboxManagerTokenCreated,
      githubGatewaySecretsCreated,
      observabilitySecretsCreated,
      objectStoreCredentialMigrated,
      runtimeDirectory,
    })}\n`,
  );
  process.exit(0);
}

const existingEntries = await readdir(runtimeDirectory);
if (existingEntries.length > 0) {
  throw new Error(
    `Refusing to overwrite incomplete production runtime directory: ${runtimeDirectory}`,
  );
}

const secretsDirectory = resolve(runtimeDirectory, "secrets");
await mkdir(secretsDirectory, { mode: 0o700 });
await chmod(secretsDirectory, 0o700);

const postgresPassword = randomSecret();
const minioRootUser = `agentdock${randomBytes(8).toString("hex")}`;
const minioRootPassword = randomSecret();
const minioApplicationUser = `agentdockapp${randomBytes(8).toString("hex")}`;
const minioApplicationPassword = randomSecret();
const identities = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  apiCredentialId: randomUUID(),
  credentialBindingId: randomUUID(),
  modelProfileId: randomUUID(),
};
const apiToken = `adk_${identities.apiCredentialId}.${randomBytes(32).toString("base64url")}`;
const application = applicationIdentity();
const imageVersion = boundedEnvironmentValue(
  "AGENT_DOCK_IMAGE_VERSION",
  "production",
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
  128,
);
const bindAddress = boundedEnvironmentValue(
  "AGENT_DOCK_HTTP_BIND_ADDRESS",
  "127.0.0.1",
  /^[a-zA-Z0-9:._-]+$/,
  128,
);
const supervisorId = boundedEnvironmentValue(
  "AGENT_DOCK_SUPERVISOR_ID",
  "agent-dock-supervisor-1",
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/,
);
const publicRegistrationEnabled = booleanEnvironmentValue(
  "AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED",
  "false",
);
const publicRegistrationMaximumTenants = integerEnvironmentValue(
  "AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS",
  32,
  2,
  1_000_000,
);
const publicTenantMaximumProjects = integerEnvironmentValue(
  "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS",
  10,
  1,
  1_000_000,
);
const publicTenantMaximumSessions = integerEnvironmentValue(
  "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS",
  100,
  1,
  1_000_000,
);
const publicTenantMaximumUnsettledTurns = integerEnvironmentValue(
  "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
  10,
  1,
  1_000_000,
);
const publicTenantMaximumConcurrentTurns = integerEnvironmentValue(
  "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS",
  1,
  1,
  256,
);
if (Number(publicTenantMaximumConcurrentTurns) > Number(publicTenantMaximumUnsettledTurns)) {
  throw new Error(
    "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS cannot exceed AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
  );
}

await writePrivateFile(resolve(secretsDirectory, "postgres-password"), `${postgresPassword}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "database-url"),
  `postgresql://agent_dock:${postgresPassword}@postgres:5432/agent_dock\n`,
);
await writePrivateFile(resolve(secretsDirectory, "minio-root-user"), `${minioRootUser}\n`);
await writePrivateFile(resolve(secretsDirectory, "minio-root-password"), `${minioRootPassword}\n`);
await writePrivateFile(resolve(secretsDirectory, "api-token"), `${apiToken}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "model-credential-master-key"),
  `${randomBytes(32).toString("base64url")}\n`,
);
await writePrivateFile(
  resolve(secretsDirectory, "supervisor-enrollment-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(
  resolve(secretsDirectory, "supervisor-management-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(resolve(secretsDirectory, "sandbox-manager-token"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "github-gateway-token"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "github-webhook-secret"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "github-app-private-key.pem"), "not-configured\n");
await writePrivateFile(resolve(secretsDirectory, "metrics-token"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "grafana-admin-password"), `${randomSecret()}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "aws-credentials"),
  `[default]\naws_access_key_id = ${minioApplicationUser}\naws_secret_access_key = ${minioApplicationPassword}\n`,
);
if (application.changeOwnership) {
  await Promise.all(
    (await readdir(secretsDirectory)).map((name) =>
      chown(resolve(secretsDirectory, name), application.uid, application.gid),
    ),
  );
}

const environment = [
  `AGENT_DOCK_RUNTIME_DIRECTORY=${runtimeDirectory}`,
  `AGENT_DOCK_IMAGE_VERSION=${imageVersion}`,
  `AGENT_DOCK_HTTP_BIND_ADDRESS=${bindAddress}`,
  `AGENT_DOCK_HTTP_PORT=${httpPort()}`,
  `AGENT_DOCK_APPLICATION_UID=${String(application.uid)}`,
  `AGENT_DOCK_APPLICATION_GID=${String(application.gid)}`,
  "AGENT_DOCK_TENANT_SLUG=agent-dock",
  `AGENT_DOCK_TENANT_ID=${identities.tenantId}`,
  `AGENT_DOCK_USER_ID=${identities.userId}`,
  `AGENT_DOCK_API_CREDENTIAL_ID=${identities.apiCredentialId}`,
  `AGENT_DOCK_CREDENTIAL_BINDING_ID=${identities.credentialBindingId}`,
  `AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID=${identities.modelProfileId}`,
  `AGENT_DOCK_SUPERVISOR_ID=${supervisorId}`,
  "AGENT_DOCK_SUPERVISOR_CAPACITY=2",
  "AGENT_DOCK_MAXIMUM_LANES_PER_SUPERVISOR=8",
  `AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=${publicRegistrationEnabled}`,
  `AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=${publicRegistrationMaximumTenants}`,
  `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS=${publicTenantMaximumProjects}`,
  `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS=${publicTenantMaximumSessions}`,
  `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS=${publicTenantMaximumUnsettledTurns}`,
  `AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS=${publicTenantMaximumConcurrentTurns}`,
  "AGENT_DOCK_CHECKPOINT_BUCKET=agent-dock-checkpoints",
  "AGENT_DOCK_CHECKPOINT_REGION=us-east-1",
  "AGENT_DOCK_GITHUB_APP_ID=",
  "AGENT_DOCK_PROMETHEUS_PORT=9090",
  "AGENT_DOCK_GRAFANA_PORT=3001",
  "AGENT_DOCK_JAEGER_PORT=16686",
  "",
].join("\n");
await writePrivateFile(resolve(runtimeDirectory, ".env"), environment);
await writePrivateFile(
  resolve(runtimeDirectory, "deployment.json"),
  `${JSON.stringify(
    {
      formatVersion: deploymentVersion,
      createdAt: new Date().toISOString(),
      runtimeDirectory,
      identities,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`${JSON.stringify({ initialized: true, reused: false, runtimeDirectory })}\n`);
