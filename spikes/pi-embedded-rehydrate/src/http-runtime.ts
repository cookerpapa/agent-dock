import * as undici from "undici";

export const DEFAULT_EMBEDDED_HTTP_IDLE_TIMEOUT_MS = 300_000;

export type EmbeddedPiHttpRuntimeStatus = {
  installed: boolean;
  idleTimeoutMs: number;
  proxyEnvironmentPresent: boolean;
};

let configuredIdleTimeoutMs: number | undefined;

function hasProxyEnvironment(): boolean {
  return [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ].some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function assertIdleTimeout(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Embedded Pi HTTP idle timeout must be a finite non-negative number");
  }
}

/**
 * Install the process-wide HTTP implementation required by Pi's provider SDKs.
 *
 * Pi's CLI does this in its executable bootstrap, but direct SDK consumers do
 * not pass through that entry point. AgentDock owns the equivalent worker-side
 * initialization and intentionally reads proxy routing only from the process
 * environment; proxy URLs and credentials are never returned or logged.
 */
export function ensureEmbeddedPiHttpRuntime(
  idleTimeoutMs = DEFAULT_EMBEDDED_HTTP_IDLE_TIMEOUT_MS,
): EmbeddedPiHttpRuntimeStatus {
  assertIdleTimeout(idleTimeoutMs);

  if (configuredIdleTimeoutMs !== undefined) {
    if (configuredIdleTimeoutMs !== idleTimeoutMs) {
      throw new Error(
        "Embedded Pi HTTP runtime is already installed with a different idle timeout",
      );
    }
    return {
      installed: false,
      idleTimeoutMs,
      proxyEnvironmentPresent: hasProxyEnvironment(),
    };
  }

  const dispatcher = new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: idleTimeoutMs,
    headersTimeout: idleTimeoutMs,
  });
  undici.setGlobalDispatcher(dispatcher);
  undici.install?.();
  configuredIdleTimeoutMs = idleTimeoutMs;

  return {
    installed: true,
    idleTimeoutMs,
    proxyEnvironmentPresent: hasProxyEnvironment(),
  };
}
