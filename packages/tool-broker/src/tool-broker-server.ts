import {
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  parseWorkspaceTerminalClientFrame,
  parseWorkspaceTerminalOpenRequest,
  parseToolBrokerRequest,
  parseToolBrokerMaterializeFileRequest,
  parseSupervisorManagementRequest,
  parseToolSandboxOperationRequest,
  type InternalServiceError,
  type SupervisorManagementResponse,
} from "@agent-dock/protocol";
import fastifyWebsocket from "@fastify/websocket";
import { parseTraceCarrier, withSpan, type AgentDockMetrics } from "@agent-dock/observability";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
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
const DEFAULT_TERMINAL_SEND_BUFFER_BYTES = 1 * 1_024 * 1_024;
export const TOOL_BROKER_TERMINAL_PATH = "/internal/v1/workspace-terminal";

export type ToolBrokerServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  materializerToken?: string;
  terminalToken?: string;
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
> &
  Partial<Pick<ToolBroker, "openTerminal">>;

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
  readonly #terminalDigest: Buffer | undefined;
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
    this.#terminalDigest =
      options.terminalToken === undefined
        ? undefined
        : digest(validServiceToken(options.terminalToken));
    this.#broker = options.broker;
    this.#metrics = options.metrics;
    this.#server = Fastify({
      logger: false,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      requestTimeout: 320_000,
      keepAliveTimeout: 5_000,
    });
    this.#server.register(fastifyWebsocket, {
      options: {
        maxPayload: MAX_WORKSPACE_TERMINAL_FRAME_BYTES * 2,
        perMessageDeflate: false,
      },
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

  #terminalAuthorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return (
      token !== undefined &&
      this.#terminalDigest !== undefined &&
      timingSafeEqual(this.#terminalDigest, candidate)
    );
  }

  async #failure(reply: FastifyReply, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    if (
      failure.code === "tenant_sandbox_capacity_exhausted" ||
      failure.code === "sandbox_domain_capacity_exhausted"
    ) {
      this.#metrics?.sandboxAdmissionRejected.inc({ reason: failure.code });
    }
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

    if (this.#terminalDigest !== undefined && this.#broker.openTerminal !== undefined) {
      this.#server.register(async (scope) => {
        scope.addHook("preValidation", async (request, reply) => {
          if (!this.#terminalAuthorized(request.headers.authorization)) {
            await reply.code(401).send();
          }
        });
        scope.get(TOOL_BROKER_TERMINAL_PATH, { websocket: true }, (socket) => {
          this.#acceptTerminalSocket(socket);
        });
      });
    }

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

  #acceptTerminalSocket(socket: WebSocket): void {
    let connection: Awaited<ReturnType<NonNullable<ToolBrokerBackend["openTerminal"]>>> | undefined;
    let closed = false;
    let initialized = false;
    let processing = Promise.resolve();
    const send = async (frame: unknown): Promise<void> => {
      if (closed || socket.readyState !== socket.OPEN) return;
      const payload = JSON.stringify(frame);
      const bytes = Buffer.byteLength(payload, "utf8");
      if (
        bytes > DEFAULT_TERMINAL_SEND_BUFFER_BYTES ||
        socket.bufferedAmount + bytes > DEFAULT_TERMINAL_SEND_BUFFER_BYTES
      ) {
        socket.close(4_002, "terminal send buffer overloaded");
        return;
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.send(payload, (error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await connection?.close().catch(() => undefined);
      if (socket.readyState === socket.OPEN) socket.close(1_000, "terminal closed");
      else if (socket.readyState !== socket.CLOSED) socket.terminate();
    };
    const fail = async (error: unknown): Promise<void> => {
      if (error instanceof ToolBrokerOwnerRedirectError) {
        await send({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.owner_redirect",
          ownerBaseUrl: error.ownerBaseUrl,
        });
      } else {
        const failure = safeFailure(error);
        await send({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.error",
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        });
      }
      await close();
    };
    socket.on("message", (data: RawData) => {
      processing = processing
        .then(async () => {
          const raw =
            data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : data.toString("utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!initialized) {
            initialized = true;
            const open = parseWorkspaceTerminalOpenRequest(parsed);
            const openTerminal = this.#broker.openTerminal;
            if (openTerminal === undefined) {
              throw new ToolBrokerError(
                "workspace_terminal_unsupported",
                "Workspace terminal is unavailable",
                false,
              );
            }
            const opened = await openTerminal.call(this.#broker, {
              tenantId: open.tenantId,
              userId: open.userId,
              projectId: open.projectId,
              workspaceId: open.workspaceId,
              sessionId: open.sessionId,
              environment: open.environment,
              workspaceSeed: open.workspaceSeed,
              size: { rows: open.rows, cols: open.cols },
            });
            if (closed) {
              await opened.close().catch(() => undefined);
              return;
            }
            connection = opened;
            await send({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.ready",
              terminalId: connection.terminalId,
              pid: connection.pid,
              workspaceRoot: "/workspace",
            });
            void (async () => {
              try {
                for await (const chunk of connection!.output) {
                  for (let offset = 0; offset < chunk.byteLength; offset += 48 * 1_024) {
                    await send({
                      workspaceTerminalProtocolVersion: 1,
                      type: "workspace_terminal.output",
                      data: Buffer.from(chunk.subarray(offset, offset + 48 * 1_024)).toString(
                        "base64",
                      ),
                    });
                  }
                }
                await send({
                  workspaceTerminalProtocolVersion: 1,
                  type: "workspace_terminal.exit",
                });
                await close();
              } catch (error: unknown) {
                await fail(error);
              }
            })();
            return;
          }
          if (connection === undefined) {
            throw new ToolBrokerError(
              "workspace_terminal_not_ready",
              "Workspace terminal is still starting",
              true,
            );
          }
          const frame = parseWorkspaceTerminalClientFrame(parsed);
          if (frame.type === "workspace_terminal.input") {
            await connection.sendInput(Buffer.from(frame.data, "base64"));
          } else if (frame.type === "workspace_terminal.resize") {
            await connection.resize({ rows: frame.rows, cols: frame.cols });
          } else if (frame.type === "workspace_terminal.close") {
            await close();
          } else {
            await send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.pong" });
          }
        })
        .catch((error: unknown) => fail(error));
    });
    socket.once("close", () => void close());
    socket.once("error", () => void close());
  }
}
