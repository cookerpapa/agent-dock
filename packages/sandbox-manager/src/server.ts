import {
  parseSandboxManagerRequest,
  parseSandboxManagerMaterializeFileRequest,
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
  SANDBOX_MANAGER_MATERIALIZER_PATH,
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
  materializerToken?: string;
  manager: SandboxManagerBackend;
  bodyLimit?: number;
  metrics?: AgentDockMetrics;
};

export type SandboxManagerBackend = Pick<
  ToolSandboxManager,
  | "checkHealth"
  | "create"
  | "capture"
  | "release"
  | "stop"
  | "execute"
  | "importGitHub"
  | "materializeFile"
  | "listAssignments"
  | "terminateAndConfirmAbsent"
  | "confirmAbsent"
  | "close"
  | "activeCount"
  | "admittedCount"
  | "admissionWaitingCount"
  | "maximumActiveSandboxes"
  | "cleanPrewarmCount"
  | "providerId"
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

function safeDiagnostic(error: unknown): Readonly<{
  name: string;
  message: string;
  cause?: Readonly<{ name: string; message: string }>;
}> {
  const detail = (value: unknown): Readonly<{ name: string; message: string }> => {
    if (!(value instanceof Error)) {
      return { name: "UnknownError", message: "Non-Error failure" };
    }
    const clean = (text: string, fallback: string): string => {
      const normalized = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      return normalized.length === 0 ? fallback : normalized.slice(0, 1_024);
    };
    return {
      name: clean(value.name, "Error"),
      message: clean(value.message, "Operation failed without a message"),
    };
  };
  const primary = detail(error);
  const cause =
    error instanceof Error && error.cause !== undefined ? detail(error.cause) : undefined;
  return cause === undefined ? primary : { ...primary, cause };
}

export class SandboxManagerServer {
  readonly #host: string;
  readonly #port: number;
  readonly #serviceDigest: Buffer;
  readonly #materializerDigest: Buffer | undefined;
  readonly #manager: SandboxManagerBackend;
  readonly #server: FastifyInstance;
  readonly #metrics: AgentDockMetrics | undefined;
  readonly #capacityMetrics: NodeJS.Timeout;
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
    this.#materializerDigest =
      options.materializerToken === undefined
        ? undefined
        : digest(validServiceToken(options.materializerToken));
    this.#manager = options.manager;
    this.#metrics = options.metrics;
    this.#server = Fastify({
      logger: false,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      requestTimeout: 320_000,
      keepAliveTimeout: 5_000,
    });
    this.#capacityMetrics = setInterval(() => this.#recordCapacityMetrics(), 1_000);
    this.#capacityMetrics.unref();
    this.#installRoutes();
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    if (this.#address !== undefined) throw new Error("Sandbox Manager is already listening");
    await this.#manager.checkHealth();
    this.#recordCapacityMetrics();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    this.#ready = true;
    return this.#address;
  }

  async close(): Promise<void> {
    this.#ready = false;
    clearInterval(this.#capacityMetrics);
    await this.#manager.close();
    if (this.#address !== undefined) {
      this.#address = undefined;
      await this.#server.close();
    }
  }

  #recordCapacityMetrics(): void {
    const labels = { provider: this.#manager.providerId };
    this.#metrics?.sandboxActive.set(labels, this.#manager.activeCount);
    this.#metrics?.sandboxAdmissionActive.set(labels, this.#manager.admittedCount);
    this.#metrics?.sandboxAdmissionLimit.set(labels, this.#manager.maximumActiveSandboxes);
    this.#metrics?.sandboxAdmissionWaiting.set(labels, this.#manager.admissionWaitingCount);
    this.#metrics?.sandboxPrewarm.set(labels, this.#manager.cleanPrewarmCount);
  }

  #authorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return token !== undefined && timingSafeEqual(this.#serviceDigest, candidate);
  }

  #materializerAuthorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return (
      token !== undefined &&
      this.#materializerDigest !== undefined &&
      timingSafeEqual(this.#materializerDigest, candidate)
    );
  }

  async #failure(reply: FastifyReply, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        service: "agent-dock-sandbox-manager",
        event: "operation_failed",
        publicCode: failure.code,
        retryable: failure.retryable,
        diagnostic: safeDiagnostic(error),
      })}\n`,
    );
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
      this.#metrics?.sandboxPrewarm.set(
        { provider: this.#manager.providerId },
        this.#manager.cleanPrewarmCount,
      );
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
          const reserved = await this.#observed({
            request,
            spanName: "sandbox.reserve",
            operation: "reserve",
            kind: "sandbox",
            run: () => this.#manager.create(message),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#manager.providerId },
            this.#manager.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#manager.providerId },
            this.#manager.cleanPrewarmCount,
          );
          await reply.code(200).send(reserved);
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
        if (message.type === "tool_sandbox.release") {
          const released = await this.#observed({
            request,
            spanName: "sandbox.release",
            operation: "release",
            kind: "sandbox",
            run: () => this.#manager.release(message),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#manager.providerId },
            this.#manager.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#manager.providerId },
            this.#manager.cleanPrewarmCount,
          );
          await reply.code(200).send(released);
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
          this.#metrics?.sandboxActive.set(
            { provider: this.#manager.providerId },
            this.#manager.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#manager.providerId },
            this.#manager.cleanPrewarmCount,
          );
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

    this.#server.post(SANDBOX_MANAGER_MATERIALIZER_PATH, async (request, reply) => {
      if (!this.#materializerAuthorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_snapshot_materializer_credential",
            message: "Workspace materialization request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSandboxManagerMaterializeFileRequest(request.body);
        await reply.code(200).send(
          await this.#observed({
            request,
            spanName: "workspace.materialize_file",
            operation: "materialize_file",
            kind: "sandbox",
            run: () => this.#manager.materializeFile(message),
          }),
        );
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
        this.#metrics?.sandboxActive.set(
          { provider: this.#manager.providerId },
          this.#manager.activeCount,
        );
        this.#metrics?.sandboxPrewarm.set(
          { provider: this.#manager.providerId },
          this.#manager.cleanPrewarmCount,
        );
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
