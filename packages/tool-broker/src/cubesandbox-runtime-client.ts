import { Agent, buildConnector, fetch, type Dispatcher } from "undici";

export const CUBESANDBOX_TOOL_SERVICE_PORT = 49_984;
const MAXIMUM_TERMINAL_FRAME_BYTES = 256 * 1_024;

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

export type CubeSandboxVolume = Readonly<{
  volumeId: string;
  name: string;
}>;

export type CubeSandboxCreateInput = Readonly<{
  templateId: string;
  timeoutSeconds: number;
  metadata: Readonly<Record<string, string>>;
  allowInternetAccess: true;
  allowPublicTraffic: false;
  volumeMounts?: readonly Readonly<{ name: string; path: "/workspace" }>[];
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

export type CubeSandboxHandoffAuthority = NonNullable<CubeSandboxDataRequest["authority"]>;

export interface CubeSandboxRuntimeClient {
  checkHealth(): Promise<void>;
  ensureVolume(volumeId: string, driver: string): Promise<CubeSandboxVolume>;
  create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance>;
  read(sandboxId: string): Promise<CubeSandboxInstance | undefined>;
  list(): Promise<readonly CubeSandboxInstance[]>;
  destroy(sandboxId: string): Promise<void>;
  request(instance: CubeSandboxInstance, input: CubeSandboxDataRequest): Promise<unknown>;
  openTerminal(
    instance: CubeSandboxInstance,
    input: Readonly<{
      rows: number;
      cols: number;
      authority: CubeSandboxHandoffAuthority;
    }>,
  ): Promise<CubeSandboxTerminal>;
  close(): Promise<void>;
}

export interface CubeSandboxTerminal {
  readonly pid: number;
  readonly output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: Readonly<{ rows: number; cols: number }>): Promise<void>;
  kill(): Promise<void>;
  disconnect(): void;
}

export type OfficialCubeSandboxRuntimeClientOptions = Readonly<{
  apiUrl: string;
  apiKey: string;
  proxyNodeIp: string;
  proxyPort: number;
  proxyScheme: "http" | "https";
  sandboxDomain: string;
  egressProxyIp: string;
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

function parseVolume(value: unknown): CubeSandboxVolume {
  const candidate = record(value, "CubeSandbox volume");
  const volumeId = bounded(candidate.volumeID ?? candidate.volume_id, "CubeSandbox volume ID", 128);
  const name = bounded(candidate.name, "CubeSandbox volume name", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(volumeId) || !/^[A-Za-z0-9_-]+$/.test(name) || name !== volumeId) {
    throw new CubeRuntimeClientError("CubeSandbox volume identity was invalid");
  }
  return Object.freeze({ volumeId, name });
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

function errorResponseDiagnostic(bytes: Buffer): string {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).error === "string"
    ) {
      const value = (parsed as Record<string, unknown>).error as string;
      const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (normalized.length > 0) return normalized.slice(0, 512);
    }
  } catch {
    // The public response remains generic; trusted logs only need a bounded
    // marker when the remote service did not return its documented envelope.
  }
  return "unstructured error response";
}

async function* terminalFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.byteLength < 2 || line.byteLength > MAXIMUM_TERMINAL_FRAME_BYTES) {
          throw new CubeRuntimeClientError("CubeSandbox terminal frame exceeded its byte limit");
        }
        const value = parseJson(line, "CubeSandbox terminal frame");
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new CubeRuntimeClientError("CubeSandbox terminal frame was invalid");
        }
        yield value as Record<string, unknown>;
        newline = pending.indexOf(0x0a);
      }
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > 0) {
        if (pending.byteLength + next.value.byteLength > MAXIMUM_TERMINAL_FRAME_BYTES) {
          throw new CubeRuntimeClientError("CubeSandbox terminal stream buffer exceeded its limit");
        }
        pending = Buffer.concat([pending, Buffer.from(next.value)]);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (pending.byteLength !== 0) {
    throw new CubeRuntimeClientError("CubeSandbox terminal stream ended with a partial frame");
  }
}

function authorityHeaders(
  authority: CubeSandboxHandoffAuthority,
): Readonly<Record<string, string>> {
  return {
    "x-agent-dock-handoff-secret": authority.handoffSecret,
    "x-agent-dock-fencing-token": String(authority.fencingToken),
    "x-agent-dock-binding-sha256": authority.bindingSha256,
  };
}

function terminalSize(value: Readonly<{ rows: number; cols: number }>): Readonly<{
  rows: number;
  cols: number;
}> {
  if (
    !Number.isSafeInteger(value.rows) ||
    !Number.isSafeInteger(value.cols) ||
    value.rows < 2 ||
    value.rows > 500 ||
    value.cols < 2 ||
    value.cols > 1_000
  ) {
    throw new TypeError("CubeSandbox PTY size was invalid");
  }
  return { rows: value.rows, cols: value.cols };
}

export class OfficialCubeSandboxRuntimeClient implements CubeSandboxRuntimeClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #proxyScheme: "http" | "https";
  readonly #sandboxDomain: string;
  readonly #requestTimeoutMs: number;
  readonly #egressProxyIp: string;
  readonly #dispatcher: Dispatcher;

  constructor(options: OfficialCubeSandboxRuntimeClientOptions) {
    this.#apiUrl = validateApiUrl(options.apiUrl);
    this.#apiKey = bounded(options.apiKey, "CubeSandbox API key", 4_096);
    this.#proxyScheme = options.proxyScheme;
    const proxyPort = positiveInteger(options.proxyPort, 80, 1, 65_535);
    this.#sandboxDomain = validateHost(options.sandboxDomain, "CubeSandbox domain");
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000, 1_000, 300_000);
    this.#egressProxyIp = validateHost(options.egressProxyIp, "CubeSandbox egress proxy IP");
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
            port: String(proxyPort),
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

  async ensureVolume(volumeId: string, driver: string): Promise<CubeSandboxVolume> {
    const id = bounded(volumeId, "CubeSandbox volume ID", 128);
    const selectedDriver = bounded(driver, "CubeSandbox volume driver", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(selectedDriver)) {
      throw new CubeRuntimeClientError("CubeSandbox volume request was invalid");
    }
    const encoded = encodeURIComponent(id);
    const existing = await this.#control(`/volumes/${encoded}`, {}, true);
    if (existing.status !== 404) {
      return parseVolume(
        parseJson(await readBoundedResponse(existing, 64 * 1_024), "CubeSandbox volume inspect"),
      );
    }
    await existing.body?.cancel().catch(() => undefined);
    try {
      const created = await this.#control("/volumes", {
        method: "POST",
        body: JSON.stringify({ name: id, driver: selectedDriver }),
      });
      return parseVolume(
        parseJson(await readBoundedResponse(created, 64 * 1_024), "CubeSandbox volume create"),
      );
    } catch (error: unknown) {
      // A competing activation may have created the same deterministic volume
      // after our read. Re-read and adopt only an exact identity.
      const raced = await this.#control(`/volumes/${encoded}`, {}, true);
      if (raced.status === 404) {
        await raced.body?.cancel().catch(() => undefined);
        throw error;
      }
      return parseVolume(
        parseJson(await readBoundedResponse(raced, 64 * 1_024), "CubeSandbox volume inspect"),
      );
    }
  }

  async create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance> {
    const response = await this.#control("/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        templateID: input.templateId,
        timeout: input.timeoutSeconds,
        metadata: input.metadata,
        ...(input.volumeMounts === undefined
          ? {}
          : {
              volumeMounts: input.volumeMounts.map((mount) => {
                if (!/^adw-[0-9a-f]{48}$/.test(mount.name) || mount.path !== "/workspace") {
                  throw new CubeRuntimeClientError("CubeSandbox volume mount was invalid");
                }
                return { name: mount.name, path: mount.path };
              }),
            }),
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          allowOut: [`${this.#egressProxyIp}/32`],
          denyOut: ["0.0.0.0/0"],
        },
        // AgentDock owns the shorter Session warm TTL and explicit destroy.
        // Cube's timeout is only the fail-safe orphan reaper. A timed-out VM
        // must not become an untracked paused guest because this provider no
        // longer reconnects physical runtimes across manager loss.
        lifecycle: { on_timeout: "kill", auto_resume: false },
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
        `CubeSandbox Tool service rejected the request with HTTP ${response.status}: ${errorResponseDiagnostic(bytes)}`,
        response.status,
      );
    }
    return parseJson(bytes, "CubeSandbox Tool service");
  }

  async openTerminal(
    instance: CubeSandboxInstance,
    input: Readonly<{
      rows: number;
      cols: number;
      authority: CubeSandboxHandoffAuthority;
    }>,
  ): Promise<CubeSandboxTerminal> {
    const size = terminalSize(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timeout.unref();
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.#dataFetch(
        instance,
        CUBESANDBOX_TOOL_SERVICE_PORT,
        "/v1/terminal/open",
        {
          headers: {
            "content-type": "application/json",
            ...authorityHeaders(input.authority),
          },
          body: Buffer.from(JSON.stringify(size), "utf8"),
          signal: controller.signal,
        },
      );
      if (!response.ok || response.body === null) {
        const bytes = await readBoundedResponse(response, 64 * 1_024);
        throw new CubeRuntimeClientError(
          `CubeSandbox PTY start failed with HTTP ${response.status}: ${errorResponseDiagnostic(bytes)}`,
          response.status,
        );
      }
      const events = terminalFrames(response.body as ReadableStream<Uint8Array>);
      const first = await events.next();
      const start = first.done ? undefined : first.value;
      if (
        typeof start !== "object" ||
        start === null ||
        start.type !== "ready" ||
        !Number.isSafeInteger(start.pid) ||
        (start.pid as number) < 1
      ) {
        throw new CubeRuntimeClientError("CubeSandbox PTY stream did not begin with a PID");
      }
      clearTimeout(timeout);
      const pid = start.pid as number;
      let disconnected = false;
      let consumed = false;
      const output: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: async function* () {
          if (consumed) {
            throw new CubeRuntimeClientError("CubeSandbox PTY output can only be consumed once");
          }
          consumed = true;
          try {
            for await (const event of events) {
              if (event.type === "output" && typeof event.data === "string") {
                const bytes = Buffer.from(event.data, "base64");
                if (bytes.byteLength > 64 * 1_024 || bytes.toString("base64") !== event.data) {
                  throw new CubeRuntimeClientError("CubeSandbox PTY output was invalid");
                }
                yield bytes;
              }
              if (event.type === "exit") return;
            }
          } catch (error: unknown) {
            if (!disconnected) throw error;
          }
        },
      };
      const unary = async (
        path: "/v1/terminal/input" | "/v1/terminal/resize" | "/v1/terminal/close",
        payload: unknown,
        allowAbsent = false,
      ): Promise<void> => {
        const result = await this.#dataFetch(instance, CUBESANDBOX_TOOL_SERVICE_PORT, path, {
          headers: {
            "content-type": "application/json",
            ...authorityHeaders(input.authority),
          },
          body: Buffer.from(JSON.stringify(payload), "utf8"),
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        const bytes = await readBoundedResponse(result, 64 * 1_024);
        if (!result.ok && !(allowAbsent && result.status === 409)) {
          throw new CubeRuntimeClientError(
            `CubeSandbox PTY request failed with HTTP ${result.status}: ${errorResponseDiagnostic(bytes)}`,
            result.status,
          );
        }
      };
      return Object.freeze({
        pid,
        output,
        sendInput: (data: Uint8Array) =>
          unary("/v1/terminal/input", { data: Buffer.from(data).toString("base64") }),
        resize: (next: Readonly<{ rows: number; cols: number }>) =>
          unary("/v1/terminal/resize", terminalSize(next)),
        kill: () => unary("/v1/terminal/close", {}, true),
        disconnect: () => {
          disconnected = true;
          controller.abort();
          void events.return(undefined).catch(() => undefined);
        },
      });
    } catch (error: unknown) {
      clearTimeout(timeout);
      controller.abort();
      if (error instanceof CubeRuntimeClientError) throw error;
      throw new CubeRuntimeClientError(
        `CubeSandbox PTY start failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async #dataFetch(
    instance: CubeSandboxInstance,
    port: number,
    path: string,
    input: Readonly<{
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
      signal: AbortSignal;
    }>,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const token = instance.trafficAccessToken;
    if (token === undefined) {
      throw new CubeRuntimeClientError("CubeSandbox private-ingress token was unavailable");
    }
    const host = `${String(port)}-${instance.sandboxId}.${instance.domain}`;
    return fetch(`${this.#proxyScheme}://${host}${path}`, {
      method: "POST",
      headers: {
        "e2b-traffic-access-token": token,
        "cube-traffic-access-token": token,
        ...input.headers,
      },
      body: Buffer.from(input.body),
      dispatcher: this.#dispatcher,
      signal: input.signal,
    });
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
