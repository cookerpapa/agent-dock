import { isAbsolute } from "node:path";

export const DEFAULT_PROVIDER_RELAY_SOCKET = "/run/pi-cloud-provider-relay/provider-egress.sock";

export type ProviderEgressRelayConfig =
  | Readonly<{
      mode: "host";
      socketPath: string;
      allowedHosts: readonly string[];
      upstreamProxyUrl?: URL;
    }>
  | Readonly<{
      mode: "bridge";
      socketPath: string;
      host: "0.0.0.0" | "127.0.0.1";
      port: number;
    }>;

function socketPath(value: string | undefined): string {
  const path = value ?? DEFAULT_PROVIDER_RELAY_SOCKET;
  if (!isAbsolute(path) || path.length > 4_096 || path.includes("\0")) {
    throw new TypeError("PI_CLOUD_PROVIDER_RELAY_SOCKET is invalid");
  }
  return path;
}

function allowedHosts(value: string | undefined): readonly string[] {
  const hosts = [...new Set((value ?? "api.deepseek.com").split(",").map((host) => host.trim()))];
  if (
    hosts.length < 1 ||
    hosts.length > 16 ||
    hosts.some(
      (host) =>
        host.length > 253 ||
        host !== host.toLowerCase() ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ),
    )
  ) {
    throw new TypeError("PI_CLOUD_PROVIDER_RELAY_ALLOWED_HOSTS is invalid");
  }
  return hosts;
}

function upstreamProxyUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 4_096 || value.includes("\0")) {
    throw new TypeError("PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY is invalid");
  }
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY is invalid");
  }
  return url;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3129");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("PI_CLOUD_PROVIDER_RELAY_PORT is invalid");
  }
  return parsed;
}

export function loadProviderEgressRelayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderEgressRelayConfig {
  const mode = environment.PI_CLOUD_PROVIDER_RELAY_MODE;
  const path = socketPath(environment.PI_CLOUD_PROVIDER_RELAY_SOCKET);
  if (mode === "host") {
    const upstream = upstreamProxyUrl(environment.PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY);
    return {
      mode,
      socketPath: path,
      allowedHosts: allowedHosts(environment.PI_CLOUD_PROVIDER_RELAY_ALLOWED_HOSTS),
      ...(upstream === undefined ? {} : { upstreamProxyUrl: upstream }),
    };
  }
  if (mode === "bridge") {
    const host = environment.PI_CLOUD_PROVIDER_RELAY_HOST ?? "0.0.0.0";
    if (host !== "0.0.0.0" && host !== "127.0.0.1") {
      throw new TypeError("PI_CLOUD_PROVIDER_RELAY_HOST is invalid");
    }
    return {
      mode,
      socketPath: path,
      host,
      port: port(environment.PI_CLOUD_PROVIDER_RELAY_PORT),
    };
  }
  throw new TypeError("PI_CLOUD_PROVIDER_RELAY_MODE must be host or bridge");
}
