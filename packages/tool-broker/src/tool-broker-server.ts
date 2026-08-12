import {
  parseToolBrokerRequest,
  parseToolBrokerMaterializeFileRequest,
  parseSupervisorManagementRequest,
  parseToolSandboxOperationRequest,
  type InternalServiceError,
  type SupervisorManagementResponse,
} from "@agent-dock/protocol";
import { parseTraceCarrier, withSpan, type AgentDockMetrics } from "@agent-dock/observability";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  TOOL_BROKER_INVENTORY_PATH,
  TOOL_BROKER_LIVE_PATH,
  TOOL_BROKER_MATERIALIZER_PATH,
  TOOL_BROKER_OPERATION_PATH,
  TOOL_BROKER_READY_PATH,
  TOOL_BROKER_SERVICE_PATH,
} from "./tool-broker-client.ts";
import { ToolBrokerError } from "./sandbox-provider.ts";
import { ToolBrokerOwnerRedirectError, type ToolBroker } from "./tool-broker.ts";

const DEFAULT_BODY_LIMIT = 5 * 1_024 * 1_024;

export type ToolBrokerServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  materializerToken?: string;
  broker: ToolBrokerBackend;
  bodyLimit?: number;
  metrics?: AgentDockMetrics;
};

export type ToolBrokerBackend = Pick<
  ToolBroker,
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
    throw new TypeError("Tool Broker service token is invalid");
  }
  return value;
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function safeFailure(error: unknown): ToolBrokerError {
  if (error instanceof ToolBrokerError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /ProtocolError$/.test(error.name)
  ) {
    return new ToolBrokerError(
      "tool_broker_protocol_error",
      "Tool Broker request failed validation",
      false,
    );
  }
  return new ToolBrokerError("tool_broker_failed", "Tool Broker operation failed", true);
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

export class ToolBrokerServer {
  readonly #host: string;
  readonly #port: number;
  readonly #serviceDigest: Buffer;
  readonly #materializerDigest: Buffer | undefined;
  readonly #broker: ToolBrokerBackend;
  readonly #server: FastifyInstance;
  readonly #metrics: AgentDockMetrics | undefined;
  readonly #capacityMetrics: NodeJS.Timeout;
  #address: string | undefined;
  #ready = false;

  constructor(options: ToolBrokerServerOptions) {
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
    this.#broker = options.broker;
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
    if (this.#address !== undefined) throw new Error("Tool Broker is already listening");
    await this.#broker.checkHealth();
    this.#recordCapacityMetrics();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    this.#ready = true;
    return this.#address;
  }

  async close(): Promise<void> {
    this.#ready = false;
    clearInterval(this.#capacityMetrics);
    await this.#broker.close();
    if (this.#address !== undefined) {
      this.#address = undefined;
      await this.#server.close();
    }
  }

  #recordCapacityMetrics(): void {
    const labels = { provider: this.#broker.providerId };
    this.#metrics?.sandboxActive.set(labels, this.#broker.activeCount);
    this.#metrics?.sandboxAdmissionActive.set(labels, this.#broker.admittedCount);
    this.#metrics?.sandboxAdmissionLimit.set(labels, this.#broker.maximumActiveSandboxes);
    this.#metrics?.sandboxAdmissionWaiting.set(labels, this.#broker.admissionWaitingCount);
    this.#metrics?.sandboxPrewarm.set(labels, this.#broker.cleanPrewarmCount);
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
        service: "agent-dock-tool-broker",
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
      serviceName: "agent-dock-tool-broker",
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
    this.#server.get(TOOL_BROKER_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get(TOOL_BROKER_READY_PATH, async (_request, reply) => {
      let healthy = this.#ready;
      if (healthy) {
        try {
          await this.#broker.checkHealth();
        } catch {
          healthy = false;
        }
      }
      this.#metrics?.sandboxPrewarm.set(
        { provider: this.#broker.providerId },
        this.#broker.cleanPrewarmCount,
      );
      await reply.code(healthy ? 200 : 503).send({
        status: healthy ? "ready" : "not_ready",
      });
    });

    this.#server.post(TOOL_BROKER_SERVICE_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_broker_credential",
            message: "Tool Broker request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseToolBrokerRequest(request.body);
        if (message.type === "tool_sandbox.create") {
          let reserved;
          try {
            reserved = await this.#observed({
              request,
              spanName: "sandbox.reserve",
              operation: "reserve",
              kind: "sandbox",
              run: () => this.#broker.create(message),
            });
          } catch (error: unknown) {
            if (!(error instanceof ToolBrokerOwnerRedirectError)) throw error;
            await reply.code(200).send({
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.owner_redirect",
              requestId: message.requestId,
              ownerBaseUrl: error.ownerBaseUrl,
            });
            return;
          }
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
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
                this.#broker.capture(message.activationId, message.assignment, message.requestId),
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
            run: () => this.#broker.release(message),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
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
            run: () => this.#broker.stop(message.activationId, message.assignment),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
          );
          await reply.code(200).send({
            toolBrokerProtocolVersion: 1,
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
          run: () => this.#broker.importGitHub(message.source, controller.signal),
        });
        const { encodeWorkspaceSnapshotBlob } = await import("@agent-dock/workspace-runtime");
        await reply.code(200).send({
          toolBrokerProtocolVersion: 1,
          type: "workspace.github_imported",
          requestId: message.requestId,
          snapshot: encodeWorkspaceSnapshotBlob(snapshot),
        });
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_MATERIALIZER_PATH, async (request, reply) => {
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
        const message = parseToolBrokerMaterializeFileRequest(request.body);
        await reply.code(200).send(
          await this.#observed({
            request,
            spanName: "workspace.materialize_file",
            operation: "materialize_file",
            kind: "sandbox",
            run: () => this.#broker.materializeFile(message),
          }),
        );
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_OPERATION_PATH, async (request, reply) => {
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
      try {
        const message = parseToolSandboxOperationRequest(request.body);
        const response = await this.#observed({
          request,
          spanName: `tool.${message.operation}`,
          operation: message.operation,
          kind: "tool",
          // Tool execution is owned by operationId and the Run lease, not by
          // this particular HTTP connection. Explicit stop/cancel revokes it.
          run: () => this.#broker.execute(capability, message),
        });
        this.#metrics?.sandboxActive.set(
          { provider: this.#broker.providerId },
          this.#broker.activeCount,
        );
        this.#metrics?.sandboxPrewarm.set(
          { provider: this.#broker.providerId },
          this.#broker.cleanPrewarmCount,
        );
        await reply.code(200).send(response);
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_INVENTORY_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_broker_credential",
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
            assignments: [...(await this.#broker.listAssignments(message.sandboxId))],
          };
        } else if (message.type === "assignment.terminate_and_confirm") {
          await this.#broker.terminateAndConfirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else if (message.type === "assignment.confirm_absent") {
          await this.#broker.confirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else {
          throw new ToolBrokerError(
            "unsupported_tool_broker_operation",
            "Tool Broker does not own the Runner process",
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
