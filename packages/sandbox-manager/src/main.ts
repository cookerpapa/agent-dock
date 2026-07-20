import { loadSandboxManagerConfig } from "./config.ts";
import { DockerToolSandboxManager } from "./docker-tool-sandbox-manager.ts";
import { SandboxManagerServer } from "./server.ts";

const config = await loadSandboxManagerConfig();
const manager = new DockerToolSandboxManager({
  toolImage: config.toolImage,
  repositoryImportNetwork: config.repositoryImportNetwork,
  dockerCommand: config.dockerCommand,
  repositoryImportTimeoutMs: config.repositoryImportTimeoutMs,
});
const server = new SandboxManagerServer({
  host: config.host,
  port: config.port,
  serviceToken: config.serviceToken,
  manager,
});

await server.listen();
process.stdout.write("AgentDock Sandbox Manager ready\n");

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= server.close();
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
