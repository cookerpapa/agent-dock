import { GitHubGatewayError, type GitHubWebhookEvent } from "./types.ts";

export const CONTROL_PLANE_GITHUB_WEBHOOK_PATH = "/internal/v1/github/webhook-events";

export class HttpGitHubWebhookSink {
  readonly #url: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    serviceToken: string;
    allowInsecureHttp?: boolean;
    fetchImplementation?: typeof fetch;
  }) {
    const base = new URL(options.baseUrl);
    if (
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && options.allowInsecureHttp === true)) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new TypeError("Control Plane webhook sink URL is invalid");
    }
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.serviceToken)) {
      throw new TypeError("Webhook sink service token is invalid");
    }
    this.#url = new URL(CONTROL_PLANE_GITHUB_WEBHOOK_PATH.slice(1), base).toString();
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  async accept(event: GitHubWebhookEvent): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: this.#authorization, "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch {
      throw new GitHubGatewayError("webhook_sink_unavailable", "Webhook sink is unavailable", true);
    }
    if (!response.ok) {
      throw new GitHubGatewayError(
        "webhook_sink_rejected",
        "Webhook sink rejected the delivery",
        response.status >= 500,
      );
    }
  }
}
