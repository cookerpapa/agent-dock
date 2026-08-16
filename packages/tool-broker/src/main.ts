import { loadToolBrokerConfig } from "./tool-broker-config.ts";
import { createDatabase } from "@pi-cloud/database";
import { startServiceObservability } from "@pi-cloud/observability";
import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { ToolBrokerServer } from "./tool-broker-server.ts";
import { ToolBroker } from "./tool-broker.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import { PostgresSandboxActivationStateRepository } from "./activation-state-repository.ts";
import { randomUUID } from "node:crypto";

const config = await loadToolBrokerConfig();
const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
const activationState = new PostgresSandboxActivationStateRepository({
  database,
  sandboxDomainId: config.sandboxDomainId,
  instanceId: randomUUID(),
  ownerBaseUrl: config.advertisedBaseUrl,
  leaseMs: config.ownershipLeaseMs,
  heartbeatMs: config.ownershipHeartbeatMs,
});
await activationState.start();
const observability = await startServiceObservability({
  serviceName: "pi-cloud-tool-broker",
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
  workspaceVolumeGateway: new HttpWorkspaceVolumeGateway({
    baseUrl: cube.workspaceVolumeGatewayUrl,
    serviceToken: cube.workspaceVolumeGatewayToken,
    requestTimeoutMs: cube.workspaceVolumeGatewayRequestTimeoutMs,
  }),
});
const broker = new ToolBroker({
  provider,
  ownerBaseUrl: config.advertisedBaseUrl,
  stateRepository: activationState,
  imageRevision: config.imageRevision,
  maximumActiveSandboxes: config.maximumActiveSandboxes,
  warmTtlMs: config.warmTtlMs,
  maximumWarmActivations: config.maximumWarmActivations,
});
const server = new ToolBrokerServer({
  host: config.host,
  port: config.port,
  serviceToken: config.serviceToken,
  terminalToken: config.terminalToken,
  ...(config.materializerToken === undefined
    ? {}
    : { materializerToken: config.materializerToken }),
  broker,
  metrics: observability.metrics,
});

await server.listen();
process.stdout.write("PiCloud Tool Broker ready\n");

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
