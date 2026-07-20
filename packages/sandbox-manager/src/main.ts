import { loadSandboxManagerConfig } from "./config.ts";
import { DockerSandboxProvider } from "./docker-sandbox-provider.ts";
import { SandboxManagerServer } from "./server.ts";
import { ToolSandboxManager } from "./tool-sandbox-manager.ts";

const config = await loadSandboxManagerConfig();
const provider = new DockerSandboxProvider({
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
