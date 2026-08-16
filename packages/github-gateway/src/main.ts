import { pathToFileURL } from "node:url";
import { loadGitHubGatewayConfig } from "./config.ts";
import { GitHubApiClient } from "./github-api-client.ts";
import { GitHubAppAuthentication } from "./github-app-auth.ts";
import { GitHubGatewayServer } from "./server.ts";
import { HttpGitHubWebhookSink } from "./webhook-sink.ts";

export async function startGitHubGateway(): Promise<void> {
  const config = await loadGitHubGatewayConfig();
  const apiClient =
    config.appId === undefined || config.privateKeyPem === undefined
      ? undefined
      : new GitHubApiClient(
          new GitHubAppAuthentication({ appId: config.appId, privateKeyPem: config.privateKeyPem }),
        );
  const sink =
    config.controlPlaneBaseUrl === undefined
      ? undefined
      : new HttpGitHubWebhookSink({
          baseUrl: config.controlPlaneBaseUrl,
          serviceToken: config.serviceToken,
          allowInsecureHttp: true,
        });
  const server = new GitHubGatewayServer({
    host: config.host,
    port: config.port,
    serviceToken: config.serviceToken,
    webhookSecret: config.webhookSecret,
    ...(apiClient === undefined ? {} : { apiClient }),
    ...(sink === undefined ? {} : { webhookSink: (event) => sink.accept(event) }),
  });
  await server.listen();
  process.stdout.write(
    `PiCloud GitHub Gateway listening on ${config.host}:${String(config.port)} configured=${String(apiClient !== undefined)}\n`,
  );
  const close = (): void => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startGitHubGateway().catch(() => {
    process.stderr.write("PiCloud GitHub Gateway failed to start\n");
    process.exitCode = 1;
  });
}
