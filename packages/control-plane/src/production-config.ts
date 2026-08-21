import { parseUuidPathParameter } from "@pi-cloud/protocol";
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
  toolBrokerBaseUrls: readonly string[];
  sandboxMaterializerToken: string;
  workspaceTerminalToken: string;
  supervisorIdPrefix: string;
  supervisorMaximumCapacity: number;
  supervisorManagementBaseUrlTemplates: readonly string[];
  allowInsecureInternalHttp: boolean;
  host: string;
  port: number;
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
  maximumActiveSandboxes: number;
  sandboxDomains: readonly ProductionSandboxDomainConfig[];
};

export type ProductionSandboxDomainConfig = {
  id: string;
  displayName: string;
  state: "active" | "draining" | "disabled";
  toolBrokerBaseUrl: string;
  workspaceStorageKey: string;
  maximumActiveSandboxes: number;
};

function sandboxDomains(value: string): readonly ProductionSandboxDomainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("PI_CLOUD_SANDBOX_DOMAINS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) {
    throw new TypeError("PI_CLOUD_SANDBOX_DOMAINS_JSON must contain 1 to 64 Domains");
  }
  const domains = parsed.map((entry, index): ProductionSandboxDomainConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Sandbox Domain ${String(index)} must be an object`);
    }
    const domain = entry as Record<string, unknown>;
    if (
      typeof domain.id !== "string" ||
      !/^sandbox-domain-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(domain.id)
    ) {
      throw new TypeError(`Sandbox Domain ${String(index)} has an invalid ID`);
    }
    if (
      typeof domain.displayName !== "string" ||
      domain.displayName.length < 1 ||
      domain.displayName.length > 128
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid display name`);
    }
    if (domain.state !== "active" && domain.state !== "draining" && domain.state !== "disabled") {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid state`);
    }
    if (
      typeof domain.toolBrokerBaseUrl !== "string" ||
      !/^https?:\/\/[^\s]+$/u.test(domain.toolBrokerBaseUrl) ||
      domain.toolBrokerBaseUrl.length > 2_048
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid Tool Broker URL`);
    }
    if (
      typeof domain.workspaceStorageKey !== "string" ||
      !/^[A-Za-z0-9._/-]{1,128}$/u.test(domain.workspaceStorageKey)
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid Workspace storage key`);
    }
    if (
      typeof domain.maximumActiveSandboxes !== "number" ||
      !Number.isSafeInteger(domain.maximumActiveSandboxes) ||
      domain.maximumActiveSandboxes < 1 ||
      domain.maximumActiveSandboxes > 1_000_000
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid capacity`);
    }
    return {
      id: domain.id,
      displayName: domain.displayName,
      state: domain.state,
      toolBrokerBaseUrl: domain.toolBrokerBaseUrl,
      workspaceStorageKey: domain.workspaceStorageKey,
      maximumActiveSandboxes: domain.maximumActiveSandboxes,
    };
  });
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    throw new TypeError("Sandbox Domain IDs must be unique");
  }
  return domains;
}

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
      "PI_CLOUD_TOOL_BROKER_URLS must contain 1-256 comma-separated URLs without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrl(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("PI_CLOUD_TOOL_BROKER_URLS must contain unique URLs");
  }
  return parsed;
}

function managementUrlTemplates(value: string, allowInsecure: boolean): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 64 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain 1-64 comma-separated templates without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrlTemplate(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain unique templates",
    );
  }
  return parsed;
}

function managementUrlTemplate(value: string, allowInsecure: boolean): string {
  if (value.split("{supervisorId}").length !== 2) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATE must contain {supervisorId} exactly once",
    );
  }
  managementUrl(value.replace("{supervisorId}", "pi-worker-validation"), allowInsecure);
  return value;
}

function supervisorIdPrefixValue(value: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62})-$/.test(value)) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_ID_PREFIX must be a lowercase DNS-label prefix ending in a hyphen",
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
  const allowInlineSecrets = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const allowInsecureInternalHttp = booleanValue(
    environment,
    "PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP",
  );
  const publicTenantMaximumUnsettledTurns = integerValue(
    environment,
    "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    10,
    1,
    1_000_000,
  );
  const publicTenantMaximumConcurrentTurns = integerValue(
    environment,
    "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS",
    2,
    1,
    256,
  );
  if (publicTenantMaximumConcurrentTurns > publicTenantMaximumUnsettledTurns) {
    throw new TypeError(
      "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS cannot exceed PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    );
  }
  const platformModelSourceTenantId = parseUuidPathParameter(
    required(environment, "PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID"),
    "PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID",
  );
  const configuredPlatformOperatorTenantId = environment.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID;
  const platformOperatorTenantId = parseUuidPathParameter(
    configuredPlatformOperatorTenantId === undefined ||
      configuredPlatformOperatorTenantId.length === 0
      ? platformModelSourceTenantId
      : configuredPlatformOperatorTenantId,
    "PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID",
  );
  const databaseUrl = await loadProductionDatabaseUrl(environment);
  const databaseNotificationUrl =
    environment.PI_CLOUD_DATABASE_NOTIFICATION_URL_FILE === undefined &&
    environment.PI_CLOUD_DATABASE_NOTIFICATION_URL === undefined
      ? databaseUrl
      : await secret(environment, "PI_CLOUD_DATABASE_NOTIFICATION_URL", allowInlineSecrets);
  return {
    databaseUrl,
    databaseNotificationUrl,
    supervisorEnrollmentToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN",
      allowInlineSecrets,
    ),
    supervisorManagementToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN",
      allowInlineSecrets,
    ),
    modelCredentialMasterKey: await secret(
      environment,
      "PI_CLOUD_MODEL_CREDENTIAL_MASTER_KEY",
      allowInlineSecrets,
    ),
    cubeEgressConfigToken: await secret(
      environment,
      "PI_CLOUD_CUBE_EGRESS_CONFIG_TOKEN",
      allowInlineSecrets,
    ),
    toolBrokerBaseUrls: managementUrls(
      required(environment, "PI_CLOUD_TOOL_BROKER_URLS"),
      allowInsecureInternalHttp,
    ),
    sandboxMaterializerToken: await secret(
      environment,
      "PI_CLOUD_SANDBOX_MATERIALIZER_TOKEN",
      allowInlineSecrets,
    ),
    workspaceTerminalToken: await secret(
      environment,
      "PI_CLOUD_WORKSPACE_TERMINAL_TOKEN",
      allowInlineSecrets,
    ),
    supervisorIdPrefix: supervisorIdPrefixValue(
      required(environment, "PI_CLOUD_SUPERVISOR_ID_PREFIX"),
    ),
    supervisorMaximumCapacity: integerValue(
      environment,
      "PI_CLOUD_SUPERVISOR_MAXIMUM_CAPACITY",
      2,
      1,
      256,
    ),
    supervisorManagementBaseUrlTemplates: managementUrlTemplates(
      required(environment, "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES"),
      allowInsecureInternalHttp,
    ),
    allowInsecureInternalHttp,
    host: bounded(environment.HOST ?? "127.0.0.1", "HOST"),
    port: integerValue(environment, "PORT", 3000, 1, 65_535),
    platformModelSourceTenantId,
    platformOperatorTenantId,
    environmentImageRevision: bounded(
      required(environment, "PI_CLOUD_IMAGE_REVISION"),
      "PI_CLOUD_IMAGE_REVISION",
      128,
    ),
    webSessionCookieSecure: booleanValue(environment, "PI_CLOUD_WEB_SESSION_COOKIE_SECURE"),
    webSessionTtlMs: integerValue(
      environment,
      "PI_CLOUD_WEB_SESSION_TTL_MS",
      30 * 24 * 60 * 60 * 1_000,
      60_000,
      365 * 24 * 60 * 60 * 1_000,
    ),
    publicRegistration: {
      enabled: booleanValue(environment, "PI_CLOUD_PUBLIC_REGISTRATION_ENABLED"),
      maximumTenants: integerValue(
        environment,
        "PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS",
        32,
        2,
        1_000_000,
      ),
      tenantQuotas: {
        maximumProjects: integerValue(
          environment,
          "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS",
          10,
          1,
          1_000_000,
        ),
        maximumSessions: integerValue(
          environment,
          "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS",
          100,
          1,
          1_000_000,
        ),
        maximumUnsettledTurns: publicTenantMaximumUnsettledTurns,
        maximumConcurrentTurns: publicTenantMaximumConcurrentTurns,
        maximumActiveSandboxes: integerValue(
          environment,
          "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_ACTIVE_SANDBOXES",
          2,
          1,
          1_000_000,
        ),
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
    booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS"),
  );
}

export async function loadProductionApiToken(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<string> {
  return secret(
    environment,
    "PI_CLOUD_API_TOKEN",
    booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS"),
  );
}

export function loadProductionBootstrapConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
): ProductionBootstrapConfig {
  const userId = parseUuidPathParameter(
    required(environment, "PI_CLOUD_USER_ID"),
    "PI_CLOUD_USER_ID",
  );
  return {
    tenantId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_TENANT_ID"),
      "PI_CLOUD_TENANT_ID",
    ),
    tenantSlug: bounded(environment.PI_CLOUD_TENANT_SLUG ?? "pi-cloud", "PI_CLOUD_TENANT_SLUG"),
    userId,
    apiCredentialId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_API_CREDENTIAL_ID"),
      "PI_CLOUD_API_CREDENTIAL_ID",
    ),
    credentialBindingId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_CREDENTIAL_BINDING_ID"),
      "PI_CLOUD_CREDENTIAL_BINDING_ID",
    ),
    modelProfileId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_DEFAULT_MODEL_PROFILE_ID"),
      "PI_CLOUD_DEFAULT_MODEL_PROFILE_ID",
    ),
    modelProfileName: bounded(
      environment.PI_CLOUD_MODEL_PROFILE_NAME ?? "deterministic-java-repair",
      "PI_CLOUD_MODEL_PROFILE_NAME",
    ),
    maximumProjects: integerValue(
      environment,
      "PI_CLOUD_TENANT_MAXIMUM_PROJECTS",
      100,
      1,
      1_000_000,
    ),
    maximumSessions: integerValue(
      environment,
      "PI_CLOUD_TENANT_MAXIMUM_SESSIONS",
      1_000,
      1,
      1_000_000,
    ),
    maximumUnsettledTurns: integerValue(
      environment,
      "PI_CLOUD_TENANT_MAXIMUM_UNSETTLED_TURNS",
      100,
      1,
      1_000_000,
    ),
    maximumConcurrentTurns: integerValue(
      environment,
      "PI_CLOUD_TENANT_MAXIMUM_CONCURRENT_TURNS",
      2,
      1,
      256,
    ),
    maximumActiveSandboxes: integerValue(
      environment,
      "PI_CLOUD_TENANT_MAXIMUM_ACTIVE_SANDBOXES",
      64,
      1,
      1_000_000,
    ),
    sandboxDomains: sandboxDomains(required(environment, "PI_CLOUD_SANDBOX_DOMAINS_JSON")),
  };
}
