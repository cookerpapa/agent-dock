import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type GitHubGatewayConfig = {
  host: string;
  port: number;
  serviceToken: string;
  webhookSecret: string;
  controlPlaneBaseUrl?: string;
  appId?: number;
  privateKeyPem?: string;
};

async function secretFile(environment: NodeJS.ProcessEnv, name: string, multiline = false) {
  const path = environment[`${name}_FILE`];
  if (path === undefined || !isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${name}_FILE is missing or invalid`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > 64 * 1024
    ) {
      throw new TypeError(`${name}_FILE is not a private bounded file`);
    }
    const value = await handle.readFile("utf8");
    const normalized = multiline ? value : value.replace(/\r?\n$/, "");
    if (!multiline && /[\r\n\0]/.test(normalized)) throw new TypeError(`${name}_FILE is invalid`);
    if (normalized.includes("\0")) throw new TypeError(`${name}_FILE is invalid`);
    return normalized;
  } finally {
    await handle.close();
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

function internalUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("Control Plane URL is invalid");
  }
  return parsed.toString();
}

export async function loadGitHubGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitHubGatewayConfig> {
  const serviceToken = await secretFile(environment, "PI_CLOUD_GITHUB_GATEWAY_TOKEN");
  const webhookSecret = await secretFile(environment, "PI_CLOUD_GITHUB_WEBHOOK_SECRET");
  const appIdValue = environment.PI_CLOUD_GITHUB_APP_ID?.trim() || undefined;
  const privateKeyFile = environment.PI_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE;
  if (appIdValue !== undefined && privateKeyFile === undefined) {
    throw new TypeError("GitHub App private key must be configured with the App ID");
  }
  return {
    host: environment.HOST ?? "127.0.0.1",
    port: integer(environment.PORT, 4400, "PORT", 1, 65_535),
    serviceToken,
    webhookSecret,
    ...(environment.PI_CLOUD_CONTROL_PLANE_URL === undefined
      ? {}
      : { controlPlaneBaseUrl: internalUrl(environment.PI_CLOUD_CONTROL_PLANE_URL) }),
    ...(appIdValue === undefined
      ? {}
      : {
          appId: integer(appIdValue, 0, "PI_CLOUD_GITHUB_APP_ID", 1, Number.MAX_SAFE_INTEGER),
          privateKeyPem: await secretFile(environment, "PI_CLOUD_GITHUB_APP_PRIVATE_KEY", true),
        }),
  };
}
