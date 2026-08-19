import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRuntimeDirectory = resolve(repositoryRoot, "deploy/production/runtime");
const deploymentVersion = 2;
const maxRuntimeFileBytes = 64 * 1_024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const apiTokenPattern =
  /^pck_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43,256}$/i;

function parseRuntimeDirectory(argv) {
  let configured = process.env.PI_CLOUD_RUNTIME_DIRECTORY;
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

async function ensureToolBrokerToken(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/tool-broker-token");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
      throw new Error("Production Tool Broker token is invalid");
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

async function ensureSandboxMaterializerToken(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/sandbox-materializer-token");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
      throw new Error("Production Sandbox materializer token is invalid");
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

async function ensureWorkspaceTerminalToken(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/workspace-terminal-token");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
      throw new Error("Production Workspace terminal token is invalid");
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

async function ensureWorkspaceVolumeGatewayState(runtimeDirectory) {
  const application = applicationIdentity();
  for (const relativePath of [
    "state/cube-shared",
    "state/cube-shared/volume",
    "state/workspace-volume-gateway",
  ]) {
    const path = resolve(runtimeDirectory, relativePath);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    if (application.changeOwnership) await chown(path, application.uid, application.gid);
  }
}

async function ensureWorkspaceVolumeGatewaySecrets(runtimeDirectory) {
  const application = applicationIdentity();
  const specs = [["workspace-volume-gateway-token", `${randomSecret()}\n`, /^[A-Za-z0-9_-]{64}$/]];
  const created = [];
  for (const [name, contents, pattern] of specs) {
    const path = resolve(runtimeDirectory, "secrets", name);
    try {
      const existing = (await readPrivateFile(path)).trim();
      if (!pattern.test(existing)) throw new Error(`Production ${name} is invalid`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writePrivateFile(path, contents);
      if (application.changeOwnership) await chown(path, application.uid, application.gid);
      created.push(name);
    }
  }
  return created;
}

async function ensureCubeEgressConfigToken(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/cube-egress-config-token");
  try {
    const existing = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) {
      throw new Error("Production Cube egress configuration token is invalid");
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

async function ensureEventStreamSecrets(runtimeDirectory) {
  const application = applicationIdentity();
  const specs = [
    ["worker-event-ingest-token", `${randomSecret()}\n`, /^[A-Za-z0-9_-]{64}$/],
    ["live-event-store-url", "redis://valkey:6379\n", /^redis:\/\/valkey:6379$/],
  ];
  const created = [];
  for (const [name, contents, pattern] of specs) {
    const path = resolve(runtimeDirectory, "secrets", name);
    try {
      const existing = (await readPrivateFile(path)).trim();
      if (!pattern.test(existing)) throw new Error(`Production ${name} is invalid`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writePrivateFile(path, contents);
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
  const apiCredentialId = manifest?.identities?.apiCredentialId;
  if (typeof apiCredentialId !== "string" || !uuidPattern.test(apiCredentialId)) {
    throw new Error("Production deployment manifest lacks the current API credential identity");
  }
  const expected = [
    ".env",
    "deployment.json",
    "secrets/api-token",
    "secrets/database-url",
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
  const environment = Object.fromEntries(
    (await readPrivateFile(resolve(runtimeDirectory, ".env")))
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (environment.PI_CLOUD_API_CREDENTIAL_ID !== apiCredentialId) {
    throw new Error("Production API credential identity is inconsistent");
  }
  const apiToken = (await readPrivateFile(resolve(runtimeDirectory, "secrets/api-token"))).trim();
  const tokenMatch = apiTokenPattern.exec(apiToken);
  if (tokenMatch?.[1]?.toLowerCase() !== apiCredentialId.toLowerCase()) {
    throw new Error("Production API token does not use the current credential identity");
  }
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
  const value = process.env.PI_CLOUD_HTTP_PORT ?? "8080";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PI_CLOUD_HTTP_PORT must be an integer from 1 to 65535");
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
  const toolBrokerTokenCreated = await ensureToolBrokerToken(runtimeDirectory);
  const sandboxMaterializerTokenCreated = await ensureSandboxMaterializerToken(runtimeDirectory);
  const workspaceTerminalTokenCreated = await ensureWorkspaceTerminalToken(runtimeDirectory);
  await ensureWorkspaceVolumeGatewayState(runtimeDirectory);
  const workspaceVolumeGatewaySecretsCreated =
    await ensureWorkspaceVolumeGatewaySecrets(runtimeDirectory);
  const cubeEgressConfigTokenCreated = await ensureCubeEgressConfigToken(runtimeDirectory);
  const githubGatewaySecretsCreated = await ensureGitHubGatewaySecrets(runtimeDirectory);
  const observabilitySecretsCreated = await ensureObservabilitySecrets(runtimeDirectory);
  const eventStreamSecretsCreated = await ensureEventStreamSecrets(runtimeDirectory);
  process.stdout.write(
    `${JSON.stringify({
      initialized: true,
      reused: true,
      modelCredentialMasterKeyCreated,
      toolBrokerTokenCreated,
      sandboxMaterializerTokenCreated,
      workspaceTerminalTokenCreated,
      workspaceVolumeGatewaySecretsCreated,
      cubeEgressConfigTokenCreated,
      githubGatewaySecretsCreated,
      observabilitySecretsCreated,
      eventStreamSecretsCreated,
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
await ensureWorkspaceVolumeGatewayState(runtimeDirectory);

const postgresPassword = randomSecret();
const identities = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  apiCredentialId: randomUUID(),
  credentialBindingId: randomUUID(),
  modelProfileId: randomUUID(),
};
const apiToken = `pck_${identities.apiCredentialId}.${randomBytes(32).toString("base64url")}`;
const application = applicationIdentity();
const imageVersion = boundedEnvironmentValue(
  "PI_CLOUD_IMAGE_VERSION",
  "production",
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
  128,
);
const bindAddress = boundedEnvironmentValue(
  "PI_CLOUD_HTTP_BIND_ADDRESS",
  "127.0.0.1",
  /^[a-zA-Z0-9:._-]+$/,
  128,
);
const supervisorIdPrefix = boundedEnvironmentValue(
  "PI_CLOUD_SUPERVISOR_ID_PREFIX",
  "pi-cloud-worker-",
  /^[a-z0-9](?:[-a-z0-9]{0,62})-$/,
);
const publicRegistrationEnabled = booleanEnvironmentValue(
  "PI_CLOUD_PUBLIC_REGISTRATION_ENABLED",
  "true",
);
const publicRegistrationMaximumTenants = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS",
  32,
  2,
  1_000_000,
);
const publicTenantMaximumProjects = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS",
  10,
  1,
  1_000_000,
);
const publicTenantMaximumSessions = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS",
  100,
  1,
  1_000_000,
);
const publicTenantMaximumUnsettledTurns = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
  10,
  1,
  1_000_000,
);
const publicTenantMaximumConcurrentTurns = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS",
  4,
  1,
  256,
);
const publicTenantMaximumActiveSandboxes = integerEnvironmentValue(
  "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_ACTIVE_SANDBOXES",
  2,
  1,
  1_000_000,
);
if (Number(publicTenantMaximumConcurrentTurns) > Number(publicTenantMaximumUnsettledTurns)) {
  throw new Error(
    "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS cannot exceed PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
  );
}

await writePrivateFile(resolve(secretsDirectory, "postgres-password"), `${postgresPassword}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "database-url"),
  `postgresql://pi_cloud:${postgresPassword}@postgres:5432/pi_cloud\n`,
);
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
await writePrivateFile(resolve(secretsDirectory, "tool-broker-token"), `${randomSecret()}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "sandbox-materializer-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(
  resolve(secretsDirectory, "workspace-terminal-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(
  resolve(secretsDirectory, "workspace-volume-gateway-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(
  resolve(secretsDirectory, "cube-egress-config-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(resolve(secretsDirectory, "github-gateway-token"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "github-webhook-secret"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "github-app-private-key.pem"), "not-configured\n");
await writePrivateFile(resolve(secretsDirectory, "metrics-token"), `${randomSecret()}\n`);
await writePrivateFile(resolve(secretsDirectory, "grafana-admin-password"), `${randomSecret()}\n`);
await writePrivateFile(
  resolve(secretsDirectory, "worker-event-ingest-token"),
  `${randomSecret()}\n`,
);
await writePrivateFile(resolve(secretsDirectory, "live-event-store-url"), "redis://valkey:6379\n");
if (application.changeOwnership) {
  await Promise.all(
    (await readdir(secretsDirectory)).map((name) =>
      chown(resolve(secretsDirectory, name), application.uid, application.gid),
    ),
  );
}

const environment = [
  `PI_CLOUD_RUNTIME_DIRECTORY=${runtimeDirectory}`,
  `PI_CLOUD_IMAGE_VERSION=${imageVersion}`,
  "NPM_CONFIG_REGISTRY=https://registry.npmjs.org",
  `PI_CLOUD_HTTP_BIND_ADDRESS=${bindAddress}`,
  `PI_CLOUD_HTTP_PORT=${httpPort()}`,
  `PI_CLOUD_APPLICATION_UID=${String(application.uid)}`,
  `PI_CLOUD_APPLICATION_GID=${String(application.gid)}`,
  "PI_CLOUD_TENANT_SLUG=pi-cloud",
  `PI_CLOUD_TENANT_ID=${identities.tenantId}`,
  `PI_CLOUD_USER_ID=${identities.userId}`,
  `PI_CLOUD_API_CREDENTIAL_ID=${identities.apiCredentialId}`,
  `PI_CLOUD_CREDENTIAL_BINDING_ID=${identities.credentialBindingId}`,
  `PI_CLOUD_DEFAULT_MODEL_PROFILE_ID=${identities.modelProfileId}`,
  `PI_CLOUD_SUPERVISOR_ID_PREFIX=${supervisorIdPrefix}`,
  "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES=http://{supervisorId}:4100",
  "PI_CLOUD_PI_WORKER_DEPLOYMENT=compose",
  "PI_CLOUD_SUPERVISOR_CAPACITY=2",
  `PI_CLOUD_PUBLIC_REGISTRATION_ENABLED=${publicRegistrationEnabled}`,
  `PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS=${publicRegistrationMaximumTenants}`,
  `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS=${publicTenantMaximumProjects}`,
  `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS=${publicTenantMaximumSessions}`,
  `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS=${publicTenantMaximumUnsettledTurns}`,
  `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS=${publicTenantMaximumConcurrentTurns}`,
  `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_ACTIVE_SANDBOXES=${publicTenantMaximumActiveSandboxes}`,
  "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS=2",
  "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS=32",
  "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS=30000",
  "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS=660000",
  "PI_CLOUD_GITHUB_APP_ID=",
  "PI_CLOUD_PROMETHEUS_PORT=9090",
  "PI_CLOUD_GRAFANA_PORT=3001",
  "PI_CLOUD_JAEGER_PORT=16686",
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
