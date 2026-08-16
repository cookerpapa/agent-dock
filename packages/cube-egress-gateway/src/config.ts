import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { isAbsolute } from "node:path";

export type CubeEgressGatewayConfig = Readonly<{
  host: string;
  port: number;
  controlPlaneUrl: string;
  serviceToken: string;
  pollIntervalMs: number;
}>;

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError("Cube egress gateway numeric configuration is invalid");
  }
  return parsed;
}

function controlPlaneUrl(value: string | undefined): string {
  const parsed = new URL(value ?? "http://127.0.0.1:8080/v1/internal/cube-egress-configuration");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname !== "/v1/internal/cube-egress-configuration"
  ) {
    throw new TypeError("Cube egress gateway control-plane URL is invalid");
  }
  return parsed.toString();
}

async function serviceToken(path: string | undefined): Promise<string> {
  if (path === undefined || !isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("Cube egress gateway service token file is invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const mode = metadata.mode & 0o777;
    const readableByProcess =
      (mode & 0o400) !== 0 ||
      ((mode & 0o040) !== 0 && process.getegid !== undefined && metadata.gid === process.getegid());
    if (
      !metadata.isFile() ||
      metadata.size < 32 ||
      metadata.size > 4_096 ||
      !readableByProcess ||
      (mode & 0o022) !== 0 ||
      (mode & 0o007) !== 0
    ) {
      throw new TypeError("Cube egress gateway service token file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!/^[A-Za-z0-9_-]{32,4096}$/.test(value)) {
      throw new TypeError("Cube egress gateway service token is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadCubeEgressGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CubeEgressGatewayConfig> {
  const host = environment.PI_CLOUD_CUBE_EGRESS_HOST ?? "10.255.255.254";
  if (!isIPv4(host)) throw new TypeError("PI_CLOUD_CUBE_EGRESS_HOST must be IPv4");
  return {
    host,
    port: integer(environment.PI_CLOUD_CUBE_EGRESS_PORT, 3_128, 1, 65_535),
    controlPlaneUrl: controlPlaneUrl(environment.PI_CLOUD_CUBE_EGRESS_CONTROL_PLANE_URL),
    serviceToken: await serviceToken(environment.PI_CLOUD_CUBE_EGRESS_CONFIG_TOKEN_FILE),
    pollIntervalMs: integer(environment.PI_CLOUD_CUBE_EGRESS_POLL_INTERVAL_MS, 1_000, 250, 60_000),
  };
}
