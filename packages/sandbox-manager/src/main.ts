import { loadSandboxManagerConfig } from "./config.ts";
import { startServiceObservability } from "@agent-dock/observability";
import { DockerSandboxProvider } from "./docker-sandbox-provider.ts";
import { DockerMicrovmSandboxProvider } from "./docker-microvm-sandbox-provider.ts";
import { SandboxManagerServer } from "./server.ts";
import { ToolSandboxManager } from "./tool-sandbox-manager.ts";

const config = await loadSandboxManagerConfig();
const observability = await startServiceObservability({
  serviceName: "agent-dock-sandbox-manager",
  defaultMetricsPort: 9466,
});
const provider =
  config.sandboxProvider === "docker_microvm"
    ? new DockerMicrovmSandboxProvider({
        toolImage: config.toolImage,
        repositoryImportNetwork: config.repositoryImportNetwork,
        dockerCommand: config.dockerCommand,
        repositoryImportTimeoutMs: config.repositoryImportTimeoutMs,
        stateDirectory: config.microvmStateDirectory,
        templateImage: config.microvmTemplateImage,
        templatePullPolicy: config.microvmTemplatePullPolicy,
        createTimeoutMs: config.microvmCreateTimeoutMs,
      })
    : new DockerSandboxProvider({
        toolImage: config.toolImage,
        repositoryImportNetwork: config.repositoryImportNetwork,
        dockerCommand: config.dockerCommand,
        repositoryImportTimeoutMs: config.repositoryImportTimeoutMs,
      });
const manager = new ToolSandboxManager({ provider });
const server = new SandboxManagerServer({
  host: config.host,
  port: config.port,
  serviceToken: config.serviceToken,
  manager,
  metrics: observability.metrics,
});

await server.listen();
process.stdout.write("AgentDock Sandbox Manager ready\n");

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= server.close().finally(() => observability.close());
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
