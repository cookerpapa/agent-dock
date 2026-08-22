import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type ToolBrokerConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  sandboxDomainId: string;
  advertisedBaseUrl: string;
  ownershipLeaseMs: number;
  ownershipHeartbeatMs: number;
  serviceToken: string;
  materializerToken?: string;
  terminalToken: string;
  imageRevision: string;
  maximumActiveSandboxes: number;
  warmTtlMs: number;
  maximumWarmActivations: number;
  cubeSandbox: {
    apiUrl: string;
    apiKey: string;
    templateId: string;
    developmentTemplateIds: Readonly<Record<"starter" | "standard" | "performance", string>>;
    proxyNodeIp: string;
    proxyPort: number;
    proxyScheme: "http" | "https";
    sandboxDomain: string;
    egressProxyHost: string;
    egressProxyPort: number;
    requestTimeoutMs: number;
    workspaceVolumeGatewayUrl: string;
    workspaceVolumeGatewayToken: string;
    workspaceVolumeGatewayRequestTimeoutMs: number;
  };
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required Tool Broker configuration ${name} is missing`);
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
    throw new TypeError("Tool Broker numeric configuration is invalid");
  }
  return parsed;
}

function developmentTemplateIds(
  value: string | undefined,
  fallback: string,
): Readonly<Record<"starter" | "standard" | "performance", string>> {
  if (value === undefined) {
    return Object.freeze({ starter: fallback, standard: fallback, performance: fallback });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("CubeSandbox development template catalog is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("CubeSandbox development template catalog is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const output = Object.fromEntries(
    (["starter", "standard", "performance"] as const).map((key) => {
      const templateId = record[key];
      if (typeof templateId !== "string" || !/^tpl-[a-z0-9]{24}$/.test(templateId)) {
        throw new TypeError("CubeSandbox development template catalog is invalid");
      }
      return [key, templateId];
    }),
  ) as Record<"starter" | "standard" | "performance", string>;
  return Object.freeze(output);
}

async function readSecret(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("PI_CLOUD_TOOL_BROKER_TOKEN_FILE must be an absolute path");
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
      throw new TypeError("Tool Broker token file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
      throw new TypeError("Tool Broker token file is invalid");
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
      throw new TypeError("Tool Broker database URL file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    const parsed = new URL(value);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new TypeError("Tool Broker database URL is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadToolBrokerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ToolBrokerConfig> {
  if (
    environment.PI_CLOUD_DOCKER_COMMAND !== undefined ||
    environment.PI_CLOUD_REPOSITORY_IMPORT_NETWORK !== undefined ||
    Object.keys(environment).some((name) => name.startsWith("PI_CLOUD_MICROVM_"))
  ) {
    throw new TypeError(
      "Legacy Sandbox Provider configuration was removed; select a current trusted Provider",
    );
  }
  const cubeProxyScheme = environment.PI_CLOUD_CUBESANDBOX_PROXY_SCHEME ?? "http";
  if (cubeProxyScheme !== "http" && cubeProxyScheme !== "https") {
    throw new TypeError("PI_CLOUD_CUBESANDBOX_PROXY_SCHEME is invalid");
  }
  const ownershipLeaseMs = integer(
    environment.PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS,
    15_000,
    3_000,
    300_000,
  );
  const ownershipHeartbeatMs = integer(
    environment.PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS,
    5_000,
    1_000,
    60_000,
  );
  if (ownershipHeartbeatMs * 2 >= ownershipLeaseMs) {
    throw new TypeError("Tool Broker heartbeat must leave lease failure margin");
  }
  return {
    host: bounded(environment.PI_CLOUD_TOOL_BROKER_HOST ?? "127.0.0.1", "host", 256),
    port: integer(environment.PI_CLOUD_TOOL_BROKER_PORT, 4_300, 1, 65_535),
    databaseUrl: await readDatabaseUrl(required(environment, "DATABASE_URL_FILE")),
    sandboxDomainId: bounded(
      required(environment, "PI_CLOUD_SANDBOX_DOMAIN_ID"),
      "sandboxDomainId",
      64,
    ),
    advertisedBaseUrl: serviceUrl(
      required(environment, "PI_CLOUD_TOOL_BROKER_ADVERTISED_URL"),
      "advertisedBaseUrl",
    ),
    ownershipLeaseMs,
    ownershipHeartbeatMs,
    serviceToken: await readSecret(required(environment, "PI_CLOUD_TOOL_BROKER_TOKEN_FILE")),
    terminalToken: await readSecret(
      required(environment, "PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE"),
    ),
    ...(environment.PI_CLOUD_SANDBOX_MATERIALIZER_TOKEN_FILE === undefined
      ? {}
      : {
          materializerToken: await readSecret(environment.PI_CLOUD_SANDBOX_MATERIALIZER_TOKEN_FILE),
        }),
    imageRevision: bounded(
      required(environment, "PI_CLOUD_IMAGE_REVISION"),
      "PI_CLOUD_IMAGE_REVISION",
      128,
    ),
    maximumActiveSandboxes: integer(
      environment.PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES,
      2,
      1,
      1_000,
    ),
    warmTtlMs: integer(
      environment.PI_CLOUD_SANDBOX_WARM_TTL_MS,
      15 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    maximumWarmActivations: integer(environment.PI_CLOUD_MAXIMUM_WARM_SANDBOXES, 4, 1, 1_000),
    cubeSandbox: {
      apiUrl: bounded(
        required(environment, "PI_CLOUD_CUBESANDBOX_API_URL"),
        "cubeSandboxApiUrl",
        2_048,
      ),
      apiKey: await readCubeApiKey(required(environment, "PI_CLOUD_CUBESANDBOX_API_KEY_FILE")),
      templateId: bounded(
        required(environment, "PI_CLOUD_CUBESANDBOX_TEMPLATE_ID"),
        "cubeSandboxTemplateId",
        256,
      ),
      developmentTemplateIds: developmentTemplateIds(
        environment.PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS,
        bounded(
          required(environment, "PI_CLOUD_CUBESANDBOX_TEMPLATE_ID"),
          "cubeSandboxTemplateId",
          256,
        ),
      ),
      proxyNodeIp: bounded(
        required(environment, "PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP"),
        "cubeSandboxProxyNodeIp",
        253,
      ),
      proxyPort: integer(
        environment.PI_CLOUD_CUBESANDBOX_PROXY_PORT,
        cubeProxyScheme === "https" ? 443 : 80,
        1,
        65_535,
      ),
      proxyScheme: cubeProxyScheme,
      sandboxDomain: bounded(
        environment.PI_CLOUD_CUBESANDBOX_DOMAIN ?? "cube.app",
        "cubeSandboxDomain",
        253,
      ),
      egressProxyHost: bounded(
        environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
        "cubeSandboxEgressProxyHost",
        15,
      ),
      egressProxyPort: integer(
        environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_PORT,
        3_128,
        1,
        65_535,
      ),
      requestTimeoutMs: integer(
        environment.PI_CLOUD_CUBESANDBOX_REQUEST_TIMEOUT_MS,
        30_000,
        1_000,
        300_000,
      ),
      workspaceVolumeGatewayUrl: bounded(
        required(environment, "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL"),
        "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL",
        2_048,
      ),
      workspaceVolumeGatewayToken: await readSecret(
        required(environment, "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE"),
      ),
      workspaceVolumeGatewayRequestTimeoutMs: integer(
        environment.PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS,
        660_000,
        1_000,
        900_000,
      ),
    },
  };
}
