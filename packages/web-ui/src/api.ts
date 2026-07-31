import {
  parseAcceptedTurnCancellationResource,
  parseAcceptedTurnResource,
  parseTurnSteerResource,
  parseAuthSessionResource,
  parseArchiveSessionRequest,
  parseConversationDetailResource,
  parseConversationListResource,
  parseControlPlaneApiError,
  parseModelConfigurationResource,
  parseCubeProxyConfigurationResource,
  parseLogoutResource,
  parseProjectResource,
  parseRunListResource,
  parseRunResource,
  parseSessionResource,
  parseTenantIdentityResource,
  parseTenantRegistrationResource,
  parseWorkspaceFileListResource,
  parseWorkspaceListResource,
  parseWorkspaceOperationResource,
  parseWorkspaceVersionListResource,
  parseWorkspaceVersionResource,
  type ConversationDetailResource,
  type AuthSessionResource,
  type ConversationListResource,
  type AcceptedTurnCancellationResource,
  type AcceptedTurnResource,
  type TurnSteerResource,
  type ProjectResource,
  type DeepSeekModelId,
  type ModelConfigurationResource,
  type CubeProxyConfigurationResource,
  type LogoutResource,
  type RunListResource,
  type RunResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type TurnThinkingLevel,
  type WorkspaceFileListResource,
  type WorkspaceListResource,
  type WorkspaceOperationResource,
  type WorkspaceSourceRequest,
  type WorkspaceVersionListResource,
  type WorkspaceVersionResource,
} from "@agent-dock/protocol";

export class AgentDockApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AgentDockApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchImplementation = typeof fetch;

async function responseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AgentDockApiError(
      response.status,
      "invalid_response",
      "Control plane returned a non-JSON response",
    );
  }
}

async function request(
  fetchImplementation: FetchImplementation,
  path: string,
  init: RequestInit,
  authorizationToken?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(authorizationToken === undefined
          ? {}
          : { authorization: `Bearer ${authorizationToken}` }),
      },
    });
  } catch {
    throw new AgentDockApiError(0, "network_error", "Control plane is unreachable");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    try {
      const parsed = parseControlPlaneApiError(body);
      throw new AgentDockApiError(response.status, parsed.error.code, parsed.error.message);
    } catch (error: unknown) {
      if (error instanceof AgentDockApiError) throw error;
      throw new AgentDockApiError(
        response.status,
        "invalid_error_response",
        `Control plane rejected the request with HTTP ${String(response.status)}`,
      );
    }
  }
  return body;
}

async function requestBytes(
  fetchImplementation: FetchImplementation,
  path: string,
  authorizationToken?: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(path, {
      method: "GET",
      credentials: "same-origin",
      ...(authorizationToken === undefined
        ? {}
        : { headers: { authorization: `Bearer ${authorizationToken}` } }),
    });
  } catch {
    throw new AgentDockApiError(0, "network_error", "Control plane is unreachable");
  }
  if (!response.ok) {
    const body = await responseJson(response);
    try {
      const parsed = parseControlPlaneApiError(body);
      throw new AgentDockApiError(response.status, parsed.error.code, parsed.error.message);
    } catch (error: unknown) {
      if (error instanceof AgentDockApiError) throw error;
      throw new AgentDockApiError(
        response.status,
        "invalid_error_response",
        `Control plane rejected the request with HTTP ${String(response.status)}`,
      );
    }
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

function jsonRequest(
  body: unknown,
  idempotencyKey?: string,
  method: "POST" | "PUT" = "POST",
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

export class AgentDockApi {
  readonly #fetch: FetchImplementation;
  readonly #authorizationToken: string | undefined;

  constructor(
    fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
    authorizationToken?: string,
  ) {
    this.#fetch = fetchImplementation;
    if (
      authorizationToken !== undefined &&
      (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(authorizationToken) ||
        /[\r\n]/.test(authorizationToken))
    ) {
      throw new TypeError("authorizationToken is invalid");
    }
    this.#authorizationToken = authorizationToken;
  }

  async getIdentity(): Promise<TenantIdentityResource> {
    return parseTenantIdentityResource(
      await request(this.#fetch, "/v1/identity", { method: "GET" }, this.#authorizationToken),
    );
  }

  async registerAccount(
    username: string,
    displayName: string,
    password: string,
  ): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(
        this.#fetch,
        "/v1/auth/register",
        jsonRequest({ username, displayName, password }),
      ),
    );
  }

  async loginAccount(username: string, password: string): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(this.#fetch, "/v1/auth/login", jsonRequest({ username, password })),
    );
  }

  async logout(): Promise<LogoutResource> {
    return parseLogoutResource(await request(this.#fetch, "/v1/auth/logout", jsonRequest({})));
  }

  async getModelConfiguration(): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceModelConfiguration(
    modelId: DeepSeekModelId,
    apiKey: string,
  ): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        jsonRequest({ provider: "deepseek", modelId, apiKey }, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async getCubeProxyConfiguration(): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceCubeProxyConfiguration(
    enabled: boolean,
    proxyUrl?: string,
  ): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        jsonRequest({ enabled, ...(proxyUrl === undefined ? {} : { proxyUrl }) }, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async registerTenant(
    tenantSlug: string,
    displayName: string,
  ): Promise<TenantRegistrationResource> {
    return parseTenantRegistrationResource(
      await request(this.#fetch, "/v1/registrations", jsonRequest({ tenantSlug, displayName })),
    );
  }

  async listConversations(): Promise<ConversationListResource> {
    return parseConversationListResource(
      await request(this.#fetch, "/v1/conversations", { method: "GET" }, this.#authorizationToken),
    );
  }

  async listWorkspaces(): Promise<WorkspaceListResource> {
    return parseWorkspaceListResource(
      await request(this.#fetch, "/v1/workspaces", { method: "GET" }, this.#authorizationToken),
    );
  }

  async deleteConversation(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceOperationResource> {
    return parseWorkspaceOperationResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": idempotencyKey },
        },
        this.#authorizationToken,
      ),
    );
  }

  async getConversation(sessionId: string): Promise<ConversationDetailResource> {
    return parseConversationDetailResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async listRuns(sessionId: string): Promise<RunListResource> {
    return parseRunListResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async getRun(runId: string): Promise<RunResource> {
    return parseRunResource(
      await request(
        this.#fetch,
        `/v1/runs/${encodeURIComponent(runId)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async listWorkspaceVersions(sessionId: string): Promise<WorkspaceVersionListResource> {
    return parseWorkspaceVersionListResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace-versions`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async getWorkspaceVersion(versionId: string): Promise<WorkspaceVersionResource> {
    return parseWorkspaceVersionResource(
      await request(
        this.#fetch,
        `/v1/workspace-versions/${encodeURIComponent(versionId)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async listWorkspaceFiles(versionId: string, cursor?: string): Promise<WorkspaceFileListResource> {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return parseWorkspaceFileListResource(
      await request(
        this.#fetch,
        `/v1/workspace-versions/${encodeURIComponent(versionId)}/files${query}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  readWorkspaceFile(
    versionId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return requestBytes(
      this.#fetch,
      `/v1/workspace-versions/${encodeURIComponent(versionId)}/file?path=${encodeURIComponent(path)}`,
      this.#authorizationToken,
    );
  }

  async archiveSession(
    sessionId: string,
    archived: boolean,
    idempotencyKey: string,
  ): Promise<WorkspaceOperationResource> {
    const body = parseArchiveSessionRequest({ archived });
    return parseWorkspaceOperationResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
        jsonRequest(body, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async createProject(
    name: string,
    source: WorkspaceSourceRequest = { kind: "empty" },
  ): Promise<ProjectResource> {
    return parseProjectResource(
      await request(
        this.#fetch,
        "/v1/projects",
        jsonRequest({ name, source }),
        this.#authorizationToken,
      ),
    );
  }

  async createSession(
    projectId: string,
    workspaceId: string,
    title: string,
  ): Promise<SessionResource> {
    return parseSessionResource(
      await request(
        this.#fetch,
        `/v1/projects/${encodeURIComponent(projectId)}/sessions`,
        jsonRequest({ workspaceId, title }),
        this.#authorizationToken,
      ),
    );
  }

  async acceptTurn(
    sessionId: string,
    prompt: string,
    idempotencyKey: string,
    thinkingLevel?: TurnThinkingLevel,
  ): Promise<AcceptedTurnResource> {
    return parseAcceptedTurnResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        jsonRequest(
          {
            prompt,
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
          idempotencyKey,
        ),
        this.#authorizationToken,
      ),
    );
  }

  async cancelTurn(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    gracePeriodMs = 2_000,
  ): Promise<AcceptedTurnCancellationResource> {
    return parseAcceptedTurnCancellationResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancellations`,
        jsonRequest({ gracePeriodMs }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<TurnSteerResource> {
    return parseTurnSteerResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/steers`,
        jsonRequest({ text }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }
}

export function newIdempotencyKey(
  prefix: "turn" | "cancel" | "steer" | "archive" | "delete" | "retry",
): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}
