import { readFile } from "node:fs/promises";
import { AgentDockMetrics } from "./metrics.ts";
import { startMetricsEndpoint, type MetricsEndpoint } from "./metrics-server.ts";
import { initializeTelemetry, type TelemetryRuntime } from "./trace.ts";

export type ServiceObservability = Readonly<{
  metrics: AgentDockMetrics;
  tracesExported: boolean;
  metricsPort?: number;
  close(): Promise<void>;
}>;

function optionalEnvironment(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  if (/[\x00-\x1f\x7f]/.test(value)) throw new TypeError(`${name} is invalid`);
  return value.trim();
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("AGENT_DOCK_METRICS_PORT is invalid");
  }
  return parsed;
}

async function metricsToken(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = optionalEnvironment(environment, "AGENT_DOCK_METRICS_TOKEN_FILE");
  if (path === undefined) return undefined;
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32 || token.length > 512 || /[\x00-\x1f\x7f]/.test(token)) {
    throw new TypeError("Metrics bearer token file is invalid");
  }
  return token;
}

export async function startServiceObservability(options: {
  serviceName: string;
  defaultMetricsPort: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<ServiceObservability> {
  const environment = options.environment ?? process.env;
  const metrics = new AgentDockMetrics(options.serviceName, true);
  const traceEndpoint = optionalEnvironment(environment, "AGENT_DOCK_OTLP_TRACES_ENDPOINT");
  const telemetry: TelemetryRuntime = await initializeTelemetry({
    serviceName: options.serviceName,
    ...(traceEndpoint === undefined ? {} : { endpoint: traceEndpoint }),
  });
  let endpoint: MetricsEndpoint | undefined;
  try {
    const token = await metricsToken(environment);
    if (token !== undefined) {
      endpoint = await startMetricsEndpoint({
        host: optionalEnvironment(environment, "AGENT_DOCK_METRICS_HOST") ?? "0.0.0.0",
        port: port(
          optionalEnvironment(environment, "AGENT_DOCK_METRICS_PORT"),
          options.defaultMetricsPort,
        ),
        token,
        registry: metrics.registry,
      });
    }
  } catch (error: unknown) {
    await telemetry.shutdown();
    throw error;
  }
  return {
    metrics,
    tracesExported: telemetry.enabled,
    ...(endpoint === undefined ? {} : { metricsPort: endpoint.port }),
    close: async () => {
      await endpoint?.close();
      await telemetry.shutdown();
    },
  };
}
