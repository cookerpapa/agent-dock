import {
  parseSupervisorManagementRequest,
  type InternalServiceError,
  type SupervisorManagementResponse,
  type SupervisorRuntimeAssignment,
} from "@agent-dock/protocol";
import {
  DockerSandboxAssignmentInventory,
  SandboxAssignmentInventoryError,
  type SandboxRuntimeAssignment,
} from "@agent-dock/sandbox-supervisor";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  SupervisorBootLedger,
  SupervisorBootLedgerError,
  type SupervisorHostBootIdentity,
} from "./boot-ledger.ts";

export const SUPERVISOR_MANAGEMENT_PATH = "/internal/v1/supervisor/manage";
export const SUPERVISOR_HOST_LIVE_PATH = "/health/live";
export const SUPERVISOR_HOST_READY_PATH = "/health/ready";

const DEFAULT_BODY_LIMIT = 64 * 1_024;

export type SupervisorManagementServerOptions = {
  host: string;
  port: number;
  managementToken: string;
  identity: SupervisorHostBootIdentity;
  bootLedger: SupervisorBootLedger;
  stopCurrentBoot: () => Promise<void>;
  readiness: () => boolean;
  dockerCommand?: string;
  inventoryTimeoutMs?: number;
  bodyLimit?: number;
};

export class SupervisorManagementServerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorManagementServerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

function boundedToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("managementToken must contain 32-4096 bounded ASCII bytes");
  }
  return value;
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function toProtocolAssignment(value: SandboxRuntimeAssignment): SupervisorRuntimeAssignment {
  return {
    containerId: value.runtimeId,
    containerName: value.runtimeName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    commandId: value.commandId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
  };
}

function fromProtocolAssignment(value: SupervisorRuntimeAssignment): SandboxRuntimeAssignment {
  return {
    runtimeId: value.containerId,
    runtimeName: value.containerName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    commandId: value.commandId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
  };
}

function safeFailure(error: unknown): SupervisorManagementServerError {
  if (error instanceof SupervisorManagementServerError) return error;
  if (error instanceof SupervisorBootLedgerError) {
    return new SupervisorManagementServerError(error.code, error.message, false);
  }
  if (error instanceof SandboxAssignmentInventoryError) {
    return new SupervisorManagementServerError(error.code, error.message, error.retryable);
  }
  return new SupervisorManagementServerError(
    "supervisor_management_failed",
    "Supervisor management operation failed",
    true,
  );
}

export class SupervisorManagementServer {
  readonly #server: FastifyInstance;
  readonly #host: string;
  readonly #port: number;
  readonly #managementDigest: Buffer;
  readonly #identity: SupervisorHostBootIdentity;
  readonly #bootLedger: SupervisorBootLedger;
  readonly #stopCurrentBoot: () => Promise<void>;
  readonly #readiness: () => boolean;
  readonly #dockerCommand: string;
  readonly #inventoryTimeoutMs: number | undefined;
  #stopOperation: Promise<void> | undefined;
  #address: string | undefined;

  constructor(options: SupervisorManagementServerOptions) {
    if (options.host.trim().length === 0) throw new TypeError("host must not be empty");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("port must be an integer between 0 and 65535");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#managementDigest = digest(boundedToken(options.managementToken));
    this.#identity = { ...options.identity };
    this.#bootLedger = options.bootLedger;
    this.#stopCurrentBoot = options.stopCurrentBoot;
    this.#readiness = options.readiness;
    this.#dockerCommand = options.dockerCommand ?? "docker";
    this.#inventoryTimeoutMs = options.inventoryTimeoutMs;
    this.#server = Fastify({
      logger: false,
      bodyLimit: positiveInteger(options.bodyLimit ?? DEFAULT_BODY_LIMIT, "bodyLimit", 1024 * 1024),
      requestTimeout: 15_000,
      keepAliveTimeout: 5_000,
    });
    this.#installRoutes();
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    if (this.#address !== undefined) throw new Error("Management server is already listening");
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    return this.#address;
  }

  async close(): Promise<void> {
    if (this.#address === undefined) return;
    this.#address = undefined;
    await this.#server.close();
  }

  #installRoutes(): void {
    this.#server.get(SUPERVISOR_HOST_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get(SUPERVISOR_HOST_READY_PATH, async (_request, reply) => {
      const ready = this.#readiness();
      await reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
    });
    this.#server.post(SUPERVISOR_MANAGEMENT_PATH, async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
      if (token === undefined || !timingSafeEqual(this.#managementDigest, candidate)) {
        await reply.code(401).send({
          error: {
            code: "invalid_management_credential",
            message: "Supervisor management is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSupervisorManagementRequest(request.body);
        const response = await this.#handle(message);
        await reply.code(200).send(response);
      } catch (error: unknown) {
        const failure = safeFailure(error);
        await reply.code(failure.retryable ? 503 : 409).send({
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          },
        } satisfies InternalServiceError);
      }
    });
  }

  async #handle(
    message: ReturnType<typeof parseSupervisorManagementRequest>,
  ): Promise<SupervisorManagementResponse> {
    if (message.type === "owner.stop_and_confirm") {
      const current = await this.#bootLedger.current();
      if (
        current?.status === "active" &&
        current.bootId === message.identity.bootId &&
        current.sandboxId === message.identity.sandboxId
      ) {
        this.#stopOperation ??= this.#stopCurrentBoot();
        await this.#stopOperation;
      }
      await this.#bootLedger.markStopped(message.identity);
      return {
        protocolVersion: 1,
        type: "owner.stopped",
        requestId: message.requestId,
        identity: message.identity,
      };
    }

    const inventory = new DockerSandboxAssignmentInventory({
      sandboxId: message.sandboxId,
      dockerCommand: this.#dockerCommand,
      ...(this.#inventoryTimeoutMs === undefined ? {} : { timeoutMs: this.#inventoryTimeoutMs }),
    });
    if (message.type === "assignments.list") {
      return {
        protocolVersion: 1,
        type: "assignments.listed",
        requestId: message.requestId,
        sandboxId: message.sandboxId,
        assignments: (await inventory.listAssignments()).map(toProtocolAssignment),
      };
    }
    if (message.assignment.sandboxId !== message.sandboxId) {
      throw new SupervisorManagementServerError(
        "assignment_scope_mismatch",
        "Assignment escaped its management scope",
        false,
      );
    }
    const assignment = fromProtocolAssignment(message.assignment);
    if (message.type === "assignment.terminate_and_confirm") {
      await inventory.terminateAndConfirmAbsent(assignment);
    } else {
      const current = await inventory.inspectAssignment(assignment.runtimeId);
      if (current !== undefined) {
        throw new SupervisorManagementServerError(
          "docker_assignment_still_alive",
          "Docker sandbox absence could not be confirmed",
          false,
        );
      }
    }
    return {
      protocolVersion: 1,
      type: "assignment.absent",
      requestId: message.requestId,
      sandboxId: message.sandboxId,
      containerId: message.assignment.containerId,
    };
  }
}
