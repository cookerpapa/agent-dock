import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type SandboxManagerConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  executionCellId: string;
  advertisedBaseUrl: string;
  ownershipLeaseMs: number;
  ownershipHeartbeatMs: number;
  serviceToken: string;
  materializerToken?: string;
  imageRevision: string;
  maximumActiveSandboxes: number;
  warmTtlMs: number;
  maximumWarmActivations: number;
  cubeSandbox: {
    apiUrl: string;
    apiKey: string;
    templateId: string;
    proxyNodeIp: string;
    proxyPort: number;
    proxyScheme: "http" | "https";
    sandboxDomain: string;
    egressProxyHost: string;
    egressProxyPort: number;
    requestTimeoutMs: number;
    workspaceDataMoverUrl: string;
    workspaceDataMoverToken: string;
  };
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required Sandbox Manager configuration ${name} is missing`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 1_024): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function serviceUrl(value: string, name: string): string {
  const parsed = new URL(bounded(value, name, 2_048));
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed.toString();
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError("Sandbox Manager numeric configuration is invalid");
  }
  return parsed;
}

async function readSecret(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE must be an absolute path");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 32 ||
      metadata.size > 4_096
    ) {
      throw new TypeError("Sandbox Manager token file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
      throw new TypeError("Sandbox Manager token file is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function readCubeApiKey(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("CubeSandbox API key path must be absolute");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 32 ||
      metadata.size > 4_096
    ) {
      throw new TypeError("CubeSandbox API key file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 32 || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError("CubeSandbox API key file is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function readDatabaseUrl(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("DATABASE_URL_FILE must be an absolute path");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4_096) {
      throw new TypeError("Sandbox Manager database URL file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    const parsed = new URL(value);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new TypeError("Sandbox Manager database URL is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadSandboxManagerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxManagerConfig> {
  if (
    environment.AGENT_DOCK_DOCKER_COMMAND !== undefined ||
    environment.AGENT_DOCK_REPOSITORY_IMPORT_NETWORK !== undefined ||
    Object.keys(environment).some((name) => name.startsWith("AGENT_DOCK_MICROVM_"))
  ) {
    throw new TypeError(
      "Legacy Sandbox Provider configuration was removed; select a current trusted Provider",
    );
  }
  const cubeProxyScheme = environment.AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME ?? "http";
  if (cubeProxyScheme !== "http" && cubeProxyScheme !== "https") {
    throw new TypeError("AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME is invalid");
  }
  const ownershipLeaseMs = integer(
    environment.AGENT_DOCK_SANDBOX_MANAGER_OWNERSHIP_LEASE_MS,
    15_000,
    3_000,
    300_000,
  );
  const ownershipHeartbeatMs = integer(
    environment.AGENT_DOCK_SANDBOX_MANAGER_OWNERSHIP_HEARTBEAT_MS,
    5_000,
    1_000,
    60_000,
  );
  if (ownershipHeartbeatMs * 2 >= ownershipLeaseMs) {
    throw new TypeError("Sandbox Manager heartbeat must leave lease failure margin");
  }
  return {
    host: bounded(environment.AGENT_DOCK_SANDBOX_MANAGER_HOST ?? "127.0.0.1", "host", 256),
    port: integer(environment.AGENT_DOCK_SANDBOX_MANAGER_PORT, 4_300, 1, 65_535),
    databaseUrl: await readDatabaseUrl(required(environment, "DATABASE_URL_FILE")),
    executionCellId: bounded(
      required(environment, "AGENT_DOCK_EXECUTION_CELL_ID"),
      "executionCellId",
      64,
    ),
    advertisedBaseUrl: serviceUrl(
      required(environment, "AGENT_DOCK_SANDBOX_MANAGER_ADVERTISED_URL"),
      "advertisedBaseUrl",
    ),
    ownershipLeaseMs,
    ownershipHeartbeatMs,
    serviceToken: await readSecret(required(environment, "AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE")),
    ...(environment.AGENT_DOCK_SANDBOX_MATERIALIZER_TOKEN_FILE === undefined
      ? {}
      : {
          materializerToken: await readSecret(
            environment.AGENT_DOCK_SANDBOX_MATERIALIZER_TOKEN_FILE,
          ),
        }),
    imageRevision: bounded(
      required(environment, "AGENT_DOCK_IMAGE_REVISION"),
      "AGENT_DOCK_IMAGE_REVISION",
      128,
    ),
    maximumActiveSandboxes: integer(
      environment.AGENT_DOCK_MAXIMUM_ACTIVE_TOOL_SANDBOXES,
      2,
      1,
      1_000,
    ),
    warmTtlMs: integer(
      environment.AGENT_DOCK_SANDBOX_WARM_TTL_MS,
      15 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    maximumWarmActivations: integer(environment.AGENT_DOCK_MAXIMUM_WARM_SANDBOXES, 4, 1, 1_000),
    cubeSandbox: {
      apiUrl: bounded(
        required(environment, "AGENT_DOCK_CUBESANDBOX_API_URL"),
        "cubeSandboxApiUrl",
        2_048,
      ),
      apiKey: await readCubeApiKey(required(environment, "AGENT_DOCK_CUBESANDBOX_API_KEY_FILE")),
      templateId: bounded(
        required(environment, "AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID"),
        "cubeSandboxTemplateId",
        256,
      ),
      proxyNodeIp: bounded(
        required(environment, "AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP"),
        "cubeSandboxProxyNodeIp",
        253,
      ),
      proxyPort: integer(
        environment.AGENT_DOCK_CUBESANDBOX_PROXY_PORT,
        cubeProxyScheme === "https" ? 443 : 80,
        1,
        65_535,
      ),
      proxyScheme: cubeProxyScheme,
      sandboxDomain: bounded(
        environment.AGENT_DOCK_CUBESANDBOX_DOMAIN ?? "cube.app",
        "cubeSandboxDomain",
        253,
      ),
      egressProxyHost: bounded(
        environment.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
        "cubeSandboxEgressProxyHost",
        15,
      ),
      egressProxyPort: integer(
        environment.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_PORT,
        3_128,
        1,
        65_535,
      ),
      requestTimeoutMs: integer(
        environment.AGENT_DOCK_CUBESANDBOX_REQUEST_TIMEOUT_MS,
        30_000,
        1_000,
        300_000,
      ),
      workspaceDataMoverUrl: bounded(
        required(environment, "AGENT_DOCK_WORKSPACE_DATA_MOVER_URL"),
        "AGENT_DOCK_WORKSPACE_DATA_MOVER_URL",
        2_048,
      ),
      workspaceDataMoverToken: await readSecret(
        required(environment, "AGENT_DOCK_WORKSPACE_DATA_MOVER_TOKEN_FILE"),
      ),
    },
  };
}
