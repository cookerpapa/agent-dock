import {
  GitHubGatewayError,
  type GitHubGatewayRequest,
  type GitHubGatewayResponse,
} from "./types.ts";
import { GITHUB_GATEWAY_RPC_PATH } from "./server.ts";

export type GitHubGatewayClientOptions = {
  baseUrl: string;
  serviceToken: string;
  allowInsecureHttp?: boolean;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
};

export class GitHubGatewayClient {
  readonly #url: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GitHubGatewayClientOptions) {
    const base = new URL(options.baseUrl);
    if (
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && options.allowInsecureHttp === true)) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new TypeError("GitHub Gateway base URL is invalid");
    }
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.serviceToken)) {
      throw new TypeError("GitHub Gateway service token is invalid");
    }
    this.#url = new URL(GITHUB_GATEWAY_RPC_PATH.slice(1), base).toString();
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  async request(message: GitHubGatewayRequest): Promise<GitHubGatewayResponse> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { authorization: this.#authorization, "content-type": "application/json" },
        body: JSON.stringify(message),
      });
    } catch {
      throw new GitHubGatewayError(
        "github_gateway_unavailable",
        "GitHub Gateway is unavailable",
        true,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GitHubGatewayError(
        "github_gateway_invalid_response",
        "GitHub Gateway returned invalid JSON",
        false,
      );
    }
    if (!response.ok) {
      const error =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error?: unknown }).error
          : undefined;
      const value =
        typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
      throw new GitHubGatewayError(
        typeof value.code === "string" ? value.code : "github_gateway_rejected",
        typeof value.message === "string" ? value.message : "GitHub Gateway rejected the operation",
        typeof value.retryable === "boolean" ? value.retryable : response.status >= 500,
      );
    }
    if (typeof body !== "object" || body === null || !("type" in body) || !("requestId" in body)) {
      throw new GitHubGatewayError(
        "github_gateway_invalid_response",
        "GitHub Gateway response is invalid",
        false,
      );
    }
    return body as GitHubGatewayResponse;
  }
}
