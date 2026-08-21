import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_SECRET_BYTES = 16 * 1_024;
const MAX_REMOTE_TOOL_EXECUTION_MS = 5 * 60_000;
const REMOTE_TOOL_TRANSPORT_MARGIN_MS = 60_000;
const MODEL_CAPABILITY_EXPIRY_MARGIN_MS = 60_000;

export type SupervisorHostEnvironment = Readonly<Record<string, string | undefined>>;

export type SupervisorHostConfig = {
  supervisorId: string;
  controlPlaneBaseUrl: string;
  supervisorWebSocketUrl: string;
  allowInsecureInternalHttp: boolean;
  enrollmentToken: string;
  managementToken: string;
  toolBrokerServiceToken: string;
  modelCredentialMasterKey: string;
  databaseUrl: string;
  databaseNotificationUrl: string;
  kafkaBrokers: readonly string[];
  kafkaRawEventTopic: string;
  kafkaSessionMutationTopic: string;
  managementHost: string;
  managementPort: number;
  managementAdvertisedBaseUrl: string;
  maxConcurrentSessions: number;
  subagentMaximumDepth: number;
  subagentMaximumNodes: number;
  subagentMaximumConcurrent: number;
  toolBrokerBaseUrls: readonly string[];
  toolBrokerRequestTimeoutMs: number;
  trustedWorkspaceDirectory: string;
  bootStateDirectory: string;
  checkpointReadCacheTtlMs: number;
  checkpointReadCacheMaximumEntries: number;
  checkpointReadCacheMaximumBytes: number;
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
    throw new TypeError("PI_CLOUD_CONTROL_PLANE_URL is invalid");
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
    throw new TypeError("PI_CLOUD_SUPERVISOR_WEBSOCKET_URL is invalid");
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
    throw new TypeError("PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL is invalid");
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

function internalServiceBaseUrls(value: string, allowInsecure: boolean, name: string): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 256 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(`${name} must contain 1-256 comma-separated URLs without whitespace`);
  }
  const parsed = values.map((entry) => internalServiceBaseUrl(entry, allowInsecure, name));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${name} must contain unique URLs`);
  }
  return parsed;
}

function boundedList(value: string, name: string, maximumItems = 64): string[] {
  const values = value.split(",");
  if (
    values.length < 1 ||
    values.length > maximumItems ||
    values.some((entry) => entry.trim() !== entry || entry.length < 1)
  ) {
    throw new TypeError(`${name} must contain bounded comma-separated values without whitespace`);
  }
  const normalized = values.map((entry) => bounded(entry, name, 512));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${name} must contain unique values`);
  }
  return normalized;
}

async function readSecretFile(path: string, name: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${name}_FILE must be an absolute path`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const effectiveUserId = process.geteuid?.();
    const effectiveGroups = new Set([process.getegid?.(), ...(process.getgroups?.() ?? [])]);
    const readableByOwner =
      effectiveUserId !== undefined &&
      metadata.uid === effectiveUserId &&
      (metadata.mode & 0o400) !== 0;
    const readableByPrivateGroup =
      effectiveGroups.has(metadata.gid) && (metadata.mode & 0o040) !== 0;
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o137) !== 0 ||
      (!readableByOwner && !readableByPrivateGroup) ||
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
    "PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP",
  );
  const allowInlineSecrets = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const controlPlaneBaseUrl = baseUrl(
    required(environment, "PI_CLOUD_CONTROL_PLANE_URL"),
    allowInsecureInternalHttp,
  );
  const githubGatewayBaseUrl = environment.PI_CLOUD_GITHUB_GATEWAY_URL;
  const githubGatewayServiceToken = await optionalSecret(
    environment,
    "PI_CLOUD_GITHUB_GATEWAY_TOKEN",
    allowInlineSecrets,
  );
  if ((githubGatewayBaseUrl === undefined) !== (githubGatewayServiceToken === undefined)) {
    throw new TypeError("GitHub Gateway URL and service token must be configured together");
  }
  const toolBrokerRequestTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_TOOL_BROKER_REQUEST_TIMEOUT_MS",
    MAX_REMOTE_TOOL_EXECUTION_MS + REMOTE_TOOL_TRANSPORT_MARGIN_MS,
    1_000,
    900_000,
  );
  const piTurnTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_PI_TURN_TIMEOUT_MS",
    10 * 60_000,
    1_000,
    15 * 60_000,
  );
  const modelGatewayCapabilityTtlMs = integerValue(
    environment,
    "PI_CLOUD_MODEL_GATEWAY_CAPABILITY_TTL_MS",
    15 * 60_000,
    1_000,
    60 * 60_000,
  );
  const modelGatewayUpstreamRequestTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_MODEL_GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS",
    120_000,
    1_000,
    300_000,
  );
  const piModelRequestTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_PI_MODEL_REQUEST_TIMEOUT_MS",
    150_000,
    1_000,
    300_000,
  );
  const repositoryImportLeaseMs = integerValue(
    environment,
    "PI_CLOUD_REPOSITORY_IMPORT_LEASE_MS",
    240_000,
    1_000,
    10 * 60_000,
  );
  const repositoryImportWaitMs = integerValue(
    environment,
    "PI_CLOUD_REPOSITORY_IMPORT_WAIT_MS",
    300_000,
    1_000,
    15 * 60_000,
  );
  if (toolBrokerRequestTimeoutMs < MAX_REMOTE_TOOL_EXECUTION_MS + REMOTE_TOOL_TRANSPORT_MARGIN_MS) {
    throw new TypeError(
      "Tool Broker timeout must outlive the maximum Tool execution and transport margin",
    );
  }
  if (modelGatewayUpstreamRequestTimeoutMs > piModelRequestTimeoutMs) {
    throw new TypeError("Model upstream timeout cannot exceed the Pi model-request timeout");
  }
  if (piModelRequestTimeoutMs > piTurnTimeoutMs) {
    throw new TypeError("Pi model-request timeout cannot exceed the Pi Turn timeout");
  }
  if (modelGatewayCapabilityTtlMs < piTurnTimeoutMs + MODEL_CAPABILITY_EXPIRY_MARGIN_MS) {
    throw new TypeError("Model capability TTL must outlive the Pi Turn timeout and expiry margin");
  }
  if (repositoryImportWaitMs < repositoryImportLeaseMs) {
    throw new TypeError("Repository import wait must not expire before its ownership lease");
  }
  const subagentMaximumNodes = integerValue(
    environment,
    "PI_CLOUD_SUBAGENT_MAXIMUM_NODES",
    32,
    1,
    10_000,
  );
  const subagentMaximumConcurrent = integerValue(
    environment,
    "PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT",
    3,
    1,
    1_000,
  );
  if (subagentMaximumConcurrent > subagentMaximumNodes) {
    throw new TypeError("Subagent concurrency cannot exceed the Subagent node budget");
  }
  const databaseUrl = await secret(environment, "DATABASE_URL", allowInlineSecrets);
  const databaseNotificationUrl =
    (await optionalSecret(environment, "DATABASE_NOTIFICATION_URL", allowInlineSecrets)) ??
    databaseUrl;
  return {
    supervisorId: bounded(
      required(environment, "PI_CLOUD_SUPERVISOR_ID"),
      "PI_CLOUD_SUPERVISOR_ID",
      256,
    ),
    controlPlaneBaseUrl,
    supervisorWebSocketUrl: websocketUrl(
      controlPlaneBaseUrl,
      environment.PI_CLOUD_SUPERVISOR_WEBSOCKET_URL,
    ),
    allowInsecureInternalHttp,
    enrollmentToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN",
      allowInlineSecrets,
    ),
    managementToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN",
      allowInlineSecrets,
    ),
    toolBrokerServiceToken: await secret(
      environment,
      "PI_CLOUD_TOOL_BROKER_TOKEN",
      allowInlineSecrets,
    ),
    modelCredentialMasterKey: await secret(
      environment,
      "PI_CLOUD_MODEL_CREDENTIAL_MASTER_KEY",
      allowInlineSecrets,
    ),
    databaseUrl,
    databaseNotificationUrl,
    kafkaBrokers: boundedList(
      required(environment, "PI_CLOUD_KAFKA_BROKERS"),
      "PI_CLOUD_KAFKA_BROKERS",
    ),
    kafkaRawEventTopic: bounded(
      environment.PI_CLOUD_KAFKA_RAW_EVENT_TOPIC ?? "pi-cloud.agent-events.raw.v1",
      "PI_CLOUD_KAFKA_RAW_EVENT_TOPIC",
      249,
    ),
    kafkaSessionMutationTopic: bounded(
      environment.PI_CLOUD_KAFKA_SESSION_MUTATION_TOPIC ?? "pi-cloud.session-mutations.v1",
      "PI_CLOUD_KAFKA_SESSION_MUTATION_TOPIC",
      249,
    ),
    managementHost: bounded(
      environment.PI_CLOUD_SUPERVISOR_MANAGEMENT_HOST ?? "127.0.0.1",
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_HOST",
      256,
    ),
    managementPort: integerValue(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_PORT",
      4100,
      1,
      65_535,
    ),
    managementAdvertisedBaseUrl: internalServiceBaseUrl(
      required(environment, "PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL"),
      allowInsecureInternalHttp,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL",
    ),
    maxConcurrentSessions: integerValue(environment, "PI_CLOUD_SUPERVISOR_CAPACITY", 4, 1, 16),
    subagentMaximumDepth: integerValue(environment, "PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH", 4, 1, 64),
    subagentMaximumNodes,
    subagentMaximumConcurrent,
    toolBrokerBaseUrls: internalServiceBaseUrls(
      required(environment, "PI_CLOUD_TOOL_BROKER_URLS"),
      allowInsecureInternalHttp,
      "PI_CLOUD_TOOL_BROKER_URLS",
    ),
    toolBrokerRequestTimeoutMs,
    trustedWorkspaceDirectory: required(environment, "PI_CLOUD_TRUSTED_WORKSPACE_DIRECTORY"),
    bootStateDirectory: required(environment, "PI_CLOUD_BOOT_STATE_DIRECTORY"),
    checkpointReadCacheTtlMs: integerValue(
      environment,
      "PI_CLOUD_CHECKPOINT_READ_CACHE_TTL_MS",
      10 * 60_000,
      1_000,
      60 * 60_000,
    ),
    checkpointReadCacheMaximumEntries: integerValue(
      environment,
      "PI_CLOUD_CHECKPOINT_READ_CACHE_MAXIMUM_ENTRIES",
      512,
      1,
      16_384,
    ),
    checkpointReadCacheMaximumBytes: integerValue(
      environment,
      "PI_CLOUD_CHECKPOINT_READ_CACHE_MAXIMUM_BYTES",
      32 * 1_024 * 1_024,
      1_024,
      512 * 1_024 * 1_024,
    ),
    modelGatewayHost: bounded(
      environment.PI_CLOUD_MODEL_GATEWAY_HOST ?? "127.0.0.1",
      "PI_CLOUD_MODEL_GATEWAY_HOST",
      256,
    ),
    modelGatewayPort: integerValue(environment, "PI_CLOUD_MODEL_GATEWAY_PORT", 4_200, 1, 65_535),
    modelGatewayAdvertisedBaseUrl: modelGatewayBaseUrl(
      required(environment, "PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL"),
    ),
    modelGatewayCapabilityTtlMs,
    modelGatewayMaximumRequestsPerTurn: integerValue(
      environment,
      "PI_CLOUD_MODEL_GATEWAY_MAXIMUM_REQUESTS_PER_TURN",
      128,
      1,
      256,
    ),
    modelGatewayUpstreamRequestTimeoutMs,
    piModelRequestTimeoutMs,
    piTurnTimeoutMs,
    repositoryImportLeaseMs,
    repositoryImportWaitMs,
    ...(githubGatewayBaseUrl === undefined || githubGatewayServiceToken === undefined
      ? {}
      : {
          githubGatewayBaseUrl: internalServiceBaseUrl(
            githubGatewayBaseUrl,
            allowInsecureInternalHttp,
            "PI_CLOUD_GITHUB_GATEWAY_URL",
          ),
          githubGatewayServiceToken,
        }),
  };
}
