import {
  parseToolSandboxOperationRequest,
  parseToolWorkerInput,
  parseToolWorkerOutput,
  type EnvironmentToolchainReport,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationResponse,
  type ToolWorkerInput,
  type ToolWorkerOutput,
} from "@pi-cloud/protocol";
import { captureWorkspaceIndex } from "@pi-cloud/workspace-runtime";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { RecoverableOperationLedger } from "./recoverable-operation-ledger.ts";

const SERVICE_PORT = 49_984;
const MAXIMUM_REQUEST_BYTES = 8 * 1_024 * 1_024;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const TOOL_UID = 1_000;
const TOOL_GID = 1_000;
const HANDOFF_SECRET_PATTERN = /^pcch_[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_TERMINAL_INPUT_BYTES = 64 * 1_024;

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
  supervisorUid: number;
  supervisorGid: number;
};

type HandoffAuthority = {
  secret: string;
  fencingToken: number;
  bindingSha256: string;
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

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(request: IncomingMessage): HandoffAuthority {
  const secret = singleHeader(request, "x-pi-cloud-handoff-secret");
  const rawFence = singleHeader(request, "x-pi-cloud-fencing-token");
  const bindingSha256 = singleHeader(request, "x-pi-cloud-binding-sha256");
  const fencingToken = rawFence === undefined ? Number.NaN : Number(rawFence);
  if (
    secret === undefined ||
    !HANDOFF_SECRET_PATTERN.test(secret) ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1 ||
    bindingSha256 === undefined ||
    !SHA256_PATTERN.test(bindingSha256)
  ) {
    throw new CubeToolServiceError(403, "Tool authority was invalid");
  }
  return { secret, fencingToken, bindingSha256 };
}

function sameAuthority(left: HandoffAuthority, right: HandoffAuthority): boolean {
  return (
    timingSafeEqual(
      createHash("sha256").update(left.secret).digest(),
      createHash("sha256").update(right.secret).digest(),
    ) &&
    left.fencingToken === right.fencingToken &&
    left.bindingSha256 === right.bindingSha256
  );
}

function parseRebind(value: unknown): HandoffAuthority & { activationId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CubeToolServiceError(400, "Tool rebind was invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4 ||
    typeof input.handoffSecret !== "string" ||
    !HANDOFF_SECRET_PATTERN.test(input.handoffSecret) ||
    !Number.isSafeInteger(input.fencingToken) ||
    (input.fencingToken as number) < 1 ||
    typeof input.bindingSha256 !== "string" ||
    !SHA256_PATTERN.test(input.bindingSha256) ||
    typeof input.activationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.activationId,
    )
  ) {
    throw new CubeToolServiceError(400, "Tool rebind was invalid");
  }
  return {
    secret: input.handoffSecret,
    fencingToken: input.fencingToken as number,
    bindingSha256: input.bindingSha256,
    activationId: input.activationId,
  };
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
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const failure =
    error instanceof CubeToolServiceError
      ? error
      : new CubeToolServiceError(500, "Cube Tool service request failed");
  sendJson(response, failure.statusCode, { error: failure.message });
}

function terminalSize(value: unknown): Readonly<{ rows: number; cols: number }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CubeToolServiceError(400, "Terminal size was invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Number.isSafeInteger(input.rows) ||
    !Number.isSafeInteger(input.cols) ||
    (input.rows as number) < 2 ||
    (input.rows as number) > 500 ||
    (input.cols as number) < 2 ||
    (input.cols as number) > 1_000
  ) {
    throw new CubeToolServiceError(400, "Terminal size was invalid");
  }
  return { rows: input.rows as number, cols: input.cols as number };
}

function terminalInput(value: unknown): Buffer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CubeToolServiceError(400, "Terminal input was invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    typeof input.data !== "string" ||
    input.data.length < 1 ||
    input.data.length > Math.ceil((MAXIMUM_TERMINAL_INPUT_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)
  ) {
    throw new CubeToolServiceError(400, "Terminal input was invalid");
  }
  const decoded = Buffer.from(input.data, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > MAXIMUM_TERMINAL_INPUT_BYTES ||
    decoded.toString("base64") !== input.data
  ) {
    throw new CubeToolServiceError(400, "Terminal input was invalid");
  }
  return decoded;
}

function sendTerminalFrame(response: ServerResponse, value: unknown): boolean {
  return response.write(`${JSON.stringify(value)}\n`, "utf8");
}

async function descendantPtyDevice(rootPid: number): Promise<string | undefined> {
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0 && visited.size < 128) {
    const pid = pending.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => undefined);
    const commandEnd = stat?.lastIndexOf(")") ?? -1;
    const fields =
      commandEnd < 1
        ? []
        : stat!
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/);
    const signedDevice = Number(fields[4]);
    if (Number.isSafeInteger(signedDevice) && signedDevice !== 0) {
      const encodedDevice = signedDevice < 0 ? signedDevice + 2 ** 32 : signedDevice;
      const major = Math.floor(encodedDevice / 256) & 0xfff;
      const minor = (encodedDevice & 0xff) | (Math.floor(encodedDevice / 4_096) & 0xfff00);
      if (major >= 136 && major <= 143) {
        return `/dev/pts/${String((major - 136) * 256 + minor)}`;
      }
    }
    const children = await readFile(
      `/proc/${String(pid)}/task/${String(pid)}/children`,
      "utf8",
    ).catch(() => "");
    pending.push(
      ...children
        .trim()
        .split(/\s+/)
        .filter((value) => /^[1-9][0-9]*$/.test(value))
        .map(Number),
    );
  }
  return undefined;
}

function resizeToolPty(
  device: string,
  size: Readonly<{ rows: number; cols: number }>,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "/bin/stty",
      ["-F", device, "rows", String(size.rows), "cols", String(size.cols)],
      {
        timeout: 5_000,
        maxBuffer: 8 * 1_024,
        uid: TOOL_UID,
        gid: TOOL_GID,
      },
      (error) => {
        if (error) rejectPromise(new CubeToolServiceError(409, "Terminal resize failed"));
        else resolvePromise();
      },
    );
  });
}

class CubeTerminalSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #response: ServerResponse;
  #closing: Promise<void> | undefined;
  #ttyDevice: string | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, response: ServerResponse) {
    this.#child = child;
    this.#response = response;
  }

  static async open(
    response: ServerResponse,
    size: Readonly<{ rows: number; cols: number }>,
  ): Promise<CubeTerminalSession> {
    const command = `stty rows ${String(size.rows)} cols ${String(size.cols)} 2>/dev/null; exec /bin/bash -i -l`;
    const child = spawn("/usr/bin/script", ["-qfec", command, "/dev/null"], {
      cwd: "/workspace",
      detached: true,
      env: {
        HOME: "/tmp/pi-cloud-tool-home",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
      uid: TOOL_UID,
      gid: TOOL_GID,
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", rejectPromise);
    });
    const session = new CubeTerminalSession(child, response);
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    sendTerminalFrame(response, { type: "ready", pid: child.pid });
    const forward = (chunk: Buffer): void => {
      if (response.destroyed) return;
      if (!sendTerminalFrame(response, { type: "output", data: chunk.toString("base64") })) {
        child.stdout.pause();
        child.stderr.pause();
        response.once("drain", () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.once("exit", (code, signal) => {
      if (!response.destroyed) {
        sendTerminalFrame(response, {
          type: "exit",
          exitCode: code,
          signal,
        });
        response.end();
      }
    });
    response.once("close", () => void session.close());
    return session;
  }

  get pid(): number {
    return this.#child.pid!;
  }

  async sendInput(data: Buffer): Promise<void> {
    if (this.#closing !== undefined || !this.#child.stdin.writable) {
      throw new CubeToolServiceError(409, "Terminal was not writable");
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#child.stdin.write(data, (error) => {
        if (error) rejectPromise(new CubeToolServiceError(409, "Terminal input failed"));
        else resolvePromise();
      });
    });
  }

  async resize(size: Readonly<{ rows: number; cols: number }>): Promise<void> {
    for (let attempt = 0; attempt < 10 && this.#ttyDevice === undefined; attempt += 1) {
      this.#ttyDevice = await descendantPtyDevice(this.pid);
      if (this.#ttyDevice === undefined) await delay(20);
    }
    if (this.#ttyDevice === undefined) {
      throw new CubeToolServiceError(409, "Terminal PTY was unavailable");
    }
    await resizeToolPty(this.#ttyDevice, size);
    process.kill(-this.pid, "SIGWINCH");
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#child.stdin.destroy();
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        try {
          process.kill(-this.pid, "SIGTERM");
        } catch {
          // The process group already exited.
        }
        await Promise.race([
          new Promise<void>((resolvePromise) => this.#child.once("exit", resolvePromise)),
          delay(250),
        ]);
      }
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        try {
          process.kill(-this.pid, "SIGKILL");
        } catch {
          // The process group already exited.
        }
      }
      if (!this.#response.destroyed && !this.#response.writableEnded) this.#response.end();
    })();
    return this.#closing;
  }
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

async function runtimeEvidence(workerPid: number | undefined): Promise<CubeRuntimeEvidence> {
  if (workerPid === undefined) {
    throw new CubeToolServiceError(503, "Cube Tool Worker was not running");
  }
  const [imageRevision, kernel, cpuInfo, memory, processStatus, mountInfo] = await Promise.all([
    exec("/bin/cat", ["/opt/pi-cloud/image-revision"]),
    exec("/bin/uname", ["-r"]),
    exec("/bin/sh", ["-c", "cat /proc/cpuinfo"]),
    exec("/bin/sh", ["-c", "cat /proc/meminfo"]),
    readFile(`/proc/${String(workerPid)}/status`, "utf8"),
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
    uid: Number(processStatus.match(/^Uid:\s+\d+\s+(\d+)\s+/m)?.[1] ?? -1),
    gid: Number(processStatus.match(/^Gid:\s+\d+\s+(\d+)\s+/m)?.[1] ?? -1),
    hypervisorFlag: /(?:^|\s)(?:flags|Features)\s*:.*(?:^|\s)hypervisor(?:\s|$)/m.test(cpuInfo),
    noNewPrivileges,
    effectiveCapabilities: capabilities,
    readOnlyRootFilesystem: rootMount[5]?.split(",").includes("ro") ?? false,
    supervisorUid: process.getuid?.() ?? -1,
    supervisorGid: process.getgid?.() ?? -1,
  };
}

class ToolWorkerBridge {
  readonly #child: ChildProcessWithoutNullStreams;
  #activationId: string | undefined;
  #ready: Pending<EnvironmentToolchainReport> | undefined;
  readonly #operationWaiters = new Map<string, Pending<ToolSandboxOperationResponse>>();
  readonly #operationLedger = new RecoverableOperationLedger<
    ReturnType<typeof parseToolSandboxOperationRequest>,
    ToolSandboxOperationResponse
  >();
  readonly #captures = new Map<string, Pending<CubeCapturedWorkspace>>();
  #failed: Error | undefined;

  constructor() {
    const workerPath = fileURLToPath(new URL("./tool-worker.ts", import.meta.url));
    this.#child = spawn(process.execPath, [workerPath], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      uid: TOOL_UID,
      gid: TOOL_GID,
    });
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#acceptLine(line));
    this.#child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.#child.once("error", () => this.#fail(new Error("Tool Worker could not start")));
    this.#child.once("exit", () => this.#fail(new Error("Tool Worker exited")));
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get busy(): boolean {
    return this.#ready !== undefined || this.#operationWaiters.size > 0 || this.#captures.size > 0;
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
    return this.#operationLedger.attach(request.operationId, request, async () => {
      const result = deferred<ToolSandboxOperationResponse>("Tool operation");
      this.#operationWaiters.set(request.operationId, result.pending);
      const release = (): void => {
        this.#operationWaiters.delete(request.operationId);
      };
      void result.promise.then(release, release);
      try {
        await this.#write({
          toolWorkerProtocolVersion: 1,
          type: "worker.operation",
          request,
        });
        return await result.promise;
      } catch (error: unknown) {
        result.pending.reject(
          error instanceof Error ? error : new CubeToolServiceError(503, "Tool operation failed"),
        );
        throw error;
      }
    });
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
    await Promise.race([
      new Promise<void>((resolve) => this.#child.once("exit", () => resolve())),
      delay(500),
    ]);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => this.#child.once("exit", () => resolve())),
        delay(500),
      ]);
    }
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
      this.#operationWaiters.get(output.response.operationId)?.resolve(output.response);
      return;
    }
    if (output.type === "worker.captured") {
      this.#captures.get(output.requestId)?.resolve({
        toolBrokerProtocolVersion: 1,
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
      this.#operationWaiters.get(output.operationId)?.reject(error);
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
    for (const pending of this.#operationWaiters.values()) pending.reject(error);
    for (const pending of this.#captures.values()) pending.reject(error);
    this.#operationWaiters.clear();
    this.#operationLedger.close();
    this.#captures.clear();
  }
}

async function toolProcessIds(): Promise<number[]> {
  const entries = await readdir("/proc");
  const output: number[] = [];
  await Promise.all(
    entries
      .filter((entry) => /^[1-9][0-9]*$/.test(entry))
      .map(async (entry) => {
        const pid = Number(entry);
        const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => undefined);
        const uid = status?.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
        if (
          Number.isSafeInteger(pid) &&
          uid != null &&
          uid.slice(1).some((value) => Number(value) === TOOL_UID)
        ) {
          output.push(pid);
        }
      }),
  );
  return output.sort((left, right) => left - right);
}

type FrozenToolProcess = Readonly<{
  pid: number;
  startTime: string;
}>;

async function processStartTime(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 1) return undefined;
  // /proc/<pid>/stat field 3 starts after the closing command parenthesis.
  // starttime is field 22, therefore index 19 in this remainder.
  const startTime = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19];
  return startTime !== undefined && /^[0-9]+$/.test(startTime) ? startTime : undefined;
}

async function processIsStopped(processIdentity: FrozenToolProcess): Promise<boolean> {
  if ((await processStartTime(processIdentity.pid)) !== processIdentity.startTime) return false;
  const status = await readFile(`/proc/${String(processIdentity.pid)}/status`, "utf8").catch(
    () => undefined,
  );
  return status !== undefined && /^State:\s+(?:T|t)\b/m.test(status);
}

async function resumeToolProcesses(processes: readonly FrozenToolProcess[]): Promise<number> {
  let resumed = 0;
  for (const processIdentity of processes) {
    if ((await processStartTime(processIdentity.pid)) !== processIdentity.startTime) continue;
    try {
      process.kill(processIdentity.pid, "SIGCONT");
      resumed += 1;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        throw error;
      }
    }
  }
  return resumed;
}

async function freezeToolProcesses(): Promise<readonly FrozenToolProcess[]> {
  const processes = (
    await Promise.all(
      (await toolProcessIds()).map(async (pid): Promise<FrozenToolProcess | undefined> => {
        const startTime = await processStartTime(pid);
        return startTime === undefined ? undefined : { pid, startTime };
      }),
    )
  ).filter((entry): entry is FrozenToolProcess => entry !== undefined);
  try {
    for (const processIdentity of processes) {
      if ((await processStartTime(processIdentity.pid)) !== processIdentity.startTime) continue;
      process.kill(processIdentity.pid, "SIGSTOP");
    }
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (
        (
          await Promise.all(
            processes.map(async (processIdentity) => processIsStopped(processIdentity)),
          )
        ).every(Boolean)
      ) {
        return Object.freeze(processes);
      }
      await delay(10);
    }
    throw new CubeToolServiceError(500, "Tool processes could not be quiesced");
  } catch (error: unknown) {
    await resumeToolProcesses(processes).catch(() => undefined);
    throw error;
  }
}

async function killAllToolProcesses(): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of await toolProcessIds()) {
      try {
        process.kill(pid, signal);
      } catch (error: unknown) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          throw error;
        }
      }
    }
    await delay(signal === "SIGTERM" ? 150 : 50);
  }
  if ((await toolProcessIds()).length > 0) {
    throw new CubeToolServiceError(500, "Tool processes could not be sealed");
  }
}

async function closeToolWorker(): Promise<void> {
  const current = readyBridge();
  if (current.busy) {
    throw new CubeToolServiceError(409, "Tool Worker was busy");
  }
  sealed = true;
  bridge = undefined;
  await current.close();
}

async function sealToolBoundary(): Promise<void> {
  await closeToolWorker();
  await killAllToolProcesses();
}

async function prepareCheckpointBoundary(): Promise<readonly FrozenToolProcess[]> {
  await closeToolWorker();
  const processes = await freezeToolProcesses();
  checkpointFrozenProcesses = processes;
  return processes;
}

type InitializedToolState = {
  activationId: string;
  environment: Extract<ToolWorkerInput, { type: "worker.initialize" }>["environment"];
  workspaceSeed: Extract<ToolWorkerInput, { type: "worker.initialize" }>["workspaceSeed"];
  webProxy: Extract<ToolWorkerInput, { type: "worker.initialize" }>["webProxy"];
  toolchain: EnvironmentToolchainReport;
};

let bridge: ToolWorkerBridge | undefined = new ToolWorkerBridge();
let authority: HandoffAuthority | undefined;
let initialized: InitializedToolState | undefined;
let sealed = false;
let checkpointFrozenProcesses: readonly FrozenToolProcess[] | undefined;
let activeTerminal: CubeTerminalSession | undefined;

function requireAuthority(request: IncomingMessage): HandoffAuthority {
  const candidate = parseAuthority(request);
  if (authority === undefined || !sameAuthority(candidate, authority)) {
    throw new CubeToolServiceError(403, "Tool authority did not match");
  }
  return candidate;
}

function readyBridge(): ToolWorkerBridge {
  if (sealed || bridge === undefined || initialized === undefined) {
    throw new CubeToolServiceError(409, "Cube Tool service was sealed");
  }
  return bridge;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://cube-tool.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/evidence") {
      sendJson(response, 200, await runtimeEvidence(bridge?.pid));
      return;
    }
    if (request.method !== "POST") {
      throw new CubeToolServiceError(404, "Cube Tool service route was not found");
    }
    if (url.pathname === "/v1/initialize") {
      if (authority !== undefined || initialized !== undefined || sealed) {
        throw new CubeToolServiceError(409, "Cube Tool service was already initialized");
      }
      const initialAuthority = parseAuthority(request);
      const input = parseToolWorkerInput(await readJson(request));
      if (input.type !== "worker.initialize") {
        throw new CubeToolServiceError(400, "Initialization message was invalid");
      }
      const toolchain = await readyBridgeForInitialization().initialize(input);
      authority = initialAuthority;
      initialized = {
        activationId: input.activationId,
        environment: input.environment,
        workspaceSeed: input.workspaceSeed,
        webProxy: input.webProxy,
        toolchain,
      };
      sendJson(response, 200, toolchain);
      return;
    }
    if (url.pathname === "/v1/operation") {
      requireAuthority(request);
      if (activeTerminal !== undefined) {
        throw new CubeToolServiceError(409, "A human terminal owns the Workspace writer");
      }
      const operation = parseToolSandboxOperationRequest(await readJson(request));
      // The execution is owned by operationId and the active handoff fence.
      // Losing this HTTP response leaves it attachable for a bounded window.
      sendJson(response, 200, await readyBridge().operation(operation));
      return;
    }
    if (url.pathname === "/v1/terminal/open") {
      requireAuthority(request);
      const current = readyBridge();
      if (activeTerminal !== undefined || current.busy) {
        throw new CubeToolServiceError(409, "Workspace terminal was already active");
      }
      const body = await readJson(request);
      const size = terminalSize(body);
      const opened = await CubeTerminalSession.open(response, size);
      activeTerminal = opened;
      response.once("close", () => {
        if (activeTerminal === opened) activeTerminal = undefined;
      });
      return;
    }
    if (url.pathname === "/v1/terminal/input") {
      requireAuthority(request);
      const current = activeTerminal;
      if (current === undefined) {
        throw new CubeToolServiceError(409, "Workspace terminal was not active");
      }
      await current.sendInput(terminalInput(await readJson(request)));
      sendJson(response, 200, { accepted: true });
      return;
    }
    if (url.pathname === "/v1/terminal/resize") {
      requireAuthority(request);
      const current = activeTerminal;
      if (current === undefined) {
        throw new CubeToolServiceError(409, "Workspace terminal was not active");
      }
      await current.resize(terminalSize(await readJson(request)));
      sendJson(response, 200, { resized: true });
      return;
    }
    if (url.pathname === "/v1/terminal/close") {
      requireAuthority(request);
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw new CubeToolServiceError(400, "Workspace terminal close was invalid");
      }
      const current = activeTerminal;
      activeTerminal = undefined;
      await current?.close();
      sendJson(response, 200, { closed: true });
      return;
    }
    if (url.pathname === "/v1/cancel") {
      requireAuthority(request);
      const input = parseToolWorkerInput({
        toolWorkerProtocolVersion: 1,
        type: "worker.cancel",
        ...((await readJson(request)) as object),
      });
      if (input.type !== "worker.cancel") {
        throw new CubeToolServiceError(400, "Tool cancellation was invalid");
      }
      await readyBridge().cancel(input.activationId, input.operationId);
      sendJson(response, 200, { cancelled: true });
      return;
    }
    if (url.pathname === "/v1/capture") {
      requireAuthority(request);
      const input = parseToolWorkerInput({
        toolWorkerProtocolVersion: 1,
        type: "worker.capture",
        ...((await readJson(request)) as object),
      });
      if (input.type !== "worker.capture") {
        throw new CubeToolServiceError(400, "Tool capture was invalid");
      }
      sendJson(response, 200, await readyBridge().capture(input.activationId, input.requestId));
      return;
    }
    if (url.pathname === "/v1/checkpoint") {
      const previous = requireAuthority(request);
      if (activeTerminal !== undefined) {
        throw new CubeToolServiceError(409, "Workspace terminal must close before checkpoint");
      }
      const body = await readJson(request);
      const recoverySecret =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).recoverySecret
          : undefined;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof recoverySecret !== "string" ||
        !HANDOFF_SECRET_PATTERN.test(recoverySecret) ||
        recoverySecret === previous.secret
      ) {
        throw new CubeToolServiceError(400, "Tool checkpoint request was invalid");
      }
      const frozenProcesses = await prepareCheckpointBoundary();
      try {
        // The trusted data mover snapshots the host-side POSIX mount while
        // these exact PID/start-time identities remain stopped.
        await exec("/bin/sync", ["-f", "/workspace"]);
        const workspaceIndex = await captureWorkspaceIndex("/workspace");
        authority = {
          ...previous,
          secret: recoverySecret,
        };
        sendJson(response, 200, {
          sealed: true,
          fencingToken: previous.fencingToken,
          frozenToolProcesses: frozenProcesses,
          files: workspaceIndex.files,
        });
      } catch (error: unknown) {
        checkpointFrozenProcesses = undefined;
        await resumeToolProcesses(frozenProcesses).catch(() => undefined);
        throw error;
      }
      return;
    }
    if (url.pathname === "/v1/checkpoint/complete") {
      requireAuthority(request);
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0 ||
        checkpointFrozenProcesses === undefined
      ) {
        throw new CubeToolServiceError(409, "Tool checkpoint completion was invalid");
      }
      const frozenProcesses = checkpointFrozenProcesses;
      checkpointFrozenProcesses = undefined;
      const resumedToolProcesses = await resumeToolProcesses(frozenProcesses);
      sendJson(response, 200, {
        completed: true,
        resumedToolProcesses,
      });
      return;
    }
    if (url.pathname === "/v1/seal") {
      requireAuthority(request);
      const terminal = activeTerminal;
      activeTerminal = undefined;
      await terminal?.close();
      await sealToolBoundary();
      sendJson(response, 200, {
        sealed: true,
        fencingToken: authority?.fencingToken,
        remainingToolProcesses: 0,
      });
      return;
    }
    if (url.pathname === "/v1/rebind") {
      const previous = requireAuthority(request);
      if (
        !sealed ||
        bridge !== undefined ||
        initialized === undefined ||
        checkpointFrozenProcesses !== undefined ||
        activeTerminal !== undefined
      ) {
        throw new CubeToolServiceError(409, "Cube Tool service was not sealed");
      }
      const next = parseRebind(await readJson(request));
      if (next.fencingToken <= previous.fencingToken || next.secret === previous.secret) {
        throw new CubeToolServiceError(409, "Tool rebind authority was stale");
      }
      const replacement = new ToolWorkerBridge();
      try {
        const toolchain = await replacement.initialize({
          toolWorkerProtocolVersion: 1,
          type: "worker.initialize",
          activationId: next.activationId,
          environment: initialized.environment,
          workspaceSeed: initialized.workspaceSeed,
          ...(initialized.webProxy === undefined ? {} : { webProxy: initialized.webProxy }),
          workspaceAttach: {
            recipeCommands: initialized.toolchain.recipeCommands,
          },
        });
        bridge = replacement;
        authority = {
          secret: next.secret,
          fencingToken: next.fencingToken,
          bindingSha256: next.bindingSha256,
        };
        initialized = { ...initialized, activationId: next.activationId, toolchain };
        sealed = false;
        sendJson(response, 200, {
          rebound: true,
          fencingToken: next.fencingToken,
          environment: toolchain,
        });
      } catch (error: unknown) {
        await replacement.close().catch(() => undefined);
        await killAllToolProcesses().catch(() => undefined);
        throw error;
      }
      return;
    }
    throw new CubeToolServiceError(404, "Cube Tool service route was not found");
  })().catch((error: unknown) => safeFailure(response, error));
});

function readyBridgeForInitialization(): ToolWorkerBridge {
  if (bridge === undefined || sealed) {
    throw new CubeToolServiceError(409, "Cube Tool service was unavailable");
  }
  return bridge;
}

server.listen(SERVICE_PORT, "0.0.0.0", () => {
  process.stdout.write(`PiCloud Cube Tool service ready on ${SERVICE_PORT}\n`);
});

let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= (async () => {
    const terminal = activeTerminal;
    activeTerminal = undefined;
    await terminal?.close().catch(() => undefined);
    const current = bridge;
    bridge = undefined;
    await current?.close().catch(() => undefined);
    if (checkpointFrozenProcesses !== undefined) {
      const frozenProcesses = checkpointFrozenProcesses;
      checkpointFrozenProcesses = undefined;
      await resumeToolProcesses(frozenProcesses).catch(() => undefined);
    }
    await killAllToolProcesses().catch(() => undefined);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  })();
  return closing;
}

process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
