import { loadSandboxManagerConfig } from "./config.ts";
import { startServiceObservability } from "@agent-dock/observability";
import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { KubernetesGvisorSandboxProvider } from "./kubernetes-gvisor-sandbox-provider.ts";
import type { SandboxProvider } from "./sandbox-provider.ts";
import { SandboxManagerServer } from "./server.ts";
import { ToolSandboxManager } from "./tool-sandbox-manager.ts";

const config = await loadSandboxManagerConfig();
const observability = await startServiceObservability({
  serviceName: "agent-dock-sandbox-manager",
  defaultMetricsPort: 9466,
});
const createGvisorProvider = (cleanPrewarmTarget: number): KubernetesGvisorSandboxProvider =>
  new KubernetesGvisorSandboxProvider({
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
    cleanPrewarmTarget,
    cleanPrewarmTtlMs: config.cleanPrewarmTtlMs,
    ...(config.dependencyEgress === undefined ? {} : { dependencyEgress: config.dependencyEgress }),
  });

let provider: SandboxProvider;
if (config.provider === "cubesandbox") {
  const cube = config.cubeSandbox;
  if (cube === undefined) throw new TypeError("CubeSandbox configuration is missing");
  // Repository import remains a separately constrained gVisor workload. It
  // must pass the existing exact-commit/capability gate. Ordinary Cube Tool
  // VMs use the deployment-owned full-public/private-denied policy.
  const importer = createGvisorProvider(0);
  provider = new CubeSandboxProvider({
    templateId: cube.templateId,
    imageRevision: config.imageRevision,
    runtime: {
      apiUrl: cube.apiUrl,
      apiKey: cube.apiKey,
      proxyNodeIp: cube.proxyNodeIp,
      proxyPort: cube.proxyPort,
      proxyScheme: cube.proxyScheme,
      sandboxDomain: cube.sandboxDomain,
      requestTimeoutMs: cube.requestTimeoutMs,
    },
    importGitHub: (source, signal) => importer.importGitHub(source, signal),
    checkImporter: () => importer.checkHealth(),
    closeImporter: () => importer.close(),
    bootstrapProvider: importer,
  });
} else {
  provider = createGvisorProvider(config.cleanPrewarmTarget);
}
const manager = new ToolSandboxManager({
  provider,
  imageRevision: config.imageRevision,
  maximumActiveSandboxes: config.maximumActiveSandboxes,
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
