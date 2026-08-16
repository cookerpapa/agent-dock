import {
  parseInternalServiceError,
  parseToolBrokerMaterializeFileResponse,
  parseToolBrokerResponse,
  parseSupervisorManagementResponse,
  parseToolSandboxOperationResponse,
  type GitHubRepositorySource,
  type ToolBrokerRequest,
  type ToolBrokerResponse,
  type ToolBrokerMaterializeFileRequest,
  type ToolBrokerMaterializeFileResponse,
  type SupervisorManagementRequest,
  type SupervisorManagementResponse,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolSandboxReleaseResponse,
} from "@pi-cloud/protocol";
import { decodeWorkspaceSnapshotBlob } from "@pi-cloud/workspace-runtime";
import { activeTraceCarrier } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";

export const TOOL_BROKER_SERVICE_PATH = "/internal/v1/tool-broker";
export const TOOL_BROKER_OPERATION_PATH = "/internal/v1/tool-operation";
export const TOOL_BROKER_INVENTORY_PATH = "/internal/v1/sandbox-inventory";
export const TOOL_BROKER_MATERIALIZER_PATH = "/internal/v1/workspace-materializer";
export const TOOL_BROKER_LIVE_PATH = "/health/live";
export const TOOL_BROKER_READY_PATH = "/health/ready";

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export class ToolBrokerClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "ToolBrokerClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ToolBrokerClientOptions = {
  baseUrl: string;
  serviceToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  idGenerator?: () => string;
};

function baseUrl(value: string, allowInsecure: boolean): URL {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (parsed.protocol === "http:" && !allowInsecure)
  ) {
    throw new TypeError("Tool Broker base URL is invalid");
  }
  return parsed;
}

function token(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("Tool Broker service token is invalid");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 900_000) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ToolBrokerClientError(
      "tool_broker_protocol_error",
      "Tool Broker response was outside its byte limit",
      false,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ToolBrokerClientError(
      "tool_broker_protocol_error",
      "Tool Broker returned malformed JSON",
      false,
    );
  }
}

export class ToolBrokerClient {
  readonly #baseUrl: URL;
  readonly #serviceToken: string;
  readonly #allowInsecureHttp: boolean;
  readonly #requestTimeoutMs: number;
  readonly #idGenerator: () => string;

  constructor(options: ToolBrokerClientOptions) {
    this.#baseUrl = baseUrl(options.baseUrl, options.allowInsecureHttp ?? false);
    this.#serviceToken = token(options.serviceToken);
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 300_000,
      "requestTimeoutMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  get operationUrl(): string {
    return new URL(TOOL_BROKER_OPERATION_PATH, this.#baseUrl).toString();
  }

  operationUrlFor(_activationId: string): string {
    return this.operationUrl;
  }

  async checkHealth(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(new URL(TOOL_BROKER_READY_PATH, this.#baseUrl), {
        signal: AbortSignal.timeout(Math.min(this.#requestTimeoutMs, 10_000)),
      });
    } catch {
      throw new ToolBrokerClientError(
        "tool_broker_unavailable",
        "Tool Broker is unavailable",
        true,
      );
    }
    if (!response.ok) {
      throw new ToolBrokerClientError("tool_broker_unavailable", "Tool Broker is not ready", true);
    }
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    return this.#create(request, new Set());
  }

  async #create(
    request: ToolSandboxCreateRequest,
    visited: Set<string>,
  ): Promise<ToolSandboxCreateResponse> {
    const current = this.#baseUrl.toString();
    if (visited.has(current) || visited.size >= 3) {
      throw new ToolBrokerClientError(
        "tool_broker_redirect_loop",
        "Tool Broker owner redirect did not converge",
        false,
      );
    }
    visited.add(current);
    const response = await this.#service(request);
    if (response.type === "tool_sandbox.owner_redirect") {
      const owner = new ToolBrokerClient({
        baseUrl: response.ownerBaseUrl,
        serviceToken: this.#serviceToken,
        allowInsecureHttp: this.#allowInsecureHttp,
        requestTimeoutMs: this.#requestTimeoutMs,
        idGenerator: this.#idGenerator,
      });
      return owner.#create(request, visited);
    }
    if (response.type !== "tool_sandbox.reserved" || response.requestId !== request.requestId) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Tool Broker create response did not match",
        false,
      );
    }
    return response;
  }

  async capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse> {
    const requestId = this.#idGenerator();
    const response = await this.#service({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.capture",
      requestId,
      activationId,
      assignment,
    });
    if (
      (response.type !== "tool_sandbox.captured" && response.type !== "tool_sandbox.unused") ||
      response.requestId !== requestId ||
      response.activationId !== activationId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Tool Broker capture response did not match",
        false,
      );
    }
    return response;
  }

  async release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition:
      | { kind: "keep_warm"; workspaceRevision: string }
      | { kind: "keep_persistent"; workspaceRevision: string }
      | { kind: "destroy" },
  ): Promise<ToolSandboxReleaseResponse> {
    const requestId = this.#idGenerator();
    const response = await this.#service(
      disposition.kind !== "destroy"
        ? {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId,
            activationId,
            assignment,
            disposition: disposition.kind,
            workspaceRevision: disposition.workspaceRevision,
          }
        : {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId,
            activationId,
            assignment,
            disposition: "destroy",
          },
    );
    if (
      response.type !== "tool_sandbox.released" ||
      response.requestId !== requestId ||
      response.activationId !== activationId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Tool Broker release response did not match",
        false,
      );
    }
    return response;
  }

  async stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const requestId = this.#idGenerator();
    const response = await this.#service({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.stop",
      requestId,
      activationId,
      assignment,
    });
    if (
      response.type !== "tool_sandbox.stopped" ||
      response.requestId !== requestId ||
      response.activationId !== activationId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Tool Broker stop response did not match",
        false,
      );
    }
  }

  async operation(
    capability: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const response = await this.#post(TOOL_BROKER_OPERATION_PATH, capability, request, signal);
    const parsed = parseToolSandboxOperationResponse(response);
    if (
      parsed.activationId !== request.activationId ||
      parsed.operationId !== request.operationId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Tool operation response identity did not match",
        false,
      );
    }
    return parsed;
  }

  async importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    const requestId = this.#idGenerator();
    const response = await this.#service(
      {
        toolBrokerProtocolVersion: 1,
        type: "workspace.github_import",
        requestId,
        source,
      },
      signal,
    );
    if (response.type !== "workspace.github_imported" || response.requestId !== requestId) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Repository import response did not match",
        false,
      );
    }
    try {
      return decodeWorkspaceSnapshotBlob(response.snapshot);
    } catch {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Repository import snapshot envelope did not match",
        false,
      );
    }
  }

  async materializeFile(
    request: ToolBrokerMaterializeFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerMaterializeFileResponse> {
    const response = parseToolBrokerMaterializeFileResponse(
      await this.#post(TOOL_BROKER_MATERIALIZER_PATH, this.#serviceToken, request, signal),
    );
    if (
      response.requestId !== request.requestId ||
      response.tenantId !== request.tenantId ||
      response.workspaceId !== request.workspaceId ||
      response.path !== request.path
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Workspace materialization response identity did not match",
        false,
      );
    }
    return response;
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const requestId = this.#idGenerator();
    const response = await this.#inventory({
      protocolVersion: 1,
      type: "assignments.list",
      requestId,
      sandboxId,
    });
    if (
      response.type !== "assignments.listed" ||
      response.requestId !== requestId ||
      response.sandboxId !== sandboxId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Sandbox inventory response did not match",
        false,
      );
    }
    return response.assignments;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#assignmentMutation("assignment.terminate_and_confirm", assignment);
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#assignmentMutation("assignment.confirm_absent", assignment);
  }

  async #assignmentMutation(
    type: "assignment.terminate_and_confirm" | "assignment.confirm_absent",
    assignment: SupervisorRuntimeAssignment,
  ): Promise<void> {
    const requestId = this.#idGenerator();
    const response = await this.#inventory({
      protocolVersion: 1,
      type,
      requestId,
      sandboxId: assignment.sandboxId,
      assignment,
    });
    if (
      response.type !== "assignment.absent" ||
      response.requestId !== requestId ||
      response.sandboxId !== assignment.sandboxId ||
      response.containerId !== assignment.containerId
    ) {
      throw new ToolBrokerClientError(
        "tool_broker_protocol_error",
        "Sandbox inventory mutation response did not match",
        false,
      );
    }
  }

  async #service(request: ToolBrokerRequest, signal?: AbortSignal): Promise<ToolBrokerResponse> {
    return parseToolBrokerResponse(
      await this.#post(TOOL_BROKER_SERVICE_PATH, this.#serviceToken, request, signal),
    );
  }

  async #inventory(request: SupervisorManagementRequest): Promise<SupervisorManagementResponse> {
    return parseSupervisorManagementResponse(
      await this.#post(TOOL_BROKER_INVENTORY_PATH, this.#serviceToken, request),
    );
  }

  async #post(path: string, bearer: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const combinedSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      const trace = activeTraceCarrier();
      response = await fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          ...(trace === undefined ? {} : { traceparent: trace.traceparent }),
          ...(trace?.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch {
      throw new ToolBrokerClientError(
        "tool_broker_unavailable",
        "Tool Broker request failed",
        true,
      );
    }
    const value = await boundedJson(response);
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(value).error;
        throw new ToolBrokerClientError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof ToolBrokerClientError) throw error;
        throw new ToolBrokerClientError(
          "tool_broker_protocol_error",
          "Tool Broker returned an invalid failure",
          false,
        );
      }
    }
    return value;
  }
}

export type ReplicatedToolBrokerClientOptions = Omit<ToolBrokerClientOptions, "baseUrl"> & {
  baseUrls: readonly string[];
};

/**
 * Balances new reservations across Sandbox-Domain Tool Broker replicas. The durable
 * owner returned by create controls the complete activation. Follow-up Tool
 * calls never fail over to another replica because doing so could replay an
 * ambiguous side effect. A warm owner can redirect a later create request back
 * to itself through the PostgreSQL activation directory.
 */
export class ReplicatedToolBrokerClient {
  readonly #clients: readonly ToolBrokerClient[];
  readonly #ownerClients = new Map<string, ToolBrokerClient>();
  readonly #activationOwners = new Map<string, ToolBrokerClient>();
  readonly #serviceToken: string;
  readonly #allowInsecureHttp: boolean;
  readonly #requestTimeoutMs: number;
  readonly #idGenerator: () => string;
  #nextClient = 0;

  constructor(options: ReplicatedToolBrokerClientOptions) {
    if (options.baseUrls.length < 1 || options.baseUrls.length > 256) {
      throw new TypeError("Tool Broker replica URL list must contain 1-256 entries");
    }
    if (new Set(options.baseUrls).size !== options.baseUrls.length) {
      throw new TypeError("Tool Broker replica URLs must be unique");
    }
    this.#serviceToken = token(options.serviceToken);
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 300_000,
      "requestTimeoutMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clients = options.baseUrls.map((replicaUrl) => {
      const client = new ToolBrokerClient({ ...options, baseUrl: replicaUrl });
      this.#ownerClients.set(new URL(replicaUrl).toString(), client);
      return client;
    });
  }

  operationUrlFor(activationId: string): string {
    return this.#ownedClient(activationId).operationUrlFor(activationId);
  }

  async checkHealth(): Promise<void> {
    const results = await Promise.allSettled(this.#clients.map((client) => client.checkHealth()));
    if (results.some((result) => result.status === "fulfilled")) return;
    const failure = results[0];
    if (failure?.status === "rejected" && failure.reason instanceof Error) throw failure.reason;
    throw new ToolBrokerClientError(
      "tool_broker_unavailable",
      "Tool Broker replica set is unavailable",
      true,
    );
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    const client = this.#clients[this.#nextClient % this.#clients.length]!;
    this.#nextClient += 1;
    const response = await client.create(request);
    this.#activationOwners.set(response.activationId, this.#ownerClient(response.ownerBaseUrl));
    return response;
  }

  capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse> {
    return this.#ownedClient(activationId).capture(activationId, assignment);
  }

  async release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition:
      | { kind: "keep_warm"; workspaceRevision: string }
      | { kind: "keep_persistent"; workspaceRevision: string }
      | { kind: "destroy" },
  ): Promise<ToolSandboxReleaseResponse> {
    try {
      return await this.#ownedClient(activationId).release(activationId, assignment, disposition);
    } finally {
      this.#activationOwners.delete(activationId);
    }
  }

  async stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    try {
      await this.#ownedClient(activationId).stop(activationId, assignment);
    } finally {
      this.#activationOwners.delete(activationId);
    }
  }

  operation(
    capability: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    return this.#ownedClient(request.activationId).operation(capability, request, signal);
  }

  importGitHub(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    return this.#nextReplica().importGitHub(source, signal);
  }

  materializeFile(
    request: ToolBrokerMaterializeFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerMaterializeFileResponse> {
    return this.#nextReplica().materializeFile(request, signal);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const assignments = await Promise.all(
      this.#clients.map((client) => client.listAssignments(sandboxId)),
    );
    const unique = new Map<string, SupervisorRuntimeAssignment>();
    for (const assignment of assignments.flat()) {
      unique.set(`${assignment.containerId}\0${assignment.fencingToken}`, assignment);
    }
    return [...unique.values()];
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#allReplicas((client) => client.terminateAndConfirmAbsent(assignment));
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#allReplicas((client) => client.confirmAbsent(assignment));
  }

  #ownedClient(activationId: string): ToolBrokerClient {
    const client = this.#activationOwners.get(activationId);
    if (client !== undefined) return client;
    throw new ToolBrokerClientError(
      "tool_broker_owner_unknown",
      "Tool Sandbox activation owner is unavailable",
      false,
    );
  }

  #ownerClient(ownerBaseUrl: string): ToolBrokerClient {
    const key = new URL(ownerBaseUrl).toString();
    const existing = this.#ownerClients.get(key);
    if (existing !== undefined) return existing;
    const client = new ToolBrokerClient({
      baseUrl: key,
      serviceToken: this.#serviceToken,
      allowInsecureHttp: this.#allowInsecureHttp,
      requestTimeoutMs: this.#requestTimeoutMs,
      idGenerator: this.#idGenerator,
    });
    this.#ownerClients.set(key, client);
    return client;
  }

  #nextReplica(): ToolBrokerClient {
    const client = this.#clients[this.#nextClient % this.#clients.length]!;
    this.#nextClient += 1;
    return client;
  }

  async #allReplicas(operation: (client: ToolBrokerClient) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.#clients.map(operation));
    if (results.some((result) => result.status === "fulfilled")) return;
    const first = results[0];
    if (first?.status === "rejected") throw first.reason;
    throw new ToolBrokerClientError(
      "tool_broker_unavailable",
      "Tool Broker replica operation failed",
      true,
    );
  }
}
