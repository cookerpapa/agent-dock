import {
  parseInternalServiceError,
  parseControlToSupervisorMessage,
  parseSupervisorManagementResponse,
  type SupervisorManagementRequest,
  type SupervisorRuntimeAssignment,
  type SteerTurnCommandMessage,
} from "@pi-cloud/protocol";
import {
  SandboxAssignmentInventoryError,
  type SandboxAssignmentInventory,
  type SandboxRuntimeAssignment,
} from "@pi-cloud/sandbox-supervisor/sandbox-assignment-inventory";
import type {
  SupervisorBootIdentity,
  SupervisorOwnerBoundary,
} from "./supervisor-connection-manager.ts";
import type { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import {
  TurnSteerBackendError,
  type TurnSteerBackend,
  type TurnSteerRequest,
} from "./turn-steer.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MANAGEMENT_PATH = "/internal/v1/supervisor/manage";
const DEFAULT_ARTIFACT_READ_PATH = "/internal/v1/artifacts/read";

export type HttpSupervisorManagementClientOptions = {
  baseUrl: string;
  managementToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  idGenerator?: () => string;
};

export type SupervisorManagementClientResolver = (
  identity: SupervisorBootIdentity,
) => Promise<HttpSupervisorManagementClient>;

export class HttpSupervisorManagementError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "HttpSupervisorManagementError";
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

function baseUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Supervisor management base URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP Supervisor management requires explicit opt-in");
  }
  return parsed.toString();
}

function boundedToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("managementToken must contain 32-4096 bounded ASCII bytes");
  }
  return value;
}

function protocolAssignment(value: SandboxRuntimeAssignment): SupervisorRuntimeAssignment {
  return {
    containerId: value.runtimeId,
    containerName: value.runtimeName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    commandId: value.commandId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
  };
}

function runtimeAssignment(value: SupervisorRuntimeAssignment): SandboxRuntimeAssignment {
  return {
    runtimeId: value.containerId,
    runtimeName: value.containerName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    commandId: value.commandId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
  };
}

export class HttpSupervisorManagementClient {
  readonly #url: string;
  readonly #artifactUrl: string;
  readonly #authorization: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #idGenerator: () => string;

  constructor(options: HttpSupervisorManagementClientOptions) {
    const root = baseUrl(options.baseUrl, options.allowInsecureHttp === true);
    this.#url = new URL(DEFAULT_MANAGEMENT_PATH, root).toString();
    this.#artifactUrl = new URL(DEFAULT_ARTIFACT_READ_PATH, root).toString();
    this.#authorization = `Bearer ${boundedToken(options.managementToken)}`;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  requestId(): string {
    return this.#idGenerator();
  }

  async request(message: SupervisorManagementRequest) {
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
        body: JSON.stringify(message),
      });
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_unavailable",
        "Supervisor management service is unavailable",
        true,
      );
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_invalid_response",
        "Supervisor management returned an invalid response",
        false,
      );
    }
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(body).error;
        throw new HttpSupervisorManagementError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof HttpSupervisorManagementError) throw error;
        throw new HttpSupervisorManagementError(
          "supervisor_management_rejected",
          "Supervisor management rejected the request",
          response.status >= 500,
        );
      }
    }
    try {
      return parseSupervisorManagementResponse(body);
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_invalid_response",
        "Supervisor management returned an invalid response",
        false,
      );
    }
  }

  async readArtifact(objectKey: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.#fetch(this.#artifactUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectKey }),
      });
    } catch {
      throw new HttpSupervisorManagementError(
        "artifact_store_unavailable",
        "Trusted artifact transport is unavailable",
        true,
      );
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new HttpSupervisorManagementError(
          "artifact_transport_invalid_response",
          "Trusted artifact transport returned an invalid response",
          false,
        );
      }
      try {
        const failure = parseInternalServiceError(body).error;
        throw new HttpSupervisorManagementError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof HttpSupervisorManagementError) throw error;
        throw new HttpSupervisorManagementError(
          "artifact_transport_rejected",
          "Trusted artifact transport rejected the request",
          response.status >= 500,
        );
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 16 * 1024 * 1024) {
      throw new HttpSupervisorManagementError(
        "artifact_too_large",
        "Trusted artifact transport exceeded its byte limit",
        false,
      );
    }
    return bytes;
  }

  async steer(command: SteerTurnCommandMessage): Promise<void> {
    const requestId = this.requestId();
    let response;
    try {
      response = await this.request({
        protocolVersion: 1,
        type: "turn.steer",
        requestId,
        command,
      });
    } catch (first: unknown) {
      if (!(first instanceof HttpSupervisorManagementError) || !first.retryable) throw first;
      // The Worker deduplicates by commandId, so retrying the same command is
      // safe even when the first HTTP response was lost after delivery.
      response = await this.request({
        protocolVersion: 1,
        type: "turn.steer",
        requestId,
        command,
      }).catch(() => {
        throw new TurnSteerBackendError(
          "supervisor_management_unavailable",
          "Steer delivery outcome is temporarily unknown",
          false,
          true,
        );
      });
    }
    if (
      response.type !== "turn.steered" ||
      response.requestId !== requestId ||
      response.commandId !== command.payload.commandId
    ) {
      throw new TurnSteerBackendError(
        "backend_protocol_violation",
        "Supervisor steer response did not match",
        false,
        true,
      );
    }
  }
}

export class HttpSupervisorSteerBackend implements TurnSteerBackend {
  readonly #client: HttpSupervisorManagementClient;
  readonly #leaseCoordinator: SessionLeaseCoordinator;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: {
    client: HttpSupervisorManagementClient;
    leaseCoordinator: SessionLeaseCoordinator;
    idGenerator?: () => string;
    clock?: () => Date;
  }) {
    this.#client = options.client;
    this.#leaseCoordinator = options.leaseCoordinator;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
  }

  async steer(request: TurnSteerRequest): Promise<void> {
    const lease = await this.#leaseCoordinator.currentAssignment(request.target);
    const sentAt = this.#clock();
    if (Number.isNaN(sentAt.valueOf())) throw new TypeError("steer clock returned an invalid date");
    const command = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: sentAt.toISOString(),
      type: "command.turn.steer",
      payload: {
        commandId: request.commandId,
        targetCommandId: request.target.commandId,
        idempotencyKey: request.idempotencyKey,
        tenantId: request.target.tenantId,
        projectId: request.target.projectId,
        workspaceId: request.target.workspaceId,
        sessionId: request.target.sessionId,
        runId: request.target.runId,
        turnId: request.target.turnId,
        attemptId: request.target.attemptId,
        agentId: "root",
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        text: request.text,
      },
    });
    if (command.type !== "command.turn.steer") {
      throw new TurnSteerBackendError(
        "backend_protocol_violation",
        "Constructed supervisor steer command was invalid",
        false,
      );
    }
    try {
      await this.#client.steer(command);
    } catch (error: unknown) {
      if (error instanceof TurnSteerBackendError) throw error;
      if (error instanceof HttpSupervisorManagementError) {
        throw new TurnSteerBackendError(error.code, error.message, error.retryable);
      }
      throw new TurnSteerBackendError(
        "supervisor_management_unavailable",
        "Supervisor steer delivery failed",
        true,
      );
    }
  }
}

export class HttpSupervisorOwnerBoundary implements SupervisorOwnerBoundary {
  readonly #client: HttpSupervisorManagementClient;

  constructor(client: HttpSupervisorManagementClient) {
    this.#client = client;
  }

  async stopAndConfirm(identity: SupervisorBootIdentity): Promise<void> {
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "owner.stop_and_confirm",
      requestId,
      identity,
    });
    if (
      response.type !== "owner.stopped" ||
      response.requestId !== requestId ||
      response.identity.supervisorId !== identity.supervisorId ||
      response.identity.bootId !== identity.bootId ||
      response.identity.sandboxId !== identity.sandboxId
    ) {
      throw new HttpSupervisorManagementError(
        "owner_stop_response_mismatch",
        "Supervisor owner-stop proof did not match",
        false,
      );
    }
  }
}

export class RoutedHttpSupervisorOwnerBoundary implements SupervisorOwnerBoundary {
  readonly #resolveClient: SupervisorManagementClientResolver;

  constructor(resolveClient: SupervisorManagementClientResolver) {
    this.#resolveClient = resolveClient;
  }

  async stopAndConfirm(identity: SupervisorBootIdentity): Promise<void> {
    await new HttpSupervisorOwnerBoundary(await this.#resolveClient(identity)).stopAndConfirm(
      identity,
    );
  }
}

export class HttpSandboxAssignmentInventory implements SandboxAssignmentInventory {
  readonly #client: HttpSupervisorManagementClient;
  readonly #sandboxId: string;

  constructor(client: HttpSupervisorManagementClient, sandboxId: string) {
    this.#client = client;
    this.#sandboxId = sandboxId;
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "assignments.list",
      requestId,
      sandboxId: this.#sandboxId,
    });
    if (
      response.type !== "assignments.listed" ||
      response.requestId !== requestId ||
      response.sandboxId !== this.#sandboxId
    ) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_response_mismatch",
        "Remote assignment inventory response did not match",
        false,
      );
    }
    return response.assignments.map(runtimeAssignment);
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    if (assignment.sandboxId !== this.#sandboxId) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_scope_mismatch",
        "Remote assignment escaped its inventory scope",
        false,
      );
    }
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "assignment.terminate_and_confirm",
      requestId,
      sandboxId: this.#sandboxId,
      assignment: protocolAssignment(assignment),
    });
    if (
      response.type !== "assignment.absent" ||
      response.requestId !== requestId ||
      response.sandboxId !== this.#sandboxId ||
      response.containerId !== assignment.runtimeId
    ) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_response_mismatch",
        "Remote assignment absence proof did not match",
        false,
      );
    }
  }
}

export class RoutedHttpSandboxAssignmentInventory implements SandboxAssignmentInventory {
  readonly #identity: SupervisorBootIdentity;
  readonly #resolveClient: SupervisorManagementClientResolver;

  constructor(resolveClient: SupervisorManagementClientResolver, identity: SupervisorBootIdentity) {
    this.#resolveClient = resolveClient;
    this.#identity = identity;
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    return new HttpSandboxAssignmentInventory(
      await this.#resolveClient(this.#identity),
      this.#identity.sandboxId,
    ).listAssignments();
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    await new HttpSandboxAssignmentInventory(
      await this.#resolveClient(this.#identity),
      this.#identity.sandboxId,
    ).terminateAndConfirmAbsent(assignment);
  }
}
