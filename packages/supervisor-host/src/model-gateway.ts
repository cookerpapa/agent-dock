import {
  PostgresTenantModelCredentialResolver,
  type TenantModelCredentialIdentity,
} from "@agent-dock/control-plane/model-credential-runtime";
import type { Database } from "@agent-dock/database";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import type { DockerSandboxModelRuntimeLease } from "@agent-dock/sandbox-supervisor";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Kysely } from "kysely";

const GATEWAY_PATH = "/v1/chat/completions";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;

type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}>;

type ActiveCapability = {
  tokenDigest: string;
  commandId: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  provider: "deepseek";
  modelId: "deepseek-v4-flash" | "deepseek-v4-pro";
  providerSecret: string;
  expiresAt: number;
  requestsRemaining: number;
  revoked: boolean;
  requestControllers: Set<AbortController>;
};

export type TenantModelGatewayOptions = {
  database: Kysely<Database>;
  credentialResolver: PostgresTenantModelCredentialResolver;
  host: string;
  port: number;
  advertisedBaseUrl: string;
  sandboxNetwork: string;
  capabilityTtlMs?: number;
  maximumRequestsPerTurn?: number;
  upstreamRequestTimeoutMs?: number;
  piRequestTimeoutMs?: number;
  piTurnTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
  idGenerator?: () => string;
};

export class TenantModelGatewayError extends Error {
  readonly code:
    | "gateway_not_started"
    | "gateway_already_started"
    | "unsupported_model"
    | "invalid_gateway_configuration";

  constructor(code: TenantModelGatewayError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantModelGatewayError";
    this.code = code;
  }
}

class SafeGatewayHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "SafeGatewayHttpError";
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TenantModelGatewayError("invalid_gateway_configuration", `${name} is invalid`);
  }
  return value;
}

function advertisedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Model gateway advertised URL is invalid",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Model gateway advertised URL is invalid",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function sandboxNetwork(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "none") {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Model gateway sandbox network is invalid",
    );
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Model gateway clock returned an invalid date",
    );
  }
  return value;
}

function bearerCapability(value: string | undefined): string | undefined {
  return value === undefined ? undefined : /^Bearer (admg_[A-Za-z0-9_-]{43})$/.exec(value)?.[1];
}

function capabilityDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximumBytes) {
      throw new SafeGatewayHttpError(413, "request_too_large", "Model request is too large");
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SafeGatewayHttpError(400, "invalid_request", "Model request must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SafeGatewayHttpError(400, "invalid_request", "Model request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function tokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function parseUsage(value: unknown): ModelUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = tokenCount(usage.prompt_tokens);
  const outputTokens = tokenCount(usage.completion_tokens);
  const promptDetails =
    typeof usage.prompt_tokens_details === "object" &&
    usage.prompt_tokens_details !== null &&
    !Array.isArray(usage.prompt_tokens_details)
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cacheReadTokens = tokenCount(promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  const cacheWriteTokens = tokenCount(promptDetails?.cache_write_tokens);
  if (promptTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return undefined;
  }
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

class StreamingUsageScanner {
  readonly #decoder = new TextDecoder();
  #line = "";
  #usage: ModelUsage | undefined;

  feed(chunk: Uint8Array): ModelUsage | undefined {
    this.#line += this.#decoder.decode(chunk, { stream: true });
    if (this.#line.length > 512 * 1_024) this.#line = this.#line.slice(-256 * 1_024);
    let newline = this.#line.indexOf("\n");
    while (newline !== -1) {
      const line = this.#line.slice(0, newline).trim();
      this.#line = this.#line.slice(newline + 1);
      if (line.startsWith("data:") && line !== "data: [DONE]") {
        try {
          const event = JSON.parse(line.slice(5).trim()) as unknown;
          if (typeof event === "object" && event !== null && !Array.isArray(event)) {
            this.#usage = parseUsage((event as Record<string, unknown>).usage) ?? this.#usage;
          }
        } catch {
          // Provider payload validation remains Pi's responsibility. Usage parsing
          // is deliberately side-band and never changes streamed model bytes.
        }
      }
      newline = this.#line.indexOf("\n");
    }
    return this.#usage;
  }
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (!response.write(chunk)) await once(response, "drain");
}

export class TenantModelGateway {
  readonly #database: Kysely<Database>;
  readonly #credentialResolver: PostgresTenantModelCredentialResolver;
  readonly #host: string;
  readonly #port: number;
  readonly #advertisedBaseUrl: string;
  readonly #sandboxNetwork: string;
  readonly #capabilityTtlMs: number;
  readonly #maximumRequestsPerTurn: number;
  readonly #upstreamRequestTimeoutMs: number;
  readonly #piRequestTimeoutMs: number;
  readonly #piTurnTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #idGenerator: () => string;
  readonly #server: Server;
  readonly #capabilities = new Map<string, ActiveCapability>();
  #started = false;
  #closing: Promise<void> | undefined;

  constructor(options: TenantModelGatewayOptions) {
    this.#database = options.database;
    this.#credentialResolver = options.credentialResolver;
    this.#host = options.host;
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TenantModelGatewayError("invalid_gateway_configuration", "port is invalid");
    }
    this.#port = options.port;
    this.#advertisedBaseUrl = advertisedBaseUrl(options.advertisedBaseUrl);
    this.#sandboxNetwork = sandboxNetwork(options.sandboxNetwork);
    this.#capabilityTtlMs = positiveInteger(
      options.capabilityTtlMs ?? 10 * 60_000,
      "capabilityTtlMs",
      60 * 60_000,
    );
    this.#maximumRequestsPerTurn = positiveInteger(
      options.maximumRequestsPerTurn ?? 32,
      "maximumRequestsPerTurn",
      256,
    );
    this.#upstreamRequestTimeoutMs = positiveInteger(
      options.upstreamRequestTimeoutMs ?? 120_000,
      "upstreamRequestTimeoutMs",
      300_000,
    );
    this.#piRequestTimeoutMs = positiveInteger(
      options.piRequestTimeoutMs ?? 150_000,
      "piRequestTimeoutMs",
      300_000,
    );
    this.#piTurnTimeoutMs = positiveInteger(
      options.piTurnTimeoutMs ?? 10 * 60_000,
      "piTurnTimeoutMs",
      15 * 60_000,
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (error instanceof SafeGatewayHttpError) {
          sendJson(response, error.status, { error: { code: error.code, message: error.message } });
          return;
        }
        sendJson(response, 502, {
          error: { code: "model_gateway_error", message: "Model gateway request failed" },
        });
      });
    });
  }

  get listeningPort(): number {
    const address = this.#server.address();
    if (!this.#started || address === null || typeof address === "string") {
      throw new TenantModelGatewayError("gateway_not_started", "Model gateway is not listening");
    }
    return (address as AddressInfo).port;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new TenantModelGatewayError(
        "gateway_already_started",
        "Model gateway has already started",
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => rejectPromise(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolvePromise();
      });
    });
  }

  issue(command: ExecuteTurnCommandMessage): Promise<DockerSandboxModelRuntimeLease> {
    return this.#issue(command);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #issue(command: ExecuteTurnCommandMessage): Promise<DockerSandboxModelRuntimeLease> {
    if (!this.#started) {
      throw new TenantModelGatewayError("gateway_not_started", "Model gateway is not listening");
    }
    const model = command.payload.model;
    if (
      model.provider !== "deepseek" ||
      (model.modelId !== "deepseek-v4-flash" && model.modelId !== "deepseek-v4-pro")
    ) {
      throw new TenantModelGatewayError("unsupported_model", "Accepted model is unsupported");
    }
    const credentialIdentity: TenantModelCredentialIdentity = {
      tenantId: command.payload.tenantId,
      credentialBindingId: model.credentialBindingId,
      credentialBindingVersion: model.credentialBindingVersion,
      provider: model.provider,
    };
    const resolved = await this.#credentialResolver.resolve(credentialIdentity);
    const random = this.#randomBytes(32);
    if (!Buffer.isBuffer(random) || random.length !== 32) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model gateway capability generation failed",
      );
    }
    const capability = `admg_${random.toString("base64url")}`;
    const digest = capabilityDigest(capability);
    if (this.#capabilities.has(digest)) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model gateway capability collision occurred",
      );
    }
    const active: ActiveCapability = {
      tokenDigest: digest,
      commandId: command.payload.commandId,
      tenantId: command.payload.tenantId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      provider: "deepseek",
      modelId: model.modelId,
      providerSecret: resolved.secret,
      expiresAt: validDate(this.#clock).valueOf() + this.#capabilityTtlMs,
      requestsRemaining: this.#maximumRequestsPerTurn,
      revoked: false,
      requestControllers: new Set(),
    };
    this.#capabilities.set(digest, active);
    let released = false;
    return {
      network: this.#sandboxNetwork,
      runtime: {
        kind: "openai_compatible_gateway",
        provider: "deepseek",
        modelId: model.modelId,
        baseUrl: `${this.#advertisedBaseUrl}/v1`,
        capability,
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
        requestTimeoutMs: this.#piRequestTimeoutMs,
        turnTimeoutMs: this.#piTurnTimeoutMs,
      },
      release: () => {
        if (released) return;
        released = true;
        this.#revoke(active);
      },
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://model-gateway.invalid").pathname;
    if (request.method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || path !== GATEWAY_PATH) {
      throw new SafeGatewayHttpError(404, "route_not_found", "Model gateway route not found");
    }
    const token = bearerCapability(request.headers.authorization);
    const active =
      token === undefined ? undefined : this.#capabilities.get(capabilityDigest(token));
    const now = validDate(this.#clock).valueOf();
    if (
      active === undefined ||
      active.revoked ||
      active.expiresAt <= now ||
      active.requestsRemaining < 1
    ) {
      if (active !== undefined && active.expiresAt <= now) this.#revoke(active);
      throw new SafeGatewayHttpError(
        401,
        "invalid_capability",
        "Model gateway capability is invalid",
      );
    }
    active.requestsRemaining -= 1;
    const body = await readJson(request, 2 * 1_024 * 1_024);
    if (body.model !== active.modelId) {
      throw new SafeGatewayHttpError(
        403,
        "model_binding_mismatch",
        "Model request does not match its turn capability",
      );
    }
    if (body.stream !== true) {
      throw new SafeGatewayHttpError(
        400,
        "streaming_required",
        "Model gateway requires a streaming request",
      );
    }
    const upstreamBody: Record<string, unknown> = {
      ...body,
      model: active.modelId,
      stream: true,
      stream_options: {
        ...(typeof body.stream_options === "object" &&
        body.stream_options !== null &&
        !Array.isArray(body.stream_options)
          ? (body.stream_options as Record<string, unknown>)
          : {}),
        include_usage: true,
      },
    };
    if (
      typeof upstreamBody.max_completion_tokens === "number" &&
      upstreamBody.max_tokens === undefined
    ) {
      upstreamBody.max_tokens = upstreamBody.max_completion_tokens;
      delete upstreamBody.max_completion_tokens;
    }

    const controller = new AbortController();
    active.requestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.#upstreamRequestTimeoutMs);
    timeout.unref();
    const abortOnDisconnect = (): void => controller.abort();
    request.once("aborted", abortOnDisconnect);
    response.once("close", abortOnDisconnect);
    try {
      const upstream = await this.#fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${active.providerSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
      response.writeHead(upstream.status, {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        ...(upstream.headers.get("retry-after") === null
          ? {}
          : { "retry-after": upstream.headers.get("retry-after")! }),
      });
      if (upstream.body === null) {
        response.end();
        return;
      }
      const scanner = new StreamingUsageScanner();
      let recorded = false;
      let responseBytes = 0;
      for await (const rawChunk of upstream.body) {
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new SafeGatewayHttpError(
            502,
            "response_too_large",
            "Model response exceeded the gateway limit",
          );
        }
        const usage = scanner.feed(chunk);
        if (!recorded && usage !== undefined && upstream.ok) {
          await this.#recordUsage(active, usage);
          recorded = true;
        }
        await writeChunk(response, chunk);
      }
      response.end();
    } finally {
      clearTimeout(timeout);
      request.off("aborted", abortOnDisconnect);
      response.off("close", abortOnDisconnect);
      active.requestControllers.delete(controller);
    }
  }

  async #recordUsage(active: ActiveCapability, usage: ModelUsage): Promise<void> {
    await this.#database
      .insertInto("usage_ledger")
      .values({
        id: this.#idGenerator(),
        tenant_id: active.tenantId,
        session_id: active.sessionId,
        turn_id: active.turnId,
        provider: active.provider,
        model_id: active.modelId,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cost_amount: "0",
        created_at: validDate(this.#clock),
      })
      .executeTakeFirstOrThrow();
  }

  #revoke(active: ActiveCapability): void {
    if (active.revoked) return;
    active.revoked = true;
    this.#capabilities.delete(active.tokenDigest);
    for (const controller of active.requestControllers) controller.abort();
    active.requestControllers.clear();
    active.providerSecret = "";
  }

  async #close(): Promise<void> {
    for (const active of this.#capabilities.values()) this.#revoke(active);
    if (!this.#server.listening) return;
    await new Promise<void>((resolvePromise) => {
      this.#server.close(() => resolvePromise());
      this.#server.closeAllConnections();
    });
  }
}
