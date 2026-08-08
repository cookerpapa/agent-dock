import {
  PostgresTenantModelCredentialResolver,
  type TenantModelCredentialIdentity,
} from "@agent-dock/runtime-core/model-credential-runtime";
import type { Database } from "@agent-dock/database";
import {
  MODEL_SAMPLING_ATTEMPT_HEADER,
  MODEL_STEP_SEQUENCE_HEADER,
  MODEL_STEP_SHA256_HEADER,
  parseModelSamplingIdentity,
  type ExecuteTurnCommandMessage,
  type ModelSamplingIdentity,
} from "@agent-dock/protocol";
import type { TrustedModelRuntimeLease } from "@agent-dock/sandbox-supervisor";
import { parseTraceCarrier, withSpan, type AgentDockMetrics } from "@agent-dock/observability";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { sql, type Kysely } from "kysely";

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
  runId: string;
  attemptId: string;
  modelProfileId: string;
  provider: "deepseek";
  modelId: "deepseek-v4-flash" | "deepseek-v4-pro";
  providerSecret: string;
  expiresAt: number;
  maximumRequestsPerRun: number;
  maximumCostMicrousdPerRun: number | undefined;
  revoked: boolean;
  requestControllers: Set<AbortController>;
};

type ModelRate = Readonly<{
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}>;

type ModelReservation = Readonly<{
  id: string;
  sequence: number;
  requestedModelId: ActiveCapability["modelId"];
  fallbackModelId: ActiveCapability["modelId"] | undefined;
  fallbackOnRateLimit: boolean;
  fallbackOnServerError: boolean;
  fallbackOnTimeout: boolean;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  primaryRate: ModelRate;
  fallbackRate: ModelRate | undefined;
}>;

export type TenantModelGatewayOptions = {
  database: Kysely<Database>;
  credentialResolver: PostgresTenantModelCredentialResolver;
  host: string;
  port: number;
  advertisedBaseUrl: string;
  capabilityTtlMs?: number;
  maximumRequestsPerTurn?: number;
  upstreamRequestTimeoutMs?: number;
  piRequestTimeoutMs?: number;
  piTurnTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
  idGenerator?: () => string;
  metrics?: AgentDockMetrics;
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

function samplingIdentity(request: IncomingMessage): ModelSamplingIdentity {
  try {
    return parseModelSamplingIdentity({
      stepSequence: request.headers[MODEL_STEP_SEQUENCE_HEADER],
      stepSha256: request.headers[MODEL_STEP_SHA256_HEADER],
      samplingAttempt: request.headers[MODEL_SAMPLING_ATTEMPT_HEADER],
    });
  } catch {
    throw new SafeGatewayHttpError(
      400,
      "model_sampling_identity_invalid",
      "Model request is missing its Cloud Step identity",
    );
  }
}

function observableSamplingIdentity(request: IncomingMessage): ModelSamplingIdentity | undefined {
  try {
    return samplingIdentity(request);
  } catch {
    return undefined;
  }
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

function positiveTokenLimit(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_536
    ? (value as number)
    : fallback;
}

function estimatedInputTokens(body: Record<string, unknown>): number {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  return Math.max(1, Math.ceil(bytes / 3));
}

function integer(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SafeGatewayHttpError(500, "governance_invariant", `${name} is invalid`);
  }
  return parsed;
}

function bigInteger(value: string | number | bigint, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new SafeGatewayHttpError(500, "governance_invariant", `${name} is invalid`);
  }
}

function rateFromRow(row: {
  input_microusd_per_million: string;
  output_microusd_per_million: string;
  cache_read_microusd_per_million: string;
  cache_write_microusd_per_million: string;
}): ModelRate {
  return {
    input: bigInteger(row.input_microusd_per_million, "input model rate"),
    output: bigInteger(row.output_microusd_per_million, "output model rate"),
    cacheRead: bigInteger(row.cache_read_microusd_per_million, "cache-read model rate"),
    cacheWrite: bigInteger(row.cache_write_microusd_per_million, "cache-write model rate"),
  };
}

function ceilMicrousd(tokens: number, rate: bigint): bigint {
  return (BigInt(tokens) * rate + 999_999n) / 1_000_000n;
}

function estimatedCost(inputTokens: number, outputTokens: number, rate: ModelRate): bigint {
  return ceilMicrousd(inputTokens, rate.input) + ceilMicrousd(outputTokens, rate.output);
}

function actualCost(usage: ModelUsage, rate: ModelRate): bigint {
  return (
    ceilMicrousd(usage.inputTokens, rate.input) +
    ceilMicrousd(usage.outputTokens, rate.output) +
    ceilMicrousd(usage.cacheReadTokens, rate.cacheRead) +
    ceilMicrousd(usage.cacheWriteTokens, rate.cacheWrite)
  );
}

function decimalDollars(microusd: bigint): string {
  const whole = microusd / 1_000_000n;
  const fractional = (microusd % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fractional}`;
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
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
  readonly #capabilityTtlMs: number;
  readonly #maximumRequestsPerTurn: number;
  readonly #upstreamRequestTimeoutMs: number;
  readonly #piRequestTimeoutMs: number;
  readonly #piTurnTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #idGenerator: () => string;
  readonly #metrics: AgentDockMetrics | undefined;
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
    this.#metrics = options.metrics;
    this.#server = createServer((request, response) => {
      const startedAt = performance.now();
      const token = bearerCapability(request.headers.authorization);
      const active =
        token === undefined ? undefined : this.#capabilities.get(capabilityDigest(token));
      const sampling = observableSamplingIdentity(request);
      const parent = parseTraceCarrier({
        traceparent: request.headers.traceparent,
        tracestate: request.headers.tracestate,
      });
      void withSpan({
        serviceName: "agent-dock-model-gateway",
        name: "model.request",
        ...(parent === undefined ? {} : { parent }),
        attributes: {
          ...(active === undefined
            ? {}
            : {
                "agent_dock.run.id": active.runId,
                "agent_dock.attempt.id": active.attemptId,
                ...(sampling === undefined
                  ? {}
                  : {
                      "agent_dock.step.sequence": sampling.stepSequence,
                      "agent_dock.step.sha256": sampling.stepSha256,
                      "agent_dock.sampling.attempt": sampling.samplingAttempt,
                    }),
                "gen_ai.system": active.provider,
                "gen_ai.request.model": active.modelId,
              }),
        },
        run: () => this.#handle(request, response),
      }).then(
        () => {
          if (active !== undefined) {
            this.#metrics?.modelDuration.observe(
              {
                provider: active.provider,
                model: active.modelId,
                outcome: response.statusCode < 400 ? "completed" : "rejected",
              },
              (performance.now() - startedAt) / 1_000,
            );
          }
        },
        (error: unknown) => {
          if (active !== undefined) {
            this.#metrics?.modelDuration.observe(
              { provider: active.provider, model: active.modelId, outcome: "failed" },
              (performance.now() - startedAt) / 1_000,
            );
          }
          if (error instanceof SafeGatewayHttpError) {
            sendJson(response, error.status, {
              error: { code: error.code, message: error.message },
            });
            return;
          }
          sendJson(response, 502, {
            error: { code: "model_gateway_error", message: "Model gateway request failed" },
          });
        },
      );
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

  issue(command: ExecuteTurnCommandMessage): Promise<TrustedModelRuntimeLease> {
    return this.#issue(command);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #issue(command: ExecuteTurnCommandMessage): Promise<TrustedModelRuntimeLease> {
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
      runId: command.payload.runId,
      attemptId: command.payload.attemptId,
      modelProfileId: model.profileId,
      provider: "deepseek",
      modelId: model.modelId,
      providerSecret: resolved.secret,
      expiresAt: validDate(this.#clock).valueOf() + this.#capabilityTtlMs,
      maximumRequestsPerRun: Math.min(
        this.#maximumRequestsPerTurn,
        command.payload.budgets?.maximumModelRequests ?? this.#maximumRequestsPerTurn,
      ),
      maximumCostMicrousdPerRun: command.payload.budgets?.maximumCostMicrousd,
      revoked: false,
      requestControllers: new Set(),
    };
    this.#capabilities.set(digest, active);
    let released = false;
    return {
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
    if (active === undefined || active.revoked || active.expiresAt <= now) {
      if (active !== undefined && active.expiresAt <= now) this.#revoke(active);
      throw new SafeGatewayHttpError(
        401,
        "invalid_capability",
        "Model gateway capability is invalid",
      );
    }
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
    const sampling = samplingIdentity(request);
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

    const reservation = await this.#reserve(active, upstreamBody, sampling);
    let selectedModel = reservation.requestedModelId;
    let selectedRate = reservation.primaryRate;
    let fallbackReason: string | undefined;
    let settled = false;
    let activeAttempt:
      | {
          upstream: Response;
          controller: AbortController;
          cleanup(): void;
        }
      | undefined;

    const fetchAttempt = async (
      modelId: ActiveCapability["modelId"],
    ): Promise<
      | { kind: "response"; upstream: Response; controller: AbortController; cleanup(): void }
      | { kind: "error"; timedOut: boolean; disconnected: boolean }
    > => {
      const controller = new AbortController();
      let timedOut = false;
      let disconnected = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#upstreamRequestTimeoutMs);
      timeout.unref();
      const abortOnRequest = (): void => {
        disconnected = true;
        controller.abort();
      };
      const abortOnResponse = (): void => {
        if (!response.writableEnded) {
          disconnected = true;
          controller.abort();
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        request.off("aborted", abortOnRequest);
        response.off("close", abortOnResponse);
        active.requestControllers.delete(controller);
      };
      request.once("aborted", abortOnRequest);
      response.once("close", abortOnResponse);
      active.requestControllers.add(controller);
      try {
        const upstream = await this.#fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${active.providerSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...upstreamBody, model: modelId }),
          signal: controller.signal,
        });
        return { kind: "response", upstream, controller, cleanup };
      } catch {
        cleanup();
        return { kind: "error", timedOut, disconnected };
      }
    };

    try {
      let attempt = await fetchAttempt(selectedModel);
      const primaryFallbackReason =
        attempt.kind === "error"
          ? attempt.timedOut && reservation.fallbackOnTimeout
            ? "timeout"
            : undefined
          : attempt.upstream.status === 429 && reservation.fallbackOnRateLimit
            ? "rate_limit"
            : attempt.upstream.status >= 500 && reservation.fallbackOnServerError
              ? "server_error"
              : undefined;
      if (primaryFallbackReason !== undefined && reservation.fallbackModelId !== undefined) {
        if (attempt.kind === "response") {
          await attempt.upstream.body?.cancel().catch(() => undefined);
          attempt.cleanup();
        }
        fallbackReason = primaryFallbackReason;
        selectedModel = reservation.fallbackModelId;
        selectedRate = reservation.fallbackRate!;
        attempt = await fetchAttempt(selectedModel);
      }
      if (attempt.kind === "error") {
        const code = attempt.disconnected
          ? "downstream_disconnected"
          : attempt.timedOut
            ? "upstream_timeout"
            : "upstream_network_error";
        await this.#failReservation(
          active,
          reservation,
          selectedModel,
          fallbackReason,
          code,
          null,
          attempt.disconnected ? "aborted" : "failed",
        );
        settled = true;
        throw new SafeGatewayHttpError(
          attempt.timedOut ? 504 : 502,
          code,
          attempt.timedOut ? "Model provider timed out" : "Model provider request failed",
        );
      }
      activeAttempt = attempt;
      const upstream = attempt.upstream;
      response.writeHead(upstream.status, {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        ...(upstream.headers.get("retry-after") === null
          ? {}
          : { "retry-after": upstream.headers.get("retry-after")! }),
      });
      if (upstream.body === null) {
        await this.#failReservation(
          active,
          reservation,
          selectedModel,
          fallbackReason,
          "upstream_empty_response",
          upstream.status,
          "failed",
        );
        settled = true;
        response.end();
        return;
      }
      const scanner = new StreamingUsageScanner();
      let usage: ModelUsage | undefined;
      let responseBytes = 0;
      for await (const rawChunk of upstream.body) {
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          attempt.controller.abort();
          throw new SafeGatewayHttpError(
            502,
            "response_too_large",
            "Model response exceeded the gateway limit",
          );
        }
        usage = scanner.feed(chunk) ?? usage;
        await writeChunk(response, chunk);
      }
      if (upstream.ok && usage !== undefined) {
        await this.#completeReservation(
          active,
          reservation,
          selectedModel,
          selectedRate,
          fallbackReason,
          usage,
          upstream.status,
        );
      } else {
        await this.#failReservation(
          active,
          reservation,
          selectedModel,
          fallbackReason,
          upstream.ok ? "usage_missing" : "upstream_http_error",
          upstream.status,
          "failed",
        );
      }
      settled = true;
      response.end();
    } catch (error: unknown) {
      if (!settled) {
        await this.#failReservation(
          active,
          reservation,
          selectedModel,
          fallbackReason,
          request.aborted ? "downstream_disconnected" : "stream_failed",
          null,
          request.aborted ? "aborted" : "failed",
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      activeAttempt?.cleanup();
    }
  }

  async #reserve(
    active: ActiveCapability,
    body: Record<string, unknown>,
    sampling: ModelSamplingIdentity,
  ): Promise<ModelReservation> {
    const now = validDate(this.#clock);
    const inputTokens = estimatedInputTokens(body);
    const outputTokens = positiveTokenLimit(body.max_tokens ?? body.max_completion_tokens, 8_192);
    const result = await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("model_requests")
        .set({
          state: "aborted",
          failure_code: "reservation_expired",
          settled_at: now,
        })
        .where("tenant_id", "=", active.tenantId)
        .where("state", "=", "reserved")
        .where("reservation_expires_at", "<=", now)
        .execute();

      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select([
          "maximum_model_requests_per_run",
          "maximum_cost_microusd_per_run",
          "daily_token_budget",
          "monthly_cost_microusd_budget",
        ])
        .where("tenant_id", "=", active.tenantId)
        .where("enabled", "=", true)
        .forUpdate()
        .executeTakeFirst();
      if (policy === undefined) {
        throw new SafeGatewayHttpError(403, "tenant_disabled", "Tenant runtime is disabled");
      }
      const assignment = await transaction
        .selectFrom("runs as run")
        .innerJoin("run_attempts as attempt", (join) =>
          join
            .onRef("attempt.tenant_id", "=", "run.tenant_id")
            .onRef("attempt.run_id", "=", "run.id")
            .onRef("attempt.id", "=", "run.current_attempt_id"),
        )
        .select(["run.state as runState", "attempt.state as attemptState"])
        .where("run.tenant_id", "=", active.tenantId)
        .where("run.id", "=", active.runId)
        .where("run.session_id", "=", active.sessionId)
        .where("run.turn_id", "=", active.turnId)
        .where("attempt.id", "=", active.attemptId)
        .executeTakeFirst();
      if (
        assignment === undefined ||
        !["provisioning", "restoring", "running"].includes(assignment.runState) ||
        !["provisioning", "restoring", "running"].includes(assignment.attemptState)
      ) {
        throw new SafeGatewayHttpError(
          409,
          "stale_run_attempt",
          "Model request Run Attempt is no longer current",
        );
      }

      const primaryRateRow = await transaction
        .selectFrom("model_rates")
        .select([
          "input_microusd_per_million",
          "output_microusd_per_million",
          "cache_read_microusd_per_million",
          "cache_write_microusd_per_million",
        ])
        .where("tenant_id", "=", active.tenantId)
        .where("provider", "=", active.provider)
        .where("model_id", "=", active.modelId)
        .executeTakeFirst();
      if (primaryRateRow === undefined) {
        throw new SafeGatewayHttpError(
          503,
          "model_rate_unconfigured",
          "Model rate configuration is unavailable",
        );
      }
      const primaryRate = rateFromRow(primaryRateRow);
      const route = await transaction
        .selectFrom("model_routing_policies")
        .selectAll()
        .where("tenant_id", "=", active.tenantId)
        .where("model_profile_id", "=", active.modelProfileId)
        .executeTakeFirst();
      let fallbackModelId: ActiveCapability["modelId"] | undefined;
      let fallbackRate: ModelRate | undefined;
      if (route?.enabled) {
        if (
          route.fallback_provider !== "deepseek" ||
          (route.fallback_model_id !== "deepseek-v4-flash" &&
            route.fallback_model_id !== "deepseek-v4-pro") ||
          route.fallback_model_id === active.modelId
        ) {
          throw new SafeGatewayHttpError(
            500,
            "model_route_invalid",
            "Model fallback route is invalid",
          );
        }
        fallbackModelId = route.fallback_model_id;
        const fallbackRateRow = await transaction
          .selectFrom("model_rates")
          .select([
            "input_microusd_per_million",
            "output_microusd_per_million",
            "cache_read_microusd_per_million",
            "cache_write_microusd_per_million",
          ])
          .where("tenant_id", "=", active.tenantId)
          .where("provider", "=", "deepseek")
          .where("model_id", "=", fallbackModelId)
          .executeTakeFirst();
        if (fallbackRateRow === undefined) {
          throw new SafeGatewayHttpError(
            503,
            "model_rate_unconfigured",
            "Fallback model rate configuration is unavailable",
          );
        }
        fallbackRate = rateFromRow(fallbackRateRow);
      }

      const aggregate = await sql<{
        request_count: string;
        run_cost: string;
        daily_tokens: string;
        monthly_cost: string;
        maximum_sequence: number | null;
      }>`
        select
          count(*) filter (where run_id = ${active.runId} and state <> 'budget_denied') as request_count,
          coalesce(sum(case when run_id = ${active.runId} then
            case when state = 'completed' then coalesce(actual_cost_microusd, 0)
            when state = 'reserved' and reservation_expires_at > ${now} then reserved_cost_microusd
            else 0 end else 0 end), 0) as run_cost,
          coalesce(sum(case when started_at >= ${utcDayStart(now)} then
            case when state = 'completed' then
              coalesce(actual_input_tokens, 0) + coalesce(actual_output_tokens, 0)
              + coalesce(actual_cache_read_tokens, 0) + coalesce(actual_cache_write_tokens, 0)
            when state = 'reserved' and reservation_expires_at > ${now} then
              reserved_input_tokens + reserved_output_tokens else 0 end
          else 0 end), 0) as daily_tokens,
          coalesce(sum(case when started_at >= ${utcMonthStart(now)} then
            case when state = 'completed' then coalesce(actual_cost_microusd, 0)
            when state = 'reserved' and reservation_expires_at > ${now} then reserved_cost_microusd
            else 0 end else 0 end), 0) as monthly_cost,
          max(request_sequence) filter (
            where run_id = ${active.runId} and attempt_id = ${active.attemptId}
          ) as maximum_sequence
        from model_requests where tenant_id = ${active.tenantId}
      `.execute(transaction);
      const totals = aggregate.rows[0]!;
      const sequence = (totals.maximum_sequence ?? 0) + 1;
      const primaryReservedCost = estimatedCost(inputTokens, outputTokens, primaryRate);
      const fallbackReservedCost =
        fallbackRate === undefined ? 0n : estimatedCost(inputTokens, outputTokens, fallbackRate);
      const reservedCost =
        primaryReservedCost > fallbackReservedCost ? primaryReservedCost : fallbackReservedCost;
      const requestLimit = Math.min(
        integer(policy.maximum_model_requests_per_run, "model request limit"),
        active.maximumRequestsPerRun,
      );
      const runCostLimit = Math.min(
        integer(policy.maximum_cost_microusd_per_run, "run cost limit"),
        active.maximumCostMicrousdPerRun ?? Number.MAX_SAFE_INTEGER,
      );
      const checks: readonly [boolean, string][] = [
        [
          integer(totals.request_count, "model request count") >= requestLimit,
          "model_request_limit",
        ],
        [
          bigInteger(totals.run_cost, "run cost usage") + reservedCost > BigInt(runCostLimit),
          "run_cost_budget",
        ],
        [
          bigInteger(totals.daily_tokens, "daily token usage") +
            BigInt(inputTokens + outputTokens) >
            bigInteger(policy.daily_token_budget, "daily token budget"),
          "daily_token_budget",
        ],
        [
          bigInteger(totals.monthly_cost, "monthly cost usage") + reservedCost >
            bigInteger(policy.monthly_cost_microusd_budget, "monthly cost budget"),
          "monthly_cost_budget",
        ],
      ];
      const denial = checks.find(([denied]) => denied)?.[1];
      const id = this.#idGenerator();
      const reservationExpiresAt = new Date(
        now.valueOf() + this.#upstreamRequestTimeoutMs * 2 + 60_000,
      );
      await transaction
        .insertInto("model_requests")
        .values({
          id,
          tenant_id: active.tenantId,
          session_id: active.sessionId,
          turn_id: active.turnId,
          run_id: active.runId,
          attempt_id: active.attemptId,
          model_profile_id: active.modelProfileId,
          request_sequence: sequence,
          step_context_sequence: sampling.stepSequence,
          step_context_sha256: sampling.stepSha256,
          sampling_attempt: sampling.samplingAttempt,
          requested_provider: active.provider,
          requested_model_id: active.modelId,
          actual_provider: null,
          actual_model_id: null,
          state: denial === undefined ? "reserved" : "budget_denied",
          fallback_reason: null,
          reserved_input_tokens: inputTokens,
          reserved_output_tokens: outputTokens,
          reserved_cost_microusd: reservedCost.toString(),
          actual_input_tokens: null,
          actual_output_tokens: null,
          actual_cache_read_tokens: null,
          actual_cache_write_tokens: null,
          actual_input_microusd_per_million: null,
          actual_output_microusd_per_million: null,
          actual_cache_read_microusd_per_million: null,
          actual_cache_write_microusd_per_million: null,
          actual_cost_microusd: null,
          upstream_status: null,
          failure_code: denial ?? null,
          reservation_expires_at: reservationExpiresAt,
          started_at: now,
          settled_at: denial === undefined ? null : now,
        })
        .executeTakeFirstOrThrow();
      return {
        denial,
        reservation: {
          id,
          sequence,
          requestedModelId: active.modelId,
          fallbackModelId,
          fallbackOnRateLimit: route?.fallback_on_rate_limit ?? false,
          fallbackOnServerError: route?.fallback_on_server_error ?? false,
          fallbackOnTimeout: route?.fallback_on_timeout ?? false,
          reservedInputTokens: inputTokens,
          reservedOutputTokens: outputTokens,
          primaryRate,
          fallbackRate,
        } satisfies ModelReservation,
      };
    });
    if (result.denial !== undefined) {
      throw new SafeGatewayHttpError(429, result.denial, "Model budget was exceeded");
    }
    return result.reservation;
  }

  async #completeReservation(
    active: ActiveCapability,
    reservation: ModelReservation,
    modelId: ActiveCapability["modelId"],
    rate: ModelRate,
    fallbackReason: string | undefined,
    usage: ModelUsage,
    upstreamStatus: number,
  ): Promise<void> {
    const now = validDate(this.#clock);
    const cost = actualCost(usage, rate);
    await this.#database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable("model_requests")
        .set({
          state: "completed",
          actual_provider: active.provider,
          actual_model_id: modelId,
          fallback_reason: fallbackReason ?? null,
          actual_input_tokens: usage.inputTokens,
          actual_output_tokens: usage.outputTokens,
          actual_cache_read_tokens: usage.cacheReadTokens,
          actual_cache_write_tokens: usage.cacheWriteTokens,
          actual_input_microusd_per_million: rate.input.toString(),
          actual_output_microusd_per_million: rate.output.toString(),
          actual_cache_read_microusd_per_million: rate.cacheRead.toString(),
          actual_cache_write_microusd_per_million: rate.cacheWrite.toString(),
          actual_cost_microusd: cost.toString(),
          upstream_status: upstreamStatus,
          failure_code: null,
          settled_at: now,
        })
        .where("id", "=", reservation.id)
        .where("tenant_id", "=", active.tenantId)
        .where("state", "=", "reserved")
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new SafeGatewayHttpError(
          409,
          "reservation_stale",
          "Model reservation is no longer active",
        );
      }
      await transaction
        .insertInto("usage_ledger")
        .values({
          id: this.#idGenerator(),
          tenant_id: active.tenantId,
          session_id: active.sessionId,
          turn_id: active.turnId,
          run_id: active.runId,
          attempt_id: active.attemptId,
          model_request_id: reservation.id,
          model_profile_id: active.modelProfileId,
          provider: active.provider,
          model_id: modelId,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          cost_microusd: cost.toString(),
          cost_amount: decimalDollars(cost),
          created_at: now,
        })
        .executeTakeFirstOrThrow();
    });
    this.#metrics?.modelTokens.inc(
      { provider: active.provider, model: modelId, kind: "input" },
      usage.inputTokens,
    );
    this.#metrics?.modelTokens.inc(
      { provider: active.provider, model: modelId, kind: "output" },
      usage.outputTokens,
    );
    this.#metrics?.modelTokens.inc(
      { provider: active.provider, model: modelId, kind: "cache_read" },
      usage.cacheReadTokens,
    );
    this.#metrics?.modelTokens.inc(
      { provider: active.provider, model: modelId, kind: "cache_write" },
      usage.cacheWriteTokens,
    );
    this.#metrics?.modelCostMicrousd.inc(
      { provider: active.provider, model: modelId },
      Number(cost),
    );
  }

  async #failReservation(
    active: ActiveCapability,
    reservation: ModelReservation,
    modelId: ActiveCapability["modelId"],
    fallbackReason: string | undefined,
    failureCode: string,
    upstreamStatus: number | null,
    state: "failed" | "aborted",
  ): Promise<void> {
    await this.#database
      .updateTable("model_requests")
      .set({
        state,
        actual_provider: active.provider,
        actual_model_id: modelId,
        fallback_reason: fallbackReason ?? null,
        upstream_status: upstreamStatus,
        failure_code: failureCode,
        settled_at: validDate(this.#clock),
      })
      .where("id", "=", reservation.id)
      .where("tenant_id", "=", active.tenantId)
      .where("state", "=", "reserved")
      .execute();
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
