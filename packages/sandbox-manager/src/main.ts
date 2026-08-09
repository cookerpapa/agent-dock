import { loadSandboxManagerConfig } from "./config.ts";
import { createDatabase } from "@agent-dock/database";
import { startServiceObservability } from "@agent-dock/observability";
import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { SandboxManagerServer } from "./server.ts";
import { ToolSandboxManager } from "./tool-sandbox-manager.ts";
import { HttpWorkspaceDataMover } from "./workspace-data-mover.ts";
import { PostgresSandboxActivationStateRepository } from "./activation-state-repository.ts";
import { randomUUID } from "node:crypto";

const config = await loadSandboxManagerConfig();
const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
const activationState = new PostgresSandboxActivationStateRepository({
  database,
  cellId: config.executionCellId,
  instanceId: randomUUID(),
  ownerBaseUrl: config.advertisedBaseUrl,
  leaseMs: config.ownershipLeaseMs,
  heartbeatMs: config.ownershipHeartbeatMs,
});
await activationState.start();
const observability = await startServiceObservability({
  serviceName: "agent-dock-sandbox-manager",
  defaultMetricsPort: 9466,
});
const cube = config.cubeSandbox;
const provider = new CubeSandboxProvider({
  templateId: cube.templateId,
  imageRevision: config.imageRevision,
  runtime: {
    apiUrl: cube.apiUrl,
    apiKey: cube.apiKey,
    proxyNodeIp: cube.proxyNodeIp,
    proxyPort: cube.proxyPort,
    proxyScheme: cube.proxyScheme,
    sandboxDomain: cube.sandboxDomain,
    egressProxyIp: cube.egressProxyHost,
    requestTimeoutMs: cube.requestTimeoutMs,
  },
  webProxy: {
    host: cube.egressProxyHost,
    port: cube.egressProxyPort,
  },
  workspaceDataMover: new HttpWorkspaceDataMover({
    baseUrl: cube.workspaceDataMoverUrl,
    serviceToken: cube.workspaceDataMoverToken,
  }),
});
const manager = new ToolSandboxManager({
  provider,
  ownerBaseUrl: config.advertisedBaseUrl,
  stateRepository: activationState,
  imageRevision: config.imageRevision,
  maximumActiveSandboxes: config.maximumActiveSandboxes,
  warmTtlMs: config.warmTtlMs,
  maximumWarmActivations: config.maximumWarmActivations,
});
const server = new SandboxManagerServer({
  host: config.host,
  port: config.port,
  serviceToken: config.serviceToken,
  ...(config.materializerToken === undefined
    ? {}
    : { materializerToken: config.materializerToken }),
  manager,
  metrics: observability.metrics,
});

await server.listen();
process.stdout.write("AgentDock Sandbox Manager ready\n");

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= server
    .close()
    .finally(() => database.destroy())
    .finally(() => observability.close());
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
