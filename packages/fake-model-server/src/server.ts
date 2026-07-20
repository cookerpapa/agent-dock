import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export const FAKE_MODEL_API_KEY = "agent-dock-test-key";
export const FAKE_MODEL_ID = "agent-dock-fake";

export const fakeModelScenarios = [
  "text",
  "tool_call",
  "java_repair",
  "java_followup",
  "coding_eval",
  "rate_limit",
  "timeout",
  "malformed",
  "disconnect",
] as const;

export type FakeModelScenario = (typeof fakeModelScenarios)[number];

export type FakeModelRequestCompletion =
  "pending" | "completed" | "client_aborted" | "server_disconnected" | "server_stopped";

export type FakeModelRequestObservation = {
  requestId: string;
  scenario: FakeModelScenario;
  method: "POST";
  path: "/v1/chat/completions";
  model: string;
  messageCount: number;
  toolCount: number;
  authorizationPresent: boolean;
  responseStatus: number | null;
  completion: FakeModelRequestCompletion;
};

export type FakeModelServerOptions = {
  host?: string;
  port?: number;
  apiKey?: string;
  defaultScenario?: FakeModelScenario;
  maxRequestBytes?: number;
};

type ChatCompletionRequest = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream: true;
};

type MutableObservation = FakeModelRequestObservation;

class SafeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SafeHttpError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  return value;
}

function parseLoopbackHost(value: string): string {
  if (value !== "127.0.0.1" && value !== "::1" && value !== "localhost") {
    throw new Error("host must be a loopback address (127.0.0.1, ::1, or localhost)");
  }
  return value;
}

function parsePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseScenario(value: string | undefined): FakeModelScenario | undefined {
  return fakeModelScenarios.find((scenario) => scenario === value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, message: string, code: string): void {
  sendJson(response, status, {
    error: {
      message,
      type: status === 429 ? "rate_limit_error" : "invalid_request_error",
      code,
    },
  });
}

function openEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

function writeEvent(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeDone(response: ServerResponse): void {
  response.write("data: [DONE]\n\n");
}

function yieldToSocket(): Promise<void> {
  return new Promise((resolvePromise) => {
    setImmediate(resolvePromise);
  });
}

function completionChunk(
  requestId: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function usageChunk(
  requestId: string,
  created: number,
  model: string,
  completionTokens: number,
): Record<string, unknown> {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: completionTokens,
      total_tokens: 12 + completionTokens,
      prompt_tokens_details: {
        cached_tokens: 2,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
      },
    },
  };
}

async function readJsonBody(request: IncomingMessage, maxRequestBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) {
      throw new SafeHttpError(413, "Request body exceeds the fake server limit");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new SafeHttpError(400, "Request body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SafeHttpError(400, "Request body must be valid JSON");
  }
}

function parseChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (!isRecord(value)) {
    throw new SafeHttpError(400, "Request body must be a JSON object");
  }
  if (typeof value.model !== "string" || value.model.length === 0 || value.model.length > 256) {
    throw new SafeHttpError(400, "model must contain between 1 and 256 characters");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new SafeHttpError(400, "messages must be a non-empty array");
  }
  if (value.stream !== true) {
    throw new SafeHttpError(400, "the fake server requires stream=true");
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new SafeHttpError(400, "tools must be an array when present");
  }
  return {
    model: value.model,
    messages: value.messages,
    ...(Array.isArray(value.tools) ? { tools: value.tools } : {}),
    stream: true,
  };
}

function hasToolResult(messages: readonly unknown[]): boolean {
  return messages.some((message) => isRecord(message) && message.role === "tool");
}

function toolResultCount(messages: readonly unknown[]): number {
  return messages.filter((message) => isRecord(message) && message.role === "tool").length;
}

function latestUserMessageIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") return index;
  }
  return -1;
}

function currentTurnToolResultCount(messages: readonly unknown[]): number {
  const latestUser = latestUserMessageIndex(messages);
  return messages
    .slice(latestUser + 1)
    .filter((message) => isRecord(message) && message.role === "tool").length;
}

function hasPriorJavaRepair(messages: readonly unknown[]): boolean {
  const latestUser = latestUserMessageIndex(messages);
  return messages.slice(0, latestUser).some((message) => {
    if (!isRecord(message) || message.role !== "assistant") return false;
    const content = JSON.stringify(message.content);
    return typeof content === "string" && content.includes("Java repair verified.");
  });
}

type CodingEvalTask = Readonly<{
  id: string;
  path: string;
  oldText: string;
  newText: string;
}>;

const codingEvalTasks: readonly CodingEvalTask[] = [
  {
    id: "add",
    path: "src/Calculator.java",
    oldText: "return left - right;",
    newText: "return left + right;",
  },
  {
    id: "subtract",
    path: "src/Calculator.java",
    oldText: "return left + right; // BUG: subtract",
    newText: "return left - right;",
  },
  {
    id: "multiply",
    path: "src/Calculator.java",
    oldText: "return left + right; // BUG: multiply",
    newText: "return left * right;",
  },
  {
    id: "divide",
    path: "src/Calculator.java",
    oldText: "return left * right; // BUG: divide",
    newText: "return left / right;",
  },
  {
    id: "maximum",
    path: "src/Calculator.java",
    oldText: "return left < right ? left : right;",
    newText: "return left > right ? left : right;",
  },
  {
    id: "clamp",
    path: "src/Calculator.java",
    oldText: "return value; // BUG: clamp",
    newText: "return Math.max(minimum, Math.min(maximum, value));",
  },
  {
    id: "even",
    path: "src/Calculator.java",
    oldText: "return value % 2 != 0;",
    newText: "return value % 2 == 0;",
  },
  {
    id: "average",
    path: "src/Calculator.java",
    oldText: "return left + right; // BUG: average",
    newText: "return (left + right) / 2.0;",
  },
  {
    id: "factorial",
    path: "src/Calculator.java",
    oldText: "return value; // BUG: factorial",
    newText:
      "int result = 1;\n        for (int factor = 2; factor <= value; factor++) result *= factor;\n        return result;",
  },
  {
    id: "square",
    path: "src/Calculator.java",
    oldText: "return value + value; // BUG: square",
    newText: "return value * value;",
  },
];

function latestUserText(messages: readonly unknown[]): string | undefined {
  const index = latestUserMessageIndex(messages);
  if (index < 0) return undefined;
  const message = messages[index];
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as Record<string, unknown>).text as string)
    .join("\n");
}

function codingEvalTask(messages: readonly unknown[]): CodingEvalTask | undefined {
  const taskId = /^agent-dock-eval:\/\/([a-z0-9-]+)/.exec(latestUserText(messages) ?? "")?.[1];
  return codingEvalTasks.find((task) => task.id === taskId);
}

export class FakeModelServer {
  readonly #host: string;
  readonly #port: number;
  readonly #apiKey: string;
  readonly #defaultScenario: FakeModelScenario;
  readonly #maxRequestBytes: number;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #heldResponses = new Map<ServerResponse, MutableObservation>();
  readonly #observations: MutableObservation[] = [];
  #started = false;
  #stopped = false;
  #requestSequence = 0;

  constructor(options: FakeModelServerOptions = {}) {
    this.#host = parseLoopbackHost(options.host ?? "127.0.0.1");
    this.#port = parsePort(options.port ?? 0);
    this.#apiKey = options.apiKey ?? FAKE_MODEL_API_KEY;
    if (this.#apiKey.length === 0) {
      throw new Error("apiKey must not be empty");
    }
    this.#defaultScenario = options.defaultScenario ?? "text";
    this.#maxRequestBytes = parsePositiveSafeInteger(
      options.maxRequestBytes ?? 1_048_576,
      "maxRequestBytes",
    );
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (error instanceof SafeHttpError) {
          sendError(response, error.status, error.message, "invalid_request");
          return;
        }
        sendError(response, 500, "Fake model server internal error", "internal_error");
      });
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
      });
    });
  }

  get origin(): string {
    const address = this.#listeningAddress();
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  get observations(): readonly FakeModelRequestObservation[] {
    return this.#observations.map((observation) => ({ ...observation }));
  }

  get activeRequests(): number {
    return this.#heldResponses.size;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Fake model server has already been started");
    }
    if (this.#stopped) {
      throw new Error("A stopped fake model server cannot be restarted");
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        this.#started = true;
        resolvePromise();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const [response, observation] of this.#heldResponses) {
      observation.completion = "server_stopped";
      response.destroy();
    }
    this.#heldResponses.clear();
    if (!this.#server.listening) {
      return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      });
      for (const socket of this.#sockets) {
        socket.destroy();
      }
    });
  }

  #listeningAddress(): AddressInfo {
    const address = this.#server.address();
    if (!this.#started || address === null || typeof address === "string") {
      throw new Error("Fake model server is not listening");
    }
    return address;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://agent-dock.local").pathname;
    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, {
        status: "ok",
        protocol: "openai-chat-completions",
        scenarios: fakeModelScenarios,
      });
      return;
    }
    if (path !== "/v1/chat/completions") {
      sendError(response, 404, "Route not found", "not_found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendError(response, 405, "Method not allowed", "method_not_allowed");
      return;
    }

    const authorization = request.headers.authorization;
    if (!authorization || !safeEqual(authorization, `Bearer ${this.#apiKey}`)) {
      sendError(response, 401, "Fake model authentication failed", "invalid_api_key");
      return;
    }
    const scenarioHeader = request.headers["x-agent-dock-scenario"];
    if (Array.isArray(scenarioHeader)) {
      throw new SafeHttpError(400, "x-agent-dock-scenario must have one value");
    }
    const scenario =
      scenarioHeader === undefined ? this.#defaultScenario : parseScenario(scenarioHeader);
    if (!scenario) {
      throw new SafeHttpError(400, "Unknown fake model scenario");
    }

    const payload = parseChatCompletionRequest(await readJsonBody(request, this.#maxRequestBytes));
    const sequence = ++this.#requestSequence;
    const requestId = `chatcmpl-agentdock-${String(sequence).padStart(4, "0")}`;
    const observation: MutableObservation = {
      requestId,
      scenario,
      method: "POST",
      path: "/v1/chat/completions",
      model: payload.model,
      messageCount: payload.messages.length,
      toolCount: payload.tools?.length ?? 0,
      authorizationPresent: true,
      responseStatus: scenario === "timeout" ? null : scenario === "rate_limit" ? 429 : 200,
      completion: scenario === "timeout" ? "pending" : "completed",
    };
    this.#observations.push(observation);

    if (scenario === "rate_limit") {
      response.setHeader("retry-after", "1");
      sendError(response, 429, "AgentDock deterministic rate limit", "rate_limit_exceeded");
      return;
    }
    if (scenario === "timeout") {
      await this.#holdUntilClientCloses(response, observation);
      return;
    }
    if (scenario === "malformed") {
      openEventStream(response);
      response.write('data: {"id":"malformed"\n\n');
      writeDone(response);
      response.end();
      return;
    }
    if (scenario === "disconnect") {
      await this.#disconnectDuringStream(response, observation, requestId, sequence, payload.model);
      return;
    }
    if (scenario === "tool_call" && !hasToolResult(payload.messages)) {
      await this.#streamToolCall(response, requestId, sequence, payload.model);
      return;
    }
    if (scenario === "java_repair") {
      const completedTools = toolResultCount(payload.messages);
      if (completedTools === 0) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          "call_agentdock_java_test_before",
          "bash",
          { command: "bash ./test.sh" },
        );
        return;
      }
      if (completedTools === 1) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          "call_agentdock_java_edit",
          "edit",
          {
            path: "src/Calculator.java",
            edits: [
              {
                oldText: "return left - right;",
                newText: "return left + right;",
              },
            ],
          },
        );
        return;
      }
      if (completedTools === 2) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          "call_agentdock_java_test_after",
          "bash",
          { command: "bash ./test.sh" },
        );
        return;
      }
    }
    if (scenario === "java_followup") {
      const restoredConversation = hasPriorJavaRepair(payload.messages);
      if (currentTurnToolResultCount(payload.messages) === 0) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          "call_agentdock_java_followup",
          "bash",
          {
            command: restoredConversation
              ? "grep -F 'return left + right;' src/Calculator.java && bash ./test.sh"
              : "printf 'prior Pi conversation was not restored\\n' >&2; exit 1",
          },
        );
        return;
      }
      await this.#streamText(
        response,
        requestId,
        sequence,
        payload.model,
        restoredConversation
          ? "Prior conversation and Java repair restored after cold activation."
          : "Prior conversation was missing after cold activation.",
      );
      return;
    }
    if (scenario === "coding_eval") {
      const task = codingEvalTask(payload.messages);
      if (task === undefined) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          "call_agentdock_eval_invalid",
          "bash",
          { command: "printf 'unknown coding eval task\\n' >&2; exit 2" },
        );
        return;
      }
      const completedTools = currentTurnToolResultCount(payload.messages);
      if (completedTools === 0) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          `call_agentdock_eval_${task.id}_before`,
          "bash",
          { command: `bash eval/test.sh ${task.id}` },
        );
        return;
      }
      if (completedTools === 1) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          `call_agentdock_eval_${task.id}_edit`,
          "edit",
          {
            path: task.path,
            edits: [{ oldText: task.oldText, newText: task.newText }],
          },
        );
        return;
      }
      if (completedTools === 2) {
        await this.#streamNamedToolCall(
          response,
          requestId,
          sequence,
          payload.model,
          `call_agentdock_eval_${task.id}_after`,
          "bash",
          { command: `bash eval/test.sh ${task.id}` },
        );
        return;
      }
      await this.#streamText(
        response,
        requestId,
        sequence,
        payload.model,
        `Coding evaluation task ${task.id} repaired and verified.`,
      );
      return;
    }
    const text =
      scenario === "tool_call"
        ? "Tool result accepted."
        : scenario === "java_repair"
          ? "Java repair verified."
          : "AgentDock fake stream OK.";
    await this.#streamText(response, requestId, sequence, payload.model, text);
  }

  async #streamText(
    response: ServerResponse,
    requestId: string,
    sequence: number,
    model: string,
    text: string,
  ): Promise<void> {
    const created = 1_700_000_000 + sequence;
    const splitAt = Math.max(1, Math.floor(text.length / 2));
    openEventStream(response);
    writeEvent(
      response,
      completionChunk(requestId, created, model, { role: "assistant", content: "" }),
    );
    await yieldToSocket();
    writeEvent(
      response,
      completionChunk(requestId, created, model, { content: text.slice(0, splitAt) }),
    );
    await yieldToSocket();
    writeEvent(
      response,
      completionChunk(requestId, created, model, { content: text.slice(splitAt) }),
    );
    writeEvent(response, completionChunk(requestId, created, model, {}, "stop"));
    writeEvent(response, usageChunk(requestId, created, model, 5));
    writeDone(response);
    response.end();
  }

  async #streamToolCall(
    response: ServerResponse,
    requestId: string,
    sequence: number,
    model: string,
  ): Promise<void> {
    return this.#streamNamedToolCall(
      response,
      requestId,
      sequence,
      model,
      "call_agentdock_001",
      "inspect_workspace",
      { path: "src" },
    );
  }

  async #streamNamedToolCall(
    response: ServerResponse,
    requestId: string,
    sequence: number,
    model: string,
    toolCallId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<void> {
    const created = 1_700_000_000 + sequence;
    const serializedArguments = JSON.stringify(argumentsValue);
    const splitAt = Math.max(1, Math.floor(serializedArguments.length / 2));
    openEventStream(response);
    writeEvent(
      response,
      completionChunk(requestId, created, model, { role: "assistant", content: "" }),
    );
    await yieldToSocket();
    writeEvent(
      response,
      completionChunk(requestId, created, model, {
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: serializedArguments.slice(0, splitAt),
            },
          },
        ],
      }),
    );
    await yieldToSocket();
    writeEvent(
      response,
      completionChunk(requestId, created, model, {
        tool_calls: [
          {
            index: 0,
            function: { arguments: serializedArguments.slice(splitAt) },
          },
        ],
      }),
    );
    writeEvent(response, completionChunk(requestId, created, model, {}, "tool_calls"));
    writeEvent(response, usageChunk(requestId, created, model, 4));
    writeDone(response);
    response.end();
  }

  async #disconnectDuringStream(
    response: ServerResponse,
    observation: MutableObservation,
    requestId: string,
    sequence: number,
    model: string,
  ): Promise<void> {
    const created = 1_700_000_000 + sequence;
    openEventStream(response);
    writeEvent(
      response,
      completionChunk(requestId, created, model, { role: "assistant", content: "" }),
    );
    writeEvent(
      response,
      completionChunk(requestId, created, model, { content: "partial-before-disconnect" }),
    );
    await yieldToSocket();
    observation.completion = "server_disconnected";
    response.destroy();
  }

  #holdUntilClientCloses(response: ServerResponse, observation: MutableObservation): Promise<void> {
    // Deliberately do not send response headers. The OpenAI SDK's timeoutMs
    // covers waiting for the HTTP response; an already-open but idle SSE body
    // is a separate stream-idle concern owned by the caller/supervisor.
    this.#heldResponses.set(response, observation);
    return new Promise((resolvePromise) => {
      response.once("close", () => {
        const wasHeld = this.#heldResponses.delete(response);
        if (wasHeld && observation.completion !== "server_stopped") {
          observation.completion = "client_aborted";
        }
        resolvePromise();
      });
    });
  }
}
