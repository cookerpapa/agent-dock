import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { GitHubApiClient } from "./github-api-client.ts";
import {
  GitHubGatewayError,
  parseGatewayRequest,
  type GitHubGatewayResponse,
  type GitHubWebhookEvent,
} from "./types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhook } from "./webhook.ts";

export const GITHUB_GATEWAY_RPC_PATH = "/internal/v1/github";
export const GITHUB_GATEWAY_WEBHOOK_PATH = "/webhooks/github";

export type GitHubGatewayServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  webhookSecret: string;
  apiClient?: GitHubApiClient;
  webhookSink?: (event: GitHubWebhookEvent) => Promise<void>;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) throw new TypeError("Service token is invalid");
  return value;
}

function bearer(value: string | undefined): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value ?? "")?.[1];
}

function failure(error: unknown): GitHubGatewayError {
  return error instanceof GitHubGatewayError
    ? error
    : new GitHubGatewayError("github_gateway_failed", "GitHub Gateway operation failed", true);
}

export class GitHubGatewayServer {
  readonly #server: FastifyInstance;
  readonly #host: string;
  readonly #port: number;
  readonly #tokenDigest: Buffer;
  readonly #webhookSecret: string;
  readonly #apiClient: GitHubApiClient | undefined;
  readonly #webhookSink: ((event: GitHubWebhookEvent) => Promise<void>) | undefined;
  #address: string | undefined;

  constructor(options: GitHubGatewayServerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#tokenDigest = digest(validToken(options.serviceToken));
    this.#webhookSecret = options.webhookSecret;
    this.#apiClient = options.apiClient;
    this.#webhookSink = options.webhookSink;
    this.#server = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024, requestTimeout: 60_000 });
    this.#server.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    this.#routes();
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    return this.#address;
  }

  async close(): Promise<void> {
    if (this.#address === undefined) return;
    this.#address = undefined;
    await this.#server.close();
  }

  #routes(): void {
    this.#server.get("/health/live", async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get("/health/ready", async (_request, reply) => {
      await reply
        .code(this.#apiClient === undefined ? 503 : 200)
        .send({ status: this.#apiClient === undefined ? "not_configured" : "ready" });
    });
    this.#server.post(GITHUB_GATEWAY_RPC_PATH, async (request, reply) => {
      const candidate = bearer(request.headers.authorization);
      if (candidate === undefined || !timingSafeEqual(this.#tokenDigest, digest(candidate))) {
        await reply.code(401).send({
          error: {
            code: "invalid_service_credential",
            message: "GitHub Gateway is not authorized",
            retryable: false,
          },
        });
        return;
      }
      if (this.#apiClient === undefined) {
        await reply.code(503).send({
          error: {
            code: "github_app_not_configured",
            message: "GitHub App is not configured",
            retryable: false,
          },
        });
        return;
      }
      try {
        if (!Buffer.isBuffer(request.body))
          throw new GitHubGatewayError("invalid_request", "Request is invalid", false);
        const message = parseGatewayRequest(JSON.parse(request.body.toString("utf8")) as unknown);
        let response: GitHubGatewayResponse;
        if (message.type === "installation.inspect") {
          response = {
            type: "installation.inspected",
            requestId: message.requestId,
            installation: await this.#apiClient.inspectInstallation(message.installationId),
          };
        } else if (message.type === "repository.snapshot") {
          const result = await this.#apiClient.snapshot(
            message.installationId,
            message.repositoryId,
            message.commitSha,
          );
          response = {
            type: "repository.snapshotted",
            requestId: message.requestId,
            repository: result.repository,
            commitSha: result.commitSha,
            workspaceSnapshotBase64: Buffer.from(result.snapshot).toString("base64"),
          };
        } else {
          const result = await this.#apiClient.deliverPullRequest({
            deliveryId: message.deliveryId,
            installationId: message.installationId,
            repositoryId: message.repositoryId,
            baseBranch: message.baseBranch,
            baseCommitSha: message.baseCommitSha,
            headBranch: message.headBranch,
            title: message.title,
            body: message.body,
            workspaceSnapshot: Buffer.from(message.workspaceSnapshotBase64, "base64"),
          });
          response = {
            type: "pull_request.delivered",
            requestId: message.requestId,
            deliveryId: message.deliveryId,
            ...result,
          };
        }
        await reply.code(200).send(response);
      } catch (error: unknown) {
        const result = failure(error);
        await reply.code(result.retryable ? 503 : 409).send({
          error: { code: result.code, message: result.message, retryable: result.retryable },
        });
      }
    });
    this.#server.post(GITHUB_GATEWAY_WEBHOOK_PATH, async (request, reply) => {
      try {
        if (!Buffer.isBuffer(request.body) || request.body.byteLength > 1024 * 1024) {
          throw new GitHubGatewayError(
            "invalid_webhook_payload",
            "Webhook payload is invalid",
            false,
          );
        }
        verifyGitHubWebhook(
          this.#webhookSecret,
          request.body,
          request.headers["x-hub-signature-256"] as string | undefined,
        );
        const event = normalizeGitHubWebhook(
          String(request.headers["x-github-delivery"] ?? ""),
          String(request.headers["x-github-event"] ?? ""),
          request.body,
        );
        await this.#webhookSink?.(event);
        await reply.code(202).send({ accepted: true, deliveryId: event.deliveryId });
      } catch (error: unknown) {
        const result = failure(error);
        await reply.code(result.retryable ? 503 : 401).send({
          error: { code: result.code, message: result.message, retryable: result.retryable },
        });
      }
    });
  }
}
