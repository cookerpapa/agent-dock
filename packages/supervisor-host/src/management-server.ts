import {
  parseSupervisorManagementRequest,
  type InternalServiceError,
  type SupervisorManagementResponse,
  type SupervisorRuntimeAssignment,
} from "@agent-dock/protocol";
import {
  validateCheckpointObjectKey,
  type CheckpointObjectStore,
} from "@agent-dock/runtime-core/checkpoint-runtime";
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
export const SUPERVISOR_ARTIFACT_READ_PATH = "/internal/v1/artifacts/read";

const DEFAULT_BODY_LIMIT = 64 * 1_024;

export type SupervisorManagementServerOptions = {
  host: string;
  port: number;
  managementToken: string;
  identity: SupervisorHostBootIdentity;
  bootLedger: SupervisorBootLedger;
  stopCurrentBoot: () => Promise<void>;
  readiness: () => boolean;
  assignmentInventory: SupervisorAssignmentInventory;
  artifactStore?: Pick<CheckpointObjectStore, "get">;
  bodyLimit?: number;
};

export interface SupervisorAssignmentInventory {
  listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]>;
  terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
  confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
}

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

function safeFailure(error: unknown): SupervisorManagementServerError {
  if (error instanceof SupervisorManagementServerError) return error;
  if (error instanceof SupervisorBootLedgerError) {
    return new SupervisorManagementServerError(error.code, error.message, false);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return new SupervisorManagementServerError(
      error.code,
      "Sandbox assignment inventory operation failed",
      error.retryable,
    );
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
  readonly #assignmentInventory: SupervisorAssignmentInventory;
  readonly #artifactStore: Pick<CheckpointObjectStore, "get"> | undefined;
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
    this.#assignmentInventory = options.assignmentInventory;
    this.#artifactStore = options.artifactStore;
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
    this.#server.post(SUPERVISOR_ARTIFACT_READ_PATH, async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
      if (token === undefined || !timingSafeEqual(this.#managementDigest, candidate)) {
        await reply.code(401).send({
          error: {
            code: "invalid_management_credential",
            message: "Artifact read is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        if (
          typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length !== 1 ||
          !("objectKey" in request.body) ||
          typeof request.body.objectKey !== "string"
        ) {
          throw new SupervisorManagementServerError(
            "artifact_request_invalid",
            "Artifact read request is invalid",
            false,
          );
        }
        if (this.#artifactStore === undefined) {
          throw new SupervisorManagementServerError(
            "artifact_store_unavailable",
            "Artifact store is unavailable",
            true,
          );
        }
        const objectKey = validateCheckpointObjectKey(request.body.objectKey);
        const bytes = await this.#artifactStore.get(objectKey);
        if (bytes.byteLength > 16 * 1024 * 1024) {
          throw new SupervisorManagementServerError(
            "artifact_too_large",
            "Artifact exceeds the trusted transport limit",
            false,
          );
        }
        await reply
          .header("cache-control", "private, no-store")
          .header("content-type", "application/octet-stream")
          .header("x-content-type-options", "nosniff")
          .code(200)
          .send(Buffer.from(bytes));
      } catch (error: unknown) {
        const result = safeFailure(error);
        await reply.code(result.retryable ? 503 : 409).send({
          error: { code: result.code, message: result.message, retryable: result.retryable },
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

    const generation = await this.#bootLedger.generationForSandbox(message.sandboxId);
    if (generation === null) {
      throw new SupervisorManagementServerError(
        "boot_generation_unknown",
        "Sandbox generation is not known to this host",
        false,
      );
    }

    if (message.type === "assignments.list") {
      return {
        protocolVersion: 1,
        type: "assignments.listed",
        requestId: message.requestId,
        sandboxId: message.sandboxId,
        assignments: [...(await this.#assignmentInventory.listAssignments(message.sandboxId))],
      };
    }
    if (message.assignment.sandboxId !== message.sandboxId) {
      throw new SupervisorManagementServerError(
        "assignment_scope_mismatch",
        "Assignment escaped its management scope",
        false,
      );
    }
    if (
      message.assignment.supervisorId !== this.#identity.supervisorId ||
      message.assignment.bootId !== generation.bootId
    ) {
      throw new SupervisorManagementServerError(
        "assignment_scope_mismatch",
        "Assignment escaped its boot ownership scope",
        false,
      );
    }
    if (message.type === "assignment.terminate_and_confirm") {
      await this.#assignmentInventory.terminateAndConfirmAbsent(message.assignment);
    } else {
      await this.#assignmentInventory.confirmAbsent(message.assignment);
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
