import {
  parseInternalServiceError,
  parseSupervisorBootProvisionResponse,
  type SupervisorBootProvisionRequest,
  type SupervisorBootProvisionResponse,
} from "@pi-cloud/protocol";

const DEFAULT_PROVISION_PATH = "/internal/v1/supervisor/boots";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type SupervisorProvisioningClientOptions = {
  baseUrl: string;
  enrollmentToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export class SupervisorProvisioningClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorProvisioningClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function controlPlaneUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Control-plane base URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP control-plane provisioning requires explicit opt-in");
  }
  return parsed.toString();
}

function boundedToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("enrollmentToken must contain 32-4096 bounded ASCII bytes");
  }
  return value;
}

export class SupervisorProvisioningClient {
  readonly #url: string;
  readonly #authorization: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SupervisorProvisioningClientOptions) {
    const root = controlPlaneUrl(options.baseUrl, options.allowInsecureHttp === true);
    this.#url = new URL(DEFAULT_PROVISION_PATH, root).toString();
    this.#authorization = `Bearer ${boundedToken(options.enrollmentToken)}`;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  async provision(
    request: SupervisorBootProvisionRequest,
  ): Promise<SupervisorBootProvisionResponse> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch {
      throw new SupervisorProvisioningClientError(
        "provision_service_unavailable",
        "Supervisor provision service is unavailable",
        true,
      );
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new SupervisorProvisioningClientError(
        "provision_invalid_response",
        "Supervisor provision service returned an invalid response",
        false,
      );
    }
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(body).error;
        throw new SupervisorProvisioningClientError(
          failure.code,
          failure.message,
          failure.retryable,
        );
      } catch (error: unknown) {
        if (error instanceof SupervisorProvisioningClientError) throw error;
        throw new SupervisorProvisioningClientError(
          "provision_rejected",
          "Supervisor provision service rejected the request",
          response.status >= 500,
        );
      }
    }
    let parsed: SupervisorBootProvisionResponse;
    try {
      parsed = parseSupervisorBootProvisionResponse(body);
    } catch {
      throw new SupervisorProvisioningClientError(
        "provision_invalid_response",
        "Supervisor provision service returned an invalid response",
        false,
      );
    }
    if (
      parsed.requestId !== request.requestId ||
      parsed.supervisorId !== request.supervisorId ||
      parsed.bootId !== request.bootId ||
      parsed.sandboxId !== request.sandboxId ||
      parsed.credentialId !== request.credentialId ||
      parsed.maxConcurrentSessions !== request.maxConcurrentSessions
    ) {
      throw new SupervisorProvisioningClientError(
        "provision_response_mismatch",
        "Supervisor provision response did not match",
        false,
      );
    }
    return parsed;
  }
}
