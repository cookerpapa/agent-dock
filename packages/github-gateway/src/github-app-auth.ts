import { createSign } from "node:crypto";
import { GitHubGatewayError } from "./types.ts";

type CachedToken = { token: string; expiresAtMs: number };

export type GitHubAppAuthenticationOptions = {
  appId: number;
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
};

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export class GitHubAppAuthentication {
  readonly #appId: number;
  readonly #privateKeyPem: string;
  readonly #apiBaseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #tokens = new Map<number, CachedToken>();

  constructor(options: GitHubAppAuthenticationOptions) {
    if (!Number.isSafeInteger(options.appId) || options.appId < 1) {
      throw new TypeError("GitHub App ID is invalid");
    }
    if (!options.privateKeyPem.includes("PRIVATE KEY")) {
      throw new TypeError("GitHub App private key is invalid");
    }
    const apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.github.com/");
    if (apiBaseUrl.protocol !== "https:" && apiBaseUrl.hostname !== "127.0.0.1") {
      throw new TypeError("GitHub API base URL must use HTTPS");
    }
    this.#appId = options.appId;
    this.#privateKeyPem = options.privateKeyPem;
    this.#apiBaseUrl = apiBaseUrl;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? (() => new Date());
  }

  apiUrl(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new TypeError("GitHub API path is invalid");
    return new URL(path.slice(1), this.#apiBaseUrl).toString();
  }

  appJwt(): string {
    const now = Math.floor(this.#clock().valueOf() / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.#appId }));
    const content = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(content);
    signer.end();
    return `${content}.${signer.sign(this.#privateKeyPem).toString("base64url")}`;
  }

  async installationToken(installationId: number): Promise<string> {
    const now = this.#clock().valueOf();
    const cached = this.#tokens.get(installationId);
    if (cached !== undefined && cached.expiresAtMs - now > 60_000) return cached.token;
    let response: Response;
    try {
      response = await this.#fetch(
        this.apiUrl(
          `/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
        ),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.appJwt()}`,
            "user-agent": "pi-cloud-github-gateway",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
    } catch {
      throw new GitHubGatewayError("github_unavailable", "GitHub is unavailable", true);
    }
    if (!response.ok) {
      throw new GitHubGatewayError(
        response.status === 404 ? "installation_not_found" : "github_token_rejected",
        "GitHub installation token request was rejected",
        response.status >= 500 || response.status === 429,
      );
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubGatewayError(
        "github_invalid_response",
        "GitHub returned an invalid token",
        false,
      );
    }
    const expiresAtMs = new Date(body.expires_at).valueOf();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      throw new GitHubGatewayError(
        "github_invalid_response",
        "GitHub returned an invalid token expiry",
        false,
      );
    }
    this.#tokens.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }
}
