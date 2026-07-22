import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type SandboxManagerConfig = {
  host: string;
  port: number;
  serviceToken: string;
  toolImage: string;
  imageRevision: string;
  kubeconfigPath: string;
  sandboxNamespace: string;
  importerNamespace: string;
  runtimeClassName: string;
  toolServiceAccountName: string;
  importerServiceAccountName: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  repositoryImportTimeoutMs: number;
  warmTtlMs: number;
  maximumWarmActivations: number;
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

export async function loadSandboxManagerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxManagerConfig> {
  if (
    environment.AGENT_DOCK_SANDBOX_PROVIDER !== undefined ||
    environment.AGENT_DOCK_DOCKER_COMMAND !== undefined ||
    environment.AGENT_DOCK_REPOSITORY_IMPORT_NETWORK !== undefined ||
    Object.keys(environment).some((name) => name.startsWith("AGENT_DOCK_MICROVM_"))
  ) {
    throw new TypeError(
      "Legacy Sandbox Provider configuration was removed; this build requires Kubernetes/runsc",
    );
  }
  const kubeconfigPath = required(environment, "AGENT_DOCK_KUBECONFIG_PATH");
  if (!isAbsolute(kubeconfigPath) || kubeconfigPath.includes("\0")) {
    throw new TypeError("AGENT_DOCK_KUBECONFIG_PATH must be an absolute path");
  }
  const pullPolicy = environment.AGENT_DOCK_KUBERNETES_IMAGE_PULL_POLICY ?? "Never";
  if (pullPolicy !== "Always" && pullPolicy !== "IfNotPresent" && pullPolicy !== "Never") {
    throw new TypeError("AGENT_DOCK_KUBERNETES_IMAGE_PULL_POLICY is invalid");
  }
  return {
    host: bounded(environment.AGENT_DOCK_SANDBOX_MANAGER_HOST ?? "127.0.0.1", "host", 256),
    port: integer(environment.AGENT_DOCK_SANDBOX_MANAGER_PORT, 4_300, 1, 65_535),
    serviceToken: await readSecret(required(environment, "AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE")),
    toolImage: bounded(required(environment, "AGENT_DOCK_TOOL_SANDBOX_IMAGE"), "toolImage"),
    imageRevision: bounded(
      required(environment, "AGENT_DOCK_IMAGE_REVISION"),
      "AGENT_DOCK_IMAGE_REVISION",
      128,
    ),
    kubeconfigPath,
    sandboxNamespace: bounded(
      environment.AGENT_DOCK_KUBERNETES_SANDBOX_NAMESPACE ?? "agent-dock-sandboxes",
      "sandboxNamespace",
      63,
    ),
    importerNamespace: bounded(
      environment.AGENT_DOCK_KUBERNETES_IMPORTER_NAMESPACE ?? "agent-dock-importers",
      "importerNamespace",
      63,
    ),
    runtimeClassName: bounded(
      environment.AGENT_DOCK_KUBERNETES_RUNTIME_CLASS ?? "agent-dock-gvisor",
      "runtimeClassName",
      63,
    ),
    toolServiceAccountName: bounded(
      environment.AGENT_DOCK_KUBERNETES_TOOL_SERVICE_ACCOUNT ?? "untrusted-tool",
      "toolServiceAccountName",
      63,
    ),
    importerServiceAccountName: bounded(
      environment.AGENT_DOCK_KUBERNETES_IMPORTER_SERVICE_ACCOUNT ?? "repository-importer",
      "importerServiceAccountName",
      63,
    ),
    imagePullPolicy: pullPolicy,
    repositoryImportTimeoutMs: integer(
      environment.AGENT_DOCK_REPOSITORY_IMPORT_TIMEOUT_MS,
      180_000,
      1_000,
      300_000,
    ),
    warmTtlMs: integer(
      environment.AGENT_DOCK_SANDBOX_WARM_TTL_MS,
      15 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    maximumWarmActivations: integer(environment.AGENT_DOCK_MAXIMUM_WARM_SANDBOXES, 4, 1, 1_000),
  };
}
