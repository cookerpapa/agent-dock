import { parseUuidPathParameter } from "@agent-dock/protocol";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_SECRET_BYTES = 16 * 1_024;

export type ProductionControlPlaneEnvironment = Readonly<Record<string, string | undefined>>;

export type ProductionControlPlaneConfig = {
  databaseUrl: string;
  tenantId: string;
  defaultModelProfileId: string;
  apiToken: string;
  supervisorEnrollmentToken: string;
  supervisorManagementToken: string;
  supervisorId: string;
  supervisorMaximumCapacity: number;
  supervisorManagementBaseUrl: string;
  allowInsecureInternalHttp: boolean;
  host: string;
  port: number;
  maximumLanesPerSupervisor: number;
};

export type ProductionBootstrapConfig = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  credentialBindingId: string;
  modelProfileId: string;
  modelProfileName: string;
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
    throw new TypeError("AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP Supervisor management requires explicit opt-in");
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
  return {
    databaseUrl: await secret(environment, "DATABASE_URL", allowInlineSecrets),
    tenantId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_TENANT_ID"),
      "AGENT_DOCK_TENANT_ID",
    ),
    defaultModelProfileId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID"),
      "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID",
    ),
    apiToken: await secret(environment, "AGENT_DOCK_API_TOKEN", allowInlineSecrets),
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
    supervisorId: bounded(
      required(environment, "AGENT_DOCK_SUPERVISOR_ID"),
      "AGENT_DOCK_SUPERVISOR_ID",
    ),
    supervisorMaximumCapacity: integerValue(
      environment,
      "AGENT_DOCK_SUPERVISOR_MAXIMUM_CAPACITY",
      2,
      1,
      256,
    ),
    supervisorManagementBaseUrl: managementUrl(
      required(environment, "AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL"),
      allowInsecureInternalHttp,
    ),
    allowInsecureInternalHttp,
    host: bounded(environment.HOST ?? "127.0.0.1", "HOST"),
    port: integerValue(environment, "PORT", 3000, 1, 65_535),
    maximumLanesPerSupervisor: integerValue(
      environment,
      "AGENT_DOCK_MAXIMUM_LANES_PER_SUPERVISOR",
      8,
      1,
      256,
    ),
  };
}

export function loadProductionBootstrapConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
): ProductionBootstrapConfig {
  return {
    tenantId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_TENANT_ID"),
      "AGENT_DOCK_TENANT_ID",
    ),
    tenantSlug: bounded(
      environment.AGENT_DOCK_TENANT_SLUG ?? "agent-dock",
      "AGENT_DOCK_TENANT_SLUG",
    ),
    userId: parseUuidPathParameter(
      required(environment, "AGENT_DOCK_USER_ID"),
      "AGENT_DOCK_USER_ID",
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
  };
}
