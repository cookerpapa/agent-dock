import { loadSandboxManagerConfig } from "./config.ts";
import { startServiceObservability } from "@agent-dock/observability";
import { KubernetesGvisorSandboxProvider } from "./kubernetes-gvisor-sandbox-provider.ts";
import { SandboxManagerServer } from "./server.ts";
import { ToolSandboxManager } from "./tool-sandbox-manager.ts";

const config = await loadSandboxManagerConfig();
const observability = await startServiceObservability({
  serviceName: "agent-dock-sandbox-manager",
  defaultMetricsPort: 9466,
});
const provider = new KubernetesGvisorSandboxProvider({
  toolImage: config.toolImage,
  imageRevision: config.imageRevision,
  kubeconfigPath: config.kubeconfigPath,
  sandboxNamespace: config.sandboxNamespace,
  importerNamespace: config.importerNamespace,
  runtimeClassName: config.runtimeClassName,
  toolServiceAccountName: config.toolServiceAccountName,
  importerServiceAccountName: config.importerServiceAccountName,
  imagePullPolicy: config.imagePullPolicy,
  repositoryImportTimeoutMs: config.repositoryImportTimeoutMs,
  cleanPrewarmTarget: config.cleanPrewarmTarget,
  cleanPrewarmTtlMs: config.cleanPrewarmTtlMs,
  ...(config.dependencyEgress === undefined ? {} : { dependencyEgress: config.dependencyEgress }),
});
const manager = new ToolSandboxManager({
  provider,
  imageRevision: config.imageRevision,
  warmTtlMs: config.warmTtlMs,
  maximumWarmActivations: config.maximumWarmActivations,
});
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
