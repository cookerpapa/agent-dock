import {
  parseSandboxManagerRequest,
  parseSupervisorManagementRequest,
  parseToolSandboxOperationRequest,
  type InternalServiceError,
  type SupervisorManagementResponse,
} from "@agent-dock/protocol";
import { parseTraceCarrier, withSpan, type AgentDockMetrics } from "@agent-dock/observability";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  SANDBOX_MANAGER_INVENTORY_PATH,
  SANDBOX_MANAGER_LIVE_PATH,
  SANDBOX_MANAGER_OPERATION_PATH,
  SANDBOX_MANAGER_READY_PATH,
  SANDBOX_MANAGER_SERVICE_PATH,
} from "./client.ts";
import { SandboxManagerError } from "./sandbox-provider.ts";
import type { ToolSandboxManager } from "./tool-sandbox-manager.ts";

const DEFAULT_BODY_LIMIT = 5 * 1_024 * 1_024;

export type SandboxManagerServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  manager: SandboxManagerBackend;
  bodyLimit?: number;
  metrics?: AgentDockMetrics;
};

export type SandboxManagerBackend = Pick<
  ToolSandboxManager,
  | "checkHealth"
  | "create"
  | "capture"
  | "stop"
  | "execute"
  | "importGitHub"
  | "listAssignments"
  | "terminateAndConfirmAbsent"
  | "confirmAbsent"
  | "close"
>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validServiceToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("Sandbox Manager service token is invalid");
  }
  return value;
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function safeFailure(error: unknown): SandboxManagerError {
  if (error instanceof SandboxManagerError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /ProtocolError$/.test(error.name)
  ) {
    return new SandboxManagerError(
      "sandbox_manager_protocol_error",
      "Sandbox Manager request failed validation",
      false,
    );
  }
  return new SandboxManagerError(
    "sandbox_manager_failed",
    "Sandbox Manager operation failed",
    true,
  );
}

export class SandboxManagerServer {
  readonly #host: string;
  readonly #port: number;
  readonly #serviceDigest: Buffer;
  readonly #manager: SandboxManagerBackend;
  readonly #server: FastifyInstance;
  readonly #metrics: AgentDockMetrics | undefined;
  #address: string | undefined;
  #ready = false;

  constructor(options: SandboxManagerServerOptions) {
    if (options.host.trim().length === 0) throw new TypeError("host must not be empty");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("port must be an integer between 0 and 65535");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#serviceDigest = digest(validServiceToken(options.serviceToken));
    this.#manager = options.manager;
    this.#metrics = options.metrics;
    this.#server = Fastify({
      logger: false,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      requestTimeout: 320_000,
      keepAliveTimeout: 5_000,
    });
    this.#installRoutes();
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    if (this.#address !== undefined) throw new Error("Sandbox Manager is already listening");
    await this.#manager.checkHealth();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    this.#ready = true;
    return this.#address;
  }

  async close(): Promise<void> {
    this.#ready = false;
    await this.#manager.close();
    if (this.#address !== undefined) {
      this.#address = undefined;
      await this.#server.close();
    }
  }

  #authorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return token !== undefined && timingSafeEqual(this.#serviceDigest, candidate);
  }

  async #failure(reply: FastifyReply, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    await reply.code(failure.retryable ? 503 : 409).send({
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    } satisfies InternalServiceError);
  }

  #observed<T>(options: {
    request: FastifyRequest;
    spanName: string;
    operation: string;
    kind: "sandbox" | "tool";
    run: () => Promise<T>;
  }): Promise<T> {
    const parent = parseTraceCarrier({
      traceparent: options.request.headers.traceparent,
      tracestate: options.request.headers.tracestate,
    });
    const startedAt = performance.now();
    return withSpan({
      serviceName: "agent-dock-sandbox-manager",
      name: options.spanName,
      ...(parent === undefined ? {} : { parent }),
      attributes: { "agent_dock.sandbox.operation": options.operation },
      run: async () => {
        try {
          const result = await options.run();
          const duration = (performance.now() - startedAt) / 1_000;
          if (options.kind === "sandbox") {
            this.#metrics?.sandboxDuration.observe(
              { operation: options.operation, outcome: "completed" },
              duration,
            );
          } else {
            this.#metrics?.toolDuration.observe(
              { tool: options.operation, outcome: "completed" },
              duration,
            );
          }
          return result;
        } catch (error: unknown) {
          const duration = (performance.now() - startedAt) / 1_000;
          if (options.kind === "sandbox") {
            this.#metrics?.sandboxDuration.observe(
              { operation: options.operation, outcome: "failed" },
              duration,
            );
          } else {
            this.#metrics?.toolDuration.observe(
              { tool: options.operation, outcome: "failed" },
              duration,
            );
          }
          throw error;
        }
      },
    });
  }

  #installRoutes(): void {
    this.#server.get(SANDBOX_MANAGER_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get(SANDBOX_MANAGER_READY_PATH, async (_request, reply) => {
      await reply.code(this.#ready ? 200 : 503).send({
        status: this.#ready ? "ready" : "not_ready",
      });
    });

    this.#server.post(SANDBOX_MANAGER_SERVICE_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_sandbox_manager_credential",
            message: "Sandbox Manager request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSandboxManagerRequest(request.body);
        if (message.type === "tool_sandbox.create") {
          const created = await this.#observed({
            request,
            spanName: "sandbox.create",
            operation: "create",
            kind: "sandbox",
            run: () => this.#manager.create(message),
          });
          this.#metrics?.sandboxActive.inc({ provider: "docker" });
          await reply.code(200).send(created);
          return;
        }
        if (message.type === "tool_sandbox.capture") {
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "sandbox.capture",
              operation: "capture",
              kind: "sandbox",
              run: () =>
                this.#manager.capture(message.activationId, message.assignment, message.requestId),
            }),
          );
          return;
        }
        if (message.type === "tool_sandbox.stop") {
          await this.#observed({
            request,
            spanName: "sandbox.stop",
            operation: "stop",
            kind: "sandbox",
            run: () => this.#manager.stop(message.activationId, message.assignment),
          });
          this.#metrics?.sandboxActive.dec({ provider: "docker" });
          await reply.code(200).send({
            managerProtocolVersion: 1,
            type: "tool_sandbox.stopped",
            requestId: message.requestId,
            activationId: message.activationId,
          });
          return;
        }
        const controller = new AbortController();
        request.raw.once("aborted", () => controller.abort());
        const snapshot = await this.#observed({
          request,
          spanName: "sandbox.import_github",
          operation: "import_github",
          kind: "sandbox",
          run: () => this.#manager.importGitHub(message.source, controller.signal),
        });
        const { encodeWorkspaceSnapshotBlob } = await import("@agent-dock/workspace-runtime");
        await reply.code(200).send({
          managerProtocolVersion: 1,
          type: "workspace.github_imported",
          requestId: message.requestId,
          snapshot: encodeWorkspaceSnapshotBlob(snapshot),
        });
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(SANDBOX_MANAGER_OPERATION_PATH, async (request, reply) => {
      const capability = bearer(request.headers.authorization);
      if (capability === undefined || !/^adts_[A-Za-z0-9_-]{43}$/.test(capability)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_capability",
            message: "Tool Sandbox operation is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      try {
        const message = parseToolSandboxOperationRequest(request.body);
        const response = await this.#observed({
          request,
          spanName: `tool.${message.operation}`,
          operation: message.operation,
          kind: "tool",
          run: () => this.#manager.execute(capability, message, controller.signal),
        });
        await reply.code(200).send(response);
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(SANDBOX_MANAGER_INVENTORY_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_sandbox_manager_credential",
            message: "Sandbox inventory request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSupervisorManagementRequest(request.body);
        let response: SupervisorManagementResponse;
        if (message.type === "assignments.list") {
          response = {
            protocolVersion: 1,
            type: "assignments.listed",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            assignments: [...(await this.#manager.listAssignments(message.sandboxId))],
          };
        } else if (message.type === "assignment.terminate_and_confirm") {
          await this.#manager.terminateAndConfirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else if (message.type === "assignment.confirm_absent") {
          await this.#manager.confirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else {
          throw new SandboxManagerError(
            "unsupported_sandbox_manager_operation",
            "Sandbox Manager does not own the Runner process",
            false,
          );
        }
        await reply.code(200).send(response);
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });
  }
}
