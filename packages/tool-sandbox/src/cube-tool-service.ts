import {
  parseToolSandboxOperationRequest,
  parseToolWorkerInput,
  parseToolWorkerOutput,
  type EnvironmentToolchainReport,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationResponse,
  type ToolWorkerInput,
  type ToolWorkerOutput,
} from "@agent-dock/protocol";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const SERVICE_PORT = 49_984;
const MAXIMUM_REQUEST_BYTES = 8 * 1_024 * 1_024;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

type Pending<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type CubeRuntimeEvidence = {
  imageRevision: string;
  kernelRelease: string;
  cpuCount: number;
  memoryBytes: number;
  uid: number;
  gid: number;
  hypervisorFlag: boolean;
  noNewPrivileges: boolean;
  effectiveCapabilities: string;
  readOnlyRootFilesystem: boolean;
};

type CubeCapturedWorkspace = Omit<
  Extract<ToolSandboxCaptureResponse, { type: "tool_sandbox.captured" }>,
  "environment"
>;

class CubeToolServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "CubeToolServiceError";
    this.statusCode = statusCode;
  }
}

function deferred<T>(label: string): { promise: Promise<T>; pending: Pending<T> } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(
    () => rejectPromise(new CubeToolServiceError(504, `${label} timed out`)),
    RESPONSE_TIMEOUT_MS,
  );
  timer.unref();
  return {
    promise,
    pending: {
      resolve(value): void {
        clearTimeout(timer);
        resolvePromise(value);
      },
      reject(error): void {
        clearTimeout(timer);
        rejectPromise(error);
      },
      timer,
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAXIMUM_REQUEST_BYTES) {
      throw new CubeToolServiceError(413, "Request body exceeded its byte limit");
    }
    chunks.push(value);
  }
  if (bytes === 0) throw new CubeToolServiceError(400, "Request body was missing");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new CubeToolServiceError(400, "Request body was not valid JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function safeFailure(response: ServerResponse, error: unknown): void {
  const failure =
    error instanceof CubeToolServiceError
      ? error
      : new CubeToolServiceError(500, "Cube Tool service request failed");
  sendJson(response, failure.statusCode, { error: failure.message });
}

function oneLine(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CubeToolServiceError(500, `${label} evidence was invalid`);
  }
  return normalized;
}

function exec(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1_024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function runtimeEvidence(): Promise<CubeRuntimeEvidence> {
  const [imageRevision, kernel, cpuInfo, memory, processStatus, mountInfo] = await Promise.all([
    exec("/bin/cat", ["/opt/agent-dock/image-revision"]),
    exec("/bin/uname", ["-r"]),
    exec("/bin/sh", ["-c", "cat /proc/cpuinfo"]),
    exec("/bin/sh", ["-c", "cat /proc/meminfo"]),
    exec("/bin/sh", ["-c", "cat /proc/self/status"]),
    exec("/bin/sh", ["-c", "cat /proc/self/mountinfo"]),
  ]);
  const cpuCount = cpuInfo.split("\n").filter((line) => /^processor\s*:/.test(line)).length;
  const memoryMatch = memory.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  const memoryBytes = Number(memoryMatch?.[1] ?? 0) * 1_024;
  if (
    !Number.isSafeInteger(cpuCount) ||
    cpuCount < 1 ||
    !Number.isSafeInteger(memoryBytes) ||
    memoryBytes < 128 * 1_024 * 1_024
  ) {
    throw new CubeToolServiceError(500, "Cube runtime resource evidence was invalid");
  }
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(processStatus);
  const capabilities = processStatus.match(/^CapEff:\s+([0-9a-fA-F]+)$/m)?.[1]?.toLowerCase();
  const rootMount = mountInfo
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[4] === "/");
  if (capabilities === undefined || rootMount === undefined) {
    throw new CubeToolServiceError(500, "Cube runtime process evidence was invalid");
  }
  return {
    imageRevision: oneLine(imageRevision, "Image revision"),
    kernelRelease: oneLine(kernel, "Kernel"),
    cpuCount,
    memoryBytes,
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    hypervisorFlag: /(?:^|\s)(?:flags|Features)\s*:.*(?:^|\s)hypervisor(?:\s|$)/m.test(cpuInfo),
    noNewPrivileges,
    effectiveCapabilities: capabilities,
    readOnlyRootFilesystem: rootMount[5]?.split(",").includes("ro") ?? false,
  };
}

class ToolWorkerBridge {
  readonly #child: ChildProcessWithoutNullStreams;
  #activationId: string | undefined;
  #ready: Pending<EnvironmentToolchainReport> | undefined;
  readonly #operations = new Map<string, Pending<ToolSandboxOperationResponse>>();
  readonly #captures = new Map<string, Pending<CubeCapturedWorkspace>>();
  #failed: Error | undefined;

  constructor() {
    const workerPath = fileURLToPath(new URL("./tool-worker.ts", import.meta.url));
    this.#child = spawn(process.execPath, [workerPath], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#acceptLine(line));
    this.#child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.#child.once("error", () => this.#fail(new Error("Tool Worker could not start")));
    this.#child.once("exit", () => this.#fail(new Error("Tool Worker exited")));
  }

  async initialize(message: ToolWorkerInput): Promise<EnvironmentToolchainReport> {
    if (message.type !== "worker.initialize") {
      throw new CubeToolServiceError(400, "Initialization message was invalid");
    }
    if (this.#activationId !== undefined || this.#ready !== undefined) {
      throw new CubeToolServiceError(409, "Cube Tool service was already initialized");
    }
    this.#activationId = message.activationId;
    const result = deferred<EnvironmentToolchainReport>("Tool Worker initialization");
    this.#ready = result.pending;
    await this.#write(message);
    return result.promise;
  }

  async operation(
    request: ReturnType<typeof parseToolSandboxOperationRequest>,
  ): Promise<ToolSandboxOperationResponse> {
    this.#assertActivation(request.activationId);
    if (this.#operations.has(request.operationId)) {
      throw new CubeToolServiceError(409, "Tool operation ID was already active");
    }
    const result = deferred<ToolSandboxOperationResponse>("Tool operation");
    this.#operations.set(request.operationId, result.pending);
    try {
      await this.#write({
        toolWorkerProtocolVersion: 1,
        type: "worker.operation",
        request,
      });
      return await result.promise;
    } finally {
      this.#operations.delete(request.operationId);
    }
  }

  async cancel(activationId: string, operationId: string): Promise<void> {
    this.#assertActivation(activationId);
    if (!/^[0-9a-f-]{36}$/.test(operationId)) {
      throw new CubeToolServiceError(400, "Tool operation ID was invalid");
    }
    await this.#write({
      toolWorkerProtocolVersion: 1,
      type: "worker.cancel",
      activationId,
      operationId,
    });
  }

  async capture(activationId: string, requestId: string): Promise<CubeCapturedWorkspace> {
    this.#assertActivation(activationId);
    if (!/^[0-9a-f-]{36}$/.test(requestId)) {
      throw new CubeToolServiceError(400, "Tool capture ID was invalid");
    }
    if (this.#captures.has(requestId)) {
      throw new CubeToolServiceError(409, "Tool capture ID was already active");
    }
    const result = deferred<CubeCapturedWorkspace>("Tool capture");
    this.#captures.set(requestId, result.pending);
    try {
      await this.#write({
        toolWorkerProtocolVersion: 1,
        type: "worker.capture",
        activationId,
        requestId,
      });
      return await result.promise;
    } finally {
      this.#captures.delete(requestId);
    }
  }

  async close(): Promise<void> {
    if (this.#activationId !== undefined && !this.#child.killed) {
      await this.#write({
        toolWorkerProtocolVersion: 1,
        type: "worker.shutdown",
        activationId: this.#activationId,
      }).catch(() => undefined);
    }
    this.#child.kill("SIGTERM");
  }

  async #write(message: ToolWorkerInput): Promise<void> {
    if (this.#failed !== undefined) throw this.#failed;
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new CubeToolServiceError(503, "Tool Worker input failed"));
        else resolve();
      });
    });
  }

  #assertActivation(activationId: string): void {
    if (this.#activationId === undefined || activationId !== this.#activationId) {
      throw new CubeToolServiceError(403, "Tool activation identity did not match");
    }
    if (this.#ready !== undefined) {
      throw new CubeToolServiceError(409, "Tool Worker was not ready");
    }
    if (this.#failed !== undefined) throw this.#failed;
  }

  #acceptLine(line: string): void {
    let output: ToolWorkerOutput;
    try {
      output = parseToolWorkerOutput(JSON.parse(line) as unknown);
    } catch {
      this.#fail(new Error("Tool Worker output was invalid"));
      return;
    }
    if (output.type === "worker.ready") {
      const pending = this.#ready;
      this.#ready = undefined;
      pending?.resolve(output.environment);
      return;
    }
    if (output.type === "worker.operation_result") {
      this.#operations.get(output.response.operationId)?.resolve(output.response);
      return;
    }
    if (output.type === "worker.captured") {
      this.#captures.get(output.requestId)?.resolve({
        managerProtocolVersion: 1,
        type: "tool_sandbox.captured",
        requestId: output.requestId,
        activationId: output.activationId,
        workspace: output.workspace,
        ...(output.workspacePatch === undefined ? {} : { workspacePatch: output.workspacePatch }),
      });
      return;
    }
    const error = new CubeToolServiceError(output.retryable ? 503 : 400, output.message);
    if (output.operationId !== undefined) {
      this.#operations.get(output.operationId)?.reject(error);
      return;
    }
    if (output.requestId !== undefined) {
      this.#captures.get(output.requestId)?.reject(error);
      return;
    }
    this.#fail(error);
  }

  #fail(error: Error): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    this.#ready?.reject(error);
    this.#ready = undefined;
    for (const pending of this.#operations.values()) pending.reject(error);
    for (const pending of this.#captures.values()) pending.reject(error);
    this.#operations.clear();
    this.#captures.clear();
  }
}

const bridge = new ToolWorkerBridge();
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://cube-tool.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/evidence") {
      sendJson(response, 200, await runtimeEvidence());
      return;
    }
    if (request.method !== "POST") {
      throw new CubeToolServiceError(404, "Cube Tool service route was not found");
    }
    if (url.pathname === "/v1/initialize") {
      const input = parseToolWorkerInput(await readJson(request));
      sendJson(response, 200, await bridge.initialize(input));
      return;
    }
    if (url.pathname === "/v1/operation") {
      const operation = parseToolSandboxOperationRequest(await readJson(request));
      const disconnected = (): void => {
        void bridge.cancel(operation.activationId, operation.operationId).catch(() => undefined);
      };
      request.once("aborted", disconnected);
      try {
        sendJson(response, 200, await bridge.operation(operation));
      } finally {
        request.removeListener("aborted", disconnected);
      }
      return;
    }
    if (url.pathname === "/v1/cancel") {
      const input = parseToolWorkerInput({
        toolWorkerProtocolVersion: 1,
        type: "worker.cancel",
        ...((await readJson(request)) as object),
      });
      if (input.type !== "worker.cancel") {
        throw new CubeToolServiceError(400, "Tool cancellation was invalid");
      }
      await bridge.cancel(input.activationId, input.operationId);
      sendJson(response, 200, { cancelled: true });
      return;
    }
    if (url.pathname === "/v1/capture") {
      const input = parseToolWorkerInput({
        toolWorkerProtocolVersion: 1,
        type: "worker.capture",
        ...((await readJson(request)) as object),
      });
      if (input.type !== "worker.capture") {
        throw new CubeToolServiceError(400, "Tool capture was invalid");
      }
      sendJson(response, 200, await bridge.capture(input.activationId, input.requestId));
      return;
    }
    throw new CubeToolServiceError(404, "Cube Tool service route was not found");
  })().catch((error: unknown) => safeFailure(response, error));
});

server.listen(SERVICE_PORT, "0.0.0.0", () => {
  process.stdout.write(`AgentDock Cube Tool service ready on ${SERVICE_PORT}\n`);
});

let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= bridge.close().finally(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return closing;
}

process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
