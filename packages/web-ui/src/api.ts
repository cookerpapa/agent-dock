import {
  parseAcceptedTurnCancellationResource,
  parseAcceptedTurnResource,
  parseControlPlaneApiError,
  parseProjectResource,
  parseSessionResource,
  type AcceptedTurnCancellationResource,
  type AcceptedTurnResource,
  type ProjectResource,
  type SessionResource,
  type TurnThinkingLevel,
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
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(path, init);
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

function jsonRequest(body: unknown, idempotencyKey?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

export class AgentDockApi {
  readonly #fetch: FetchImplementation;

  constructor(fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis)) {
    this.#fetch = fetchImplementation;
  }

  async createProject(name: string): Promise<ProjectResource> {
    return parseProjectResource(await request(this.#fetch, "/v1/projects", jsonRequest({ name })));
  }

  async createSession(project: ProjectResource): Promise<SessionResource> {
    return parseSessionResource(
      await request(
        this.#fetch,
        `/v1/projects/${encodeURIComponent(project.projectId)}/sessions`,
        jsonRequest({ workspaceId: project.workspaceId }),
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
      ),
    );
  }
}

export function newIdempotencyKey(prefix: "turn" | "cancel"): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}
