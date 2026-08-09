import { parseUuidPathParameter } from "@agent-dock/protocol";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { TenantQuotaConfiguration } from "./tenant-administration.ts";

const MAX_SECRET_BYTES = 16 * 1_024;

export type ProductionControlPlaneEnvironment = Readonly<Record<string, string | undefined>>;

export type ProductionControlPlaneConfig = {
  databaseUrl: string;
  databaseNotificationUrl: string;
  supervisorEnrollmentToken: string;
  supervisorManagementToken: string;
  modelCredentialMasterKey: string;
  cubeEgressConfigToken: string;
  sandboxManagerBaseUrls: readonly string[];
  sandboxMaterializerToken: string;
  advancedModulesEnabled: boolean;
  externalWorkerEventLog: boolean;
  supervisorIdPrefix: string;
  supervisorMaximumCapacity: number;
  supervisorManagementBaseUrlTemplates: readonly string[];
  allowInsecureInternalHttp: boolean;
  host: string;
  port: number;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  platformModelSourceTenantId: string;
  platformOperatorTenantId: string;
  environmentImageRevision: string;
  webSessionCookieSecure: boolean;
  webSessionTtlMs: number;
  publicRegistration: {
    enabled: boolean;
    maximumTenants: number;
    tenantQuotas: TenantQuotaConfiguration;
  };
};

export type ProductionBootstrapConfig = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  apiCredentialId: string;
  credentialBindingId: string;
  modelProfileId: string;
  modelProfileName: string;
  maximumProjects: number;
  maximumSessions: number;
  maximumUnsettledTurns: number;
  maximumConcurrentTurns: number;
  executionCells: readonly ProductionExecutionCellConfig[];
};

export type ProductionExecutionCellConfig = {
  id: string;
  displayName: string;
  state: "active" | "draining" | "disabled";
  temporalTaskQueue: string;
  sandboxManagerBaseUrl: string;
  supervisorManagementBaseUrlTemplate: string;
  workspaceStorageKey: string;
  capacityWeight: number;
};

function required(environment: ProductionControlPlaneEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required production configuration ${name} is missing`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 256): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function booleanValue(environment: ProductionControlPlaneEnvironment, name: string): boolean {
  const value = environment[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function integerValue(
  environment: ProductionControlPlaneEnvironment,
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

function executionCells(value: string): readonly ProductionExecutionCellConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("AGENT_DOCK_EXECUTION_CELLS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) {
    throw new TypeError("AGENT_DOCK_EXECUTION_CELLS_JSON must contain 1 to 64 Cells");
  }
  const cells = parsed.map((entry, index): ProductionExecutionCellConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Execution Cell ${String(index)} must be an object`);
    }
    const cell = entry as Record<string, unknown>;
    const id = cell.id;
    const displayName = cell.displayName;
    const state = cell.state;
    const temporalTaskQueue = cell.temporalTaskQueue;
    const sandboxManagerBaseUrl = cell.sandboxManagerBaseUrl;
    const supervisorManagementBaseUrlTemplate = cell.supervisorManagementBaseUrlTemplate;
    const workspaceStorageKey = cell.workspaceStorageKey;
    const capacityWeight = cell.capacityWeight;
    if (typeof id !== "string" || !/^cell-[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/u.test(id)) {
      throw new TypeError(`Execution Cell ${String(index)} has an invalid ID`);
    }
    if (typeof displayName !== "string" || displayName.length < 1 || displayName.length > 128) {
      throw new TypeError(`Execution Cell ${id} has an invalid display name`);
    }
    if (state !== "active" && state !== "draining" && state !== "disabled") {
      throw new TypeError(`Execution Cell ${id} has an invalid state`);
    }
    if (
      typeof temporalTaskQueue !== "string" ||
      temporalTaskQueue.length < 1 ||
      temporalTaskQueue.length > 255
    ) {
      throw new TypeError(`Execution Cell ${id} has an invalid Temporal Task Queue`);
    }
    if (
      typeof sandboxManagerBaseUrl !== "string" ||
      !/^https?:\/\/[^\s]+$/u.test(sandboxManagerBaseUrl) ||
      sandboxManagerBaseUrl.length > 2_048
    ) {
      throw new TypeError(`Execution Cell ${id} has an invalid Sandbox Manager URL`);
    }
    if (
      typeof workspaceStorageKey !== "string" ||
      !/^[A-Za-z0-9._/-]{1,128}$/u.test(workspaceStorageKey)
    ) {
      throw new TypeError(`Execution Cell ${id} has an invalid Workspace storage key`);
    }
    if (
      typeof supervisorManagementBaseUrlTemplate !== "string" ||
      supervisorManagementBaseUrlTemplate.split("{supervisorId}").length !== 2 ||
      !/^https?:\/\/[^\s]+$/u.test(
        supervisorManagementBaseUrlTemplate.replace("{supervisorId}", "worker-validation"),
      ) ||
      supervisorManagementBaseUrlTemplate.length > 2_048
    ) {
      throw new TypeError(`Execution Cell ${id} has an invalid Supervisor management template`);
    }
    if (
      typeof capacityWeight !== "number" ||
      !Number.isSafeInteger(capacityWeight) ||
      capacityWeight < 1 ||
      capacityWeight > 1_000_000
    ) {
      throw new TypeError(`Execution Cell ${id} has an invalid capacity weight`);
    }
    return {
      id,
      displayName,
      state,
      temporalTaskQueue,
      sandboxManagerBaseUrl,
      supervisorManagementBaseUrlTemplate,
      workspaceStorageKey,
      capacityWeight,
    };
  });
  if (new Set(cells.map((cell) => cell.id)).size !== cells.length) {
    throw new TypeError("Execution Cell IDs must be unique");
  }
  if (new Set(cells.map((cell) => cell.temporalTaskQueue)).size !== cells.length) {
    throw new TypeError("Execution Cell Temporal Task Queues must be unique");
  }
  return cells;
}

function managementUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Supervisor management URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP Supervisor management requires explicit opt-in");
  }
  return parsed.toString();
}

function managementUrls(value: string, allowInsecure: boolean): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 256 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(
      "AGENT_DOCK_SANDBOX_MANAGER_URLS must contain 1-256 comma-separated URLs without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrl(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("AGENT_DOCK_SANDBOX_MANAGER_URLS must contain unique URLs");
  }
  return parsed;
}

function managementUrlTemplates(value: string, allowInsecure: boolean): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 64 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain 1-64 comma-separated templates without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrlTemplate(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain unique templates",
    );
  }
  return parsed;
}

function managementUrlTemplate(value: string, allowInsecure: boolean): string {
  if (value.split("{supervisorId}").length !== 2) {
    throw new TypeError(
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATE must contain {supervisorId} exactly once",
    );
  }
  managementUrl(value.replace("{supervisorId}", "pi-worker-validation"), allowInsecure);
  return value;
}

function supervisorIdPrefixValue(value: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62})-$/.test(value)) {
    throw new TypeError(
      "AGENT_DOCK_SUPERVISOR_ID_PREFIX must be a lowercase DNS-label prefix ending in a hyphen",
    );
  }
  return value;
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
  environment: ProductionControlPlaneEnvironment,
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

export async function loadProductionControlPlaneConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<ProductionControlPlaneConfig> {
  const allowInlineSecrets = booleanValue(environment, "AGENT_DOCK_ALLOW_INLINE_SECRETS");
  const allowInsecureInternalHttp = booleanValue(
    environment,
    "AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP",
  );
  const publicTenantMaximumUnsettledTurns = integerValue(
    environment,
    "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    10,
    1,
    1_000_000,
  );
  const publicTenantMaximumConcurrentTurns = integerValue(
    environment,
    "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS",
    2,
    1,
    256,
  );
  if (publicTenantMaximumConcurrentTurns > publicTenantMaximumUnsettledTurns) {
    throw new TypeError(
      "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS cannot exceed AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    );
  }
  const platformModelSourceTenantId = parseUuidPathParameter(
    required(environment, "AGENT_DOCK_PLATFORM_MODEL_SOURCE_TENANT_ID"),
    "AGENT_DOCK_PLATFORM_MODEL_SOURCE_TENANT_ID",
  );
  const configuredPlatformOperatorTenantId = environment.AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID;
  const platformOperatorTenantId = parseUuidPathParameter(
    configuredPlatformOperatorTenantId === undefined ||
      configuredPlatformOperatorTenantId.length === 0
      ? platformModelSourceTenantId
      : configuredPlatformOperatorTenantId,
    "AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID",
  );
  const databaseUrl = await loadProductionDatabaseUrl(environment);
  const databaseNotificationUrl =
    environment.AGENT_DOCK_DATABASE_NOTIFICATION_URL_FILE === undefined &&
    environment.AGENT_DOCK_DATABASE_NOTIFICATION_URL === undefined
      ? databaseUrl
      : await secret(environment, "AGENT_DOCK_DATABASE_NOTIFICATION_URL", allowInlineSecrets);
  return {
    databaseUrl,
    databaseNotificationUrl,
    externalWorkerEventLog: booleanValue(environment, "AGENT_DOCK_EXTERNAL_WORKER_EVENT_LOG"),
    supervisorEnrollmentToken: await secret(
      environment,
      "AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN",
      allowInlineSecrets,
    ),
    supervisorManagementToken: await secret(
      environment,
      "AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN",
      allowInlineSecrets,
    ),
    modelCredentialMasterKey: await secret(
      environment,
      "AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY",
      allowInlineSecrets,
    ),
    cubeEgressConfigToken: await secret(
      environment,
      "AGENT_DOCK_CUBE_EGRESS_CONFIG_TOKEN",
      allowInlineSecrets,
    ),
    sandboxManagerBaseUrls: managementUrls(
      required(environment, "AGENT_DOCK_SANDBOX_MANAGER_URLS"),
      allowInsecureInternalHttp,
    ),
    sandboxMaterializerToken: await secret(
      environment,
      "AGENT_DOCK_SANDBOX_MATERIALIZER_TOKEN",
      allowInlineSecrets,
    ),
    advancedModulesEnabled: booleanValue(environment, "AGENT_DOCK_ADVANCED_MODULES_ENABLED"),
    supervisorIdPrefix: supervisorIdPrefixValue(
      required(environment, "AGENT_DOCK_SUPERVISOR_ID_PREFIX"),
    ),
    supervisorMaximumCapacity: integerValue(
      environment,
      "AGENT_DOCK_SUPERVISOR_MAXIMUM_CAPACITY",
      2,
      1,
      256,
    ),
    supervisorManagementBaseUrlTemplates: managementUrlTemplates(
      required(environment, "AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATES"),
      allowInsecureInternalHttp,
    ),
    allowInsecureInternalHttp,
    host: bounded(environment.HOST ?? "127.0.0.1", "HOST"),
    port: integerValue(environment, "PORT", 3000, 1, 65_535),
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
      environment.AGENT_DOCK_TEMPORAL_TASK_QUEUE ?? "agent-dock-pi-runs-cell-0001-v1",
      "AGENT_DOCK_TEMPORAL_TASK_QUEUE",
      255,
    ),
    platformModelSourceTenantId,
    platformOperatorTenantId,
    environmentImageRevision: bounded(
      required(environment, "AGENT_DOCK_IMAGE_REVISION"),
      "AGENT_DOCK_IMAGE_REVISION",
      128,
    ),
    webSessionCookieSecure: booleanValue(environment, "AGENT_DOCK_WEB_SESSION_COOKIE_SECURE"),
    webSessionTtlMs: integerValue(
      environment,
      "AGENT_DOCK_WEB_SESSION_TTL_MS",
      30 * 24 * 60 * 60 * 1_000,
      60_000,
      365 * 24 * 60 * 60 * 1_000,
    ),
    publicRegistration: {
      enabled: booleanValue(environment, "AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED"),
      maximumTenants: integerValue(
        environment,
        "AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS",
        32,
        2,
        1_000_000,
      ),
      tenantQuotas: {
        maximumProjects: integerValue(
          environment,
          "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_PROJECTS",
          10,
          1,
          1_000_000,
        ),
        maximumSessions: integerValue(
          environment,
          "AGENT_DOCK_PUBLIC_TENANT_MAXIMUM_SESSIONS",
          100,
          1,
          1_000_000,
        ),
        maximumUnsettledTurns: publicTenantMaximumUnsettledTurns,
        maximumConcurrentTurns: publicTenantMaximumConcurrentTurns,
      },
    },
  };
}

export async function loadProductionDatabaseUrl(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<string> {
  return secret(
    environment,
    "DATABASE_URL",
    booleanValue(environment, "AGENT_DOCK_ALLOW_INLINE_SECRETS"),
  );
}

export async function loadProductionApiToken(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<string> {
  return secret(
    environment,
    "AGENT_DOCK_API_TOKEN",
    booleanValue(environment, "AGENT_DOCK_ALLOW_INLINE_SECRETS"),
  );
}

export function loadProductionBootstrapConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
): ProductionBootstrapConfig {
  const userId = parseUuidPathParameter(
    required(environment, "AGENT_DOCK_USER_ID"),
    "AGENT_DOCK_USER_ID",
  );
  return {
    tenantId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_TENANT_ID"),
      "AGENT_DOCK_TENANT_ID",
    ),
    tenantSlug: bounded(
      environment.AGENT_DOCK_TENANT_SLUG ?? "agent-dock",
      "AGENT_DOCK_TENANT_SLUG",
    ),
    userId,
    apiCredentialId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_API_CREDENTIAL_ID"),
      "AGENT_DOCK_API_CREDENTIAL_ID",
    ),
    credentialBindingId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_CREDENTIAL_BINDING_ID"),
      "AGENT_DOCK_CREDENTIAL_BINDING_ID",
    ),
    modelProfileId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID"),
      "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID",
    ),
    modelProfileName: bounded(
      environment.AGENT_DOCK_MODEL_PROFILE_NAME ?? "deterministic-java-repair",
      "AGENT_DOCK_MODEL_PROFILE_NAME",
    ),
    maximumProjects: integerValue(
      environment,
      "AGENT_DOCK_TENANT_MAXIMUM_PROJECTS",
      100,
      1,
      1_000_000,
    ),
    maximumSessions: integerValue(
      environment,
      "AGENT_DOCK_TENANT_MAXIMUM_SESSIONS",
      1_000,
      1,
      1_000_000,
    ),
    maximumUnsettledTurns: integerValue(
      environment,
      "AGENT_DOCK_TENANT_MAXIMUM_UNSETTLED_TURNS",
      100,
      1,
      1_000_000,
    ),
    maximumConcurrentTurns: integerValue(
      environment,
      "AGENT_DOCK_TENANT_MAXIMUM_CONCURRENT_TURNS",
      2,
      1,
      256,
    ),
    executionCells: executionCells(required(environment, "AGENT_DOCK_EXECUTION_CELLS_JSON")),
  };
}
