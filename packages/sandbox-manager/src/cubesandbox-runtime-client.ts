import { Agent, buildConnector, fetch, type Dispatcher } from "undici";
import { setTimeout as delay } from "node:timers/promises";

export const CUBESANDBOX_TOOL_SERVICE_PORT = 49_984;

/**
 * Cube evaluates explicit allow entries before deny entries, so AgentDock
 * never supplies an allow list in full-public mode. Keep every non-public or
 * infrastructure-relevant IPv4 class explicit even when Cube also installs
 * part of this list as a built-in protection.
 */
export const CUBESANDBOX_BLOCKED_EGRESS_CIDRS = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const);

export type CubeSandboxInstance = Readonly<{
  sandboxId: string;
  templateId: string;
  state: string;
  domain: string;
  metadata: Readonly<Record<string, string>>;
  trafficAccessToken?: string;
  cpuCount?: number;
  memoryMB?: number;
}>;

export type CubeSandboxCreateInput = Readonly<{
  templateId: string;
  timeoutSeconds: number;
  metadata: Readonly<Record<string, string>>;
  allowInternetAccess: true;
  allowPublicTraffic: false;
}>;

export type CubeSandboxDataRequest = Readonly<{
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  maximumResponseBytes: number;
  authority?: Readonly<{
    handoffSecret: string;
    fencingToken: number;
    bindingSha256: string;
  }>;
}>;

export interface CubeSandboxRuntimeClient {
  checkHealth(): Promise<void>;
  create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance>;
  read(sandboxId: string): Promise<CubeSandboxInstance | undefined>;
  list(): Promise<readonly CubeSandboxInstance[]>;
  pause(instance: CubeSandboxInstance, timeoutMs?: number): Promise<CubeSandboxInstance>;
  connect(instance: CubeSandboxInstance, timeoutSeconds: number): Promise<CubeSandboxInstance>;
  destroy(sandboxId: string): Promise<void>;
  request(instance: CubeSandboxInstance, input: CubeSandboxDataRequest): Promise<unknown>;
  close(): Promise<void>;
}

export type OfficialCubeSandboxRuntimeClientOptions = Readonly<{
  apiUrl: string;
  apiKey: string;
  proxyNodeIp: string;
  proxyPort: number;
  proxyScheme: "http" | "https";
  sandboxDomain: string;
  requestTimeoutMs?: number;
}>;

class CubeRuntimeClientError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "CubeRuntimeClientError";
    this.statusCode = statusCode;
  }
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CubeRuntimeClientError(`${label} was invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CubeRuntimeClientError(`${label} response was invalid`);
  }
  return value as Record<string, unknown>;
}

function metadata(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return Object.freeze({});
  const candidate = record(value, "CubeSandbox metadata");
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(candidate)) {
    output[bounded(key, "CubeSandbox metadata key", 128)] = bounded(
      item,
      "CubeSandbox metadata value",
      1_024,
    );
  }
  return Object.freeze(output);
}

function validateHost(value: string, label: string): string {
  if (value.length < 1 || value.length > 253 || /[\u0000-\u0020\u007f/?#@:[\]]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseInstance(value: unknown, fallbackDomain: string): CubeSandboxInstance {
  const candidate = record(value, "CubeSandbox");
  const sandboxId = bounded(candidate.sandboxID, "CubeSandbox ID", 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/.test(sandboxId)) {
    throw new CubeRuntimeClientError("CubeSandbox ID was invalid");
  }
  const cpuCount =
    typeof candidate.cpuCount === "number" && Number.isSafeInteger(candidate.cpuCount)
      ? candidate.cpuCount
      : undefined;
  const memoryMB =
    typeof candidate.memoryMB === "number" && Number.isSafeInteger(candidate.memoryMB)
      ? candidate.memoryMB
      : undefined;
  return Object.freeze({
    sandboxId,
    templateId: bounded(candidate.templateID, "CubeSandbox template ID", 256),
    state: bounded(candidate.state ?? "running", "CubeSandbox state", 64),
    domain: validateHost(
      bounded(candidate.domain ?? fallbackDomain, "CubeSandbox domain", 253),
      "CubeSandbox domain",
    ),
    metadata: metadata(candidate.metadata),
    ...(typeof candidate.trafficAccessToken === "string"
      ? {
          trafficAccessToken: bounded(
            candidate.trafficAccessToken,
            "CubeSandbox traffic access token",
            4_096,
          ),
        }
      : {}),
    ...(cpuCount === undefined ? {} : { cpuCount }),
    ...(memoryMB === undefined ? {} : { memoryMB }),
  });
}

function validateApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("CubeSandbox API URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new TypeError("CubeSandbox API URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError("CubeSandbox runtime numeric configuration is invalid");
  }
  return candidate;
}

async function readBoundedResponse(
  response: Awaited<ReturnType<typeof fetch>>,
  maximumBytes: number,
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new CubeRuntimeClientError("CubeSandbox response exceeded its byte limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer, label: string): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CubeRuntimeClientError(`${label} response was not valid JSON`);
  }
}

export class OfficialCubeSandboxRuntimeClient implements CubeSandboxRuntimeClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #proxyScheme: "http" | "https";
  readonly #proxyPort: number;
  readonly #sandboxDomain: string;
  readonly #requestTimeoutMs: number;
  readonly #dispatcher: Dispatcher;

  constructor(options: OfficialCubeSandboxRuntimeClientOptions) {
    this.#apiUrl = validateApiUrl(options.apiUrl);
    this.#apiKey = bounded(options.apiKey, "CubeSandbox API key", 4_096);
    this.#proxyScheme = options.proxyScheme;
    this.#proxyPort = positiveInteger(options.proxyPort, 80, 1, 65_535);
    this.#sandboxDomain = validateHost(options.sandboxDomain, "CubeSandbox domain");
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000, 1_000, 300_000);
    const proxyNodeIp = validateHost(options.proxyNodeIp, "CubeSandbox proxy node IP");
    const baseConnect = buildConnector({ timeout: this.#requestTimeoutMs });
    this.#dispatcher = new Agent({
      connect(connection, callback) {
        const servername =
          (connection as { servername?: string }).servername ??
          (typeof connection.hostname === "string" ? connection.hostname : undefined);
        baseConnect(
          {
            ...connection,
            hostname: proxyNodeIp,
            port: String(options.proxyPort),
            ...(servername === undefined ? {} : { servername }),
          },
          callback,
        );
      },
    });
  }

  async checkHealth(): Promise<void> {
    const response = await this.#control("/health");
    await response.body?.cancel().catch(() => undefined);
  }

  async create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance> {
    const response = await this.#control("/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        templateID: input.templateId,
        timeout: input.timeoutSeconds,
        metadata: input.metadata,
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          denyOut: CUBESANDBOX_BLOCKED_EGRESS_CIDRS,
        },
        lifecycle: { on_timeout: "pause", auto_resume: false },
      }),
    });
    const instance = parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox create"),
      this.#sandboxDomain,
    );
    if (instance.trafficAccessToken === undefined) {
      await this.destroy(instance.sandboxId).catch(() => undefined);
      throw new CubeRuntimeClientError(
        "CubeSandbox did not return the required private-ingress token",
      );
    }
    return instance;
  }

  async read(sandboxId: string): Promise<CubeSandboxInstance | undefined> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}`, {}, true);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox inspect"),
      this.#sandboxDomain,
    );
  }

  async list(): Promise<readonly CubeSandboxInstance[]> {
    const response = await this.#control("/v2/sandboxes?limit=1000");
    const body = parseJson(
      await readBoundedResponse(response, 4 * 1_024 * 1_024),
      "CubeSandbox inventory",
    );
    const values = Array.isArray(body)
      ? body
      : Array.isArray((body as { sandboxes?: unknown })?.sandboxes)
        ? (body as { sandboxes: unknown[] }).sandboxes
        : undefined;
    if (values === undefined || values.length > 1_000) {
      throw new CubeRuntimeClientError("CubeSandbox inventory response was invalid");
    }
    return values.map((value) => parseInstance(value, this.#sandboxDomain));
  }

  async pause(instance: CubeSandboxInstance, timeoutMs = 30_000): Promise<CubeSandboxInstance> {
    const sandboxId = instance.sandboxId;
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}/pause`, { method: "POST" });
    await response.body?.cancel().catch(() => undefined);
    const deadline = Date.now() + positiveInteger(timeoutMs, 30_000, 1_000, 300_000);
    while (Date.now() < deadline) {
      const current = await this.read(sandboxId);
      if (current === undefined) {
        throw new CubeRuntimeClientError("CubeSandbox disappeared while pausing");
      }
      if (current.state === "paused") {
        return Object.freeze({
          ...current,
          ...(instance.trafficAccessToken === undefined
            ? {}
            : { trafficAccessToken: instance.trafficAccessToken }),
        });
      }
      if (current.state !== "running" && current.state !== "pausing") {
        throw new CubeRuntimeClientError("CubeSandbox entered an invalid pause state");
      }
      await delay(250);
    }
    throw new CubeRuntimeClientError("CubeSandbox pause did not converge");
  }

  async connect(
    instance: CubeSandboxInstance,
    timeoutSeconds: number,
  ): Promise<CubeSandboxInstance> {
    const id = encodeURIComponent(bounded(instance.sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}/connect`, {
      method: "POST",
      body: JSON.stringify({
        timeout: positiveInteger(timeoutSeconds, 900, 1, 24 * 60 * 60),
      }),
    });
    const connected = parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox connect"),
      this.#sandboxDomain,
    );
    if (connected.sandboxId !== instance.sandboxId) {
      throw new CubeRuntimeClientError("CubeSandbox connect returned the wrong identity");
    }
    return Object.freeze({
      ...connected,
      ...(instance.trafficAccessToken === undefined
        ? {}
        : { trafficAccessToken: instance.trafficAccessToken }),
    });
  }

  async destroy(sandboxId: string): Promise<void> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}`, { method: "DELETE" }, true);
    await response.body?.cancel().catch(() => undefined);
  }

  async request(instance: CubeSandboxInstance, input: CubeSandboxDataRequest): Promise<unknown> {
    const token = instance.trafficAccessToken;
    if (token === undefined) {
      throw new CubeRuntimeClientError("CubeSandbox private-ingress token was unavailable");
    }
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(input.path)) {
      throw new TypeError("CubeSandbox data path is invalid");
    }
    const host = `${CUBESANDBOX_TOOL_SERVICE_PORT}-${instance.sandboxId}.${instance.domain}`;
    const timeout = AbortSignal.timeout(positiveInteger(input.timeoutMs, 30_000, 100, 10 * 60_000));
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    const response = await fetch(`${this.#proxyScheme}://${host}${input.path}`, {
      method: input.method,
      headers: {
        "e2b-traffic-access-token": token,
        "cube-traffic-access-token": token,
        ...(input.authority === undefined
          ? {}
          : {
              "x-agent-dock-handoff-secret": input.authority.handoffSecret,
              "x-agent-dock-fencing-token": String(input.authority.fencingToken),
              "x-agent-dock-binding-sha256": input.authority.bindingSha256,
            }),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      dispatcher: this.#dispatcher,
      signal,
    });
    const bytes = await readBoundedResponse(response, input.maximumResponseBytes);
    if (!response.ok) {
      throw new CubeRuntimeClientError(
        `CubeSandbox Tool service rejected the request with HTTP ${response.status}`,
        response.status,
      );
    }
    return parseJson(bytes, "CubeSandbox Tool service");
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  async #control(
    path: string,
    init: { method?: "GET" | "POST" | "DELETE"; body?: string } = {},
    allowNotFound = false,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      await response.body?.cancel().catch(() => undefined);
      throw new CubeRuntimeClientError(
        `CubeSandbox API request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  }
}
