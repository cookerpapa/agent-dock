import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_SECRET_BYTES = 16 * 1_024;

export type SupervisorHostEnvironment = Readonly<Record<string, string | undefined>>;

export type SupervisorHostConfig = {
  supervisorId: string;
  controlPlaneBaseUrl: string;
  supervisorWebSocketUrl: string;
  allowInsecureInternalHttp: boolean;
  enrollmentToken: string;
  managementToken: string;
  sandboxManagerServiceToken: string;
  modelCredentialMasterKey: string;
  databaseUrl: string;
  managementHost: string;
  managementPort: number;
  managementAdvertisedBaseUrl: string;
  maxConcurrentSessions: number;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  piExecutionMode: "rpc" | "embedded-sdk";
  sandboxManagerBaseUrl: string;
  sandboxManagerRequestTimeoutMs: number;
  trustedWorkspaceDirectory: string;
  bootStateDirectory: string;
  eventSpoolDirectory: string;
  modelGatewayHost: string;
  modelGatewayPort: number;
  modelGatewayAdvertisedBaseUrl: string;
  modelGatewayCapabilityTtlMs: number;
  modelGatewayMaximumRequestsPerTurn: number;
  modelGatewayUpstreamRequestTimeoutMs: number;
  piModelRequestTimeoutMs: number;
  piTurnTimeoutMs: number;
  repositoryImportLeaseMs: number;
  repositoryImportWaitMs: number;
  githubGatewayBaseUrl?: string;
  githubGatewayServiceToken?: string;
};

function required(environment: SupervisorHostEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required Supervisor host configuration ${name} is missing`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 4_096): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function booleanValue(environment: SupervisorHostEnvironment, name: string): boolean {
  const value = environment[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function integerValue(
  environment: SupervisorHostEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

function piExecutionMode(value: string | undefined): "rpc" | "embedded-sdk" {
  if (value === undefined || value === "rpc") return "rpc";
  if (value === "embedded-sdk") return "embedded-sdk";
  throw new TypeError("AGENT_DOCK_PI_EXECUTION_MODE must be rpc or embedded-sdk");
}

function baseUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("AGENT_DOCK_CONTROL_PLANE_URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP control-plane access requires explicit opt-in");
  }
  return parsed.toString();
}

function websocketUrl(controlPlaneBaseUrl: string, explicit: string | undefined): string {
  const parsed = new URL(explicit ?? controlPlaneBaseUrl);
  if (explicit === undefined) {
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = "/internal/v1/supervisor";
  }
  if (
    (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("AGENT_DOCK_SUPERVISOR_WEBSOCKET_URL is invalid");
  }
  return parsed.toString();
}

function modelGatewayBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL is invalid");
  }
  return parsed.toString();
}

function internalServiceBaseUrl(value: string, allowInsecure: boolean, name: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (parsed.protocol === "http:" && !allowInsecure)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed.toString();
}

async function readSecretFile(path: string, name: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${name}_FILE must be an absolute path`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_BYTES
    ) {
      throw new TypeError(`${name}_FILE is not a private bounded regular file`);
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 1 || value.length > MAX_SECRET_BYTES || /[\r\n\0]/.test(value)) {
      throw new TypeError(`${name}_FILE contains an invalid secret`);
    }
    return value;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secret(
  environment: SupervisorHostEnvironment,
  name: string,
  allowInline: boolean,
): Promise<string> {
  const file = environment[`${name}_FILE`];
  const inline = environment[name];
  if (file !== undefined && inline !== undefined) {
    throw new TypeError(`${name} and ${name}_FILE cannot both be configured`);
  }
  if (file !== undefined) return readSecretFile(file, name);
  if (allowInline && inline !== undefined && inline.length > 0) return inline;
  throw new TypeError(`Required secret file ${name}_FILE is missing`);
}

async function optionalSecret(
  environment: SupervisorHostEnvironment,
  name: string,
  allowInline: boolean,
): Promise<string | undefined> {
  if (environment[`${name}_FILE`] === undefined && environment[name] === undefined)
    return undefined;
  return secret(environment, name, allowInline);
}

export async function loadSupervisorHostConfig(
  environment: SupervisorHostEnvironment = process.env,
): Promise<SupervisorHostConfig> {
  const allowInsecureInternalHttp = booleanValue(
    environment,
    "AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP",
  );
  const allowInlineSecrets = booleanValue(environment, "AGENT_DOCK_ALLOW_INLINE_SECRETS");
  const controlPlaneBaseUrl = baseUrl(
    required(environment, "AGENT_DOCK_CONTROL_PLANE_URL"),
    allowInsecureInternalHttp,
  );
  const githubGatewayBaseUrl = environment.AGENT_DOCK_GITHUB_GATEWAY_URL;
  const githubGatewayServiceToken = await optionalSecret(
    environment,
    "AGENT_DOCK_GITHUB_GATEWAY_TOKEN",
    allowInlineSecrets,
  );
  if ((githubGatewayBaseUrl === undefined) !== (githubGatewayServiceToken === undefined)) {
    throw new TypeError("GitHub Gateway URL and service token must be configured together");
  }
  return {
    supervisorId: bounded(
      required(environment, "AGENT_DOCK_SUPERVISOR_ID"),
      "AGENT_DOCK_SUPERVISOR_ID",
      256,
    ),
    controlPlaneBaseUrl,
    supervisorWebSocketUrl: websocketUrl(
      controlPlaneBaseUrl,
      environment.AGENT_DOCK_SUPERVISOR_WEBSOCKET_URL,
    ),
    allowInsecureInternalHttp,
    enrollmentToken: await secret(
      environment,
      "AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN",
      allowInlineSecrets,
    ),
    managementToken: await secret(
      environment,
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN",
      allowInlineSecrets,
    ),
    sandboxManagerServiceToken: await secret(
      environment,
      "AGENT_DOCK_SANDBOX_MANAGER_TOKEN",
      allowInlineSecrets,
    ),
    modelCredentialMasterKey: await secret(
      environment,
      "AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY",
      allowInlineSecrets,
    ),
    databaseUrl: await secret(environment, "DATABASE_URL", allowInlineSecrets),
    managementHost: bounded(
      environment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_HOST ?? "127.0.0.1",
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_HOST",
      256,
    ),
    managementPort: integerValue(
      environment,
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_PORT",
      4100,
      1,
      65_535,
    ),
    managementAdvertisedBaseUrl: internalServiceBaseUrl(
      required(environment, "AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL"),
      allowInsecureInternalHttp,
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL",
    ),
    maxConcurrentSessions: integerValue(environment, "AGENT_DOCK_SUPERVISOR_CAPACITY", 2, 1, 256),
    temporalAddress: bounded(
      required(environment, "AGENT_DOCK_TEMPORAL_ADDRESS"),
      "AGENT_DOCK_TEMPORAL_ADDRESS",
      512,
    ),
    temporalNamespace: bounded(
      environment.AGENT_DOCK_TEMPORAL_NAMESPACE ?? "agent-dock",
      "AGENT_DOCK_TEMPORAL_NAMESPACE",
      255,
    ),
    temporalTaskQueue: bounded(
      environment.AGENT_DOCK_TEMPORAL_TASK_QUEUE ?? "agent-dock-pi-runs-v1",
      "AGENT_DOCK_TEMPORAL_TASK_QUEUE",
      255,
    ),
    piExecutionMode: piExecutionMode(environment.AGENT_DOCK_PI_EXECUTION_MODE),
    sandboxManagerBaseUrl: internalServiceBaseUrl(
      required(environment, "AGENT_DOCK_SANDBOX_MANAGER_URL"),
      allowInsecureInternalHttp,
      "AGENT_DOCK_SANDBOX_MANAGER_URL",
    ),
    sandboxManagerRequestTimeoutMs: integerValue(
      environment,
      "AGENT_DOCK_SANDBOX_MANAGER_REQUEST_TIMEOUT_MS",
      300_000,
      1_000,
      900_000,
    ),
    trustedWorkspaceDirectory: required(environment, "AGENT_DOCK_TRUSTED_WORKSPACE_DIRECTORY"),
    bootStateDirectory: required(environment, "AGENT_DOCK_BOOT_STATE_DIRECTORY"),
    eventSpoolDirectory: required(environment, "AGENT_DOCK_EVENT_SPOOL_DIRECTORY"),
    modelGatewayHost: bounded(
      environment.AGENT_DOCK_MODEL_GATEWAY_HOST ?? "127.0.0.1",
      "AGENT_DOCK_MODEL_GATEWAY_HOST",
      256,
    ),
    modelGatewayPort: integerValue(environment, "AGENT_DOCK_MODEL_GATEWAY_PORT", 4_200, 1, 65_535),
    modelGatewayAdvertisedBaseUrl: modelGatewayBaseUrl(
      required(environment, "AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL"),
    ),
    modelGatewayCapabilityTtlMs: integerValue(
      environment,
      "AGENT_DOCK_MODEL_GATEWAY_CAPABILITY_TTL_MS",
      10 * 60_000,
      1_000,
      60 * 60_000,
    ),
    modelGatewayMaximumRequestsPerTurn: integerValue(
      environment,
      "AGENT_DOCK_MODEL_GATEWAY_MAXIMUM_REQUESTS_PER_TURN",
      32,
      1,
      256,
    ),
    modelGatewayUpstreamRequestTimeoutMs: integerValue(
      environment,
      "AGENT_DOCK_MODEL_GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS",
      120_000,
      1_000,
      300_000,
    ),
    piModelRequestTimeoutMs: integerValue(
      environment,
      "AGENT_DOCK_PI_MODEL_REQUEST_TIMEOUT_MS",
      150_000,
      1_000,
      300_000,
    ),
    piTurnTimeoutMs: integerValue(
      environment,
      "AGENT_DOCK_PI_TURN_TIMEOUT_MS",
      10 * 60_000,
      1_000,
      15 * 60_000,
    ),
    repositoryImportLeaseMs: integerValue(
      environment,
      "AGENT_DOCK_REPOSITORY_IMPORT_LEASE_MS",
      240_000,
      1_000,
      10 * 60_000,
    ),
    repositoryImportWaitMs: integerValue(
      environment,
      "AGENT_DOCK_REPOSITORY_IMPORT_WAIT_MS",
      300_000,
      1_000,
      15 * 60_000,
    ),
    ...(githubGatewayBaseUrl === undefined || githubGatewayServiceToken === undefined
      ? {}
      : {
          githubGatewayBaseUrl: internalServiceBaseUrl(
            githubGatewayBaseUrl,
            allowInsecureInternalHttp,
            "AGENT_DOCK_GITHUB_GATEWAY_URL",
          ),
          githubGatewayServiceToken,
        }),
  };
}
