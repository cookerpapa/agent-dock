import {
  createAgentDockEventFactory,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { PiRpcAgentEventAdapter } from "./pi-rpc-agent-event-adapter.ts";

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
};

type ExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type PiModelRuntimeConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type PiRpcTurnRunnerOptions = {
  resolveModelRuntime: (
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ) => Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  resolveWorkspaceDirectory: (command: ExecuteTurnCommandMessage) => Promise<string> | string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  piRpcEntryPath?: string;
};

export type PiRpcTurnResult = {
  stopReason: string;
};

export type PiRpcEventPublisher = (message: EventPublishMessage) => Promise<void> | void;

export const PINNED_PI_CODING_AGENT_VERSION = "0.80.10";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_STDOUT_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;
const RUNTIME_API_KEY_ENV = "AGENT_DOCK_RUNTIME_API_KEY";

export class PiRpcTurnError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "PiRpcTurnError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Pi RPC clock must return a valid Date");
  }
  return value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new PiRpcTurnError("pi_timeout", `${label} timed out`, true));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function sanitizedEnvironment(apiKey: string, agentDirectory: string): NodeJS.ProcessEnv {
  const sensitiveName = /(api[_-]?key|token|secret|password|credential|auth)/i;
  const processInjectionName =
    /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|BASH_ENV|ENV|CDPATH)$/i;
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!sensitiveName.test(name) && !processInjectionName.test(name)) environment[name] = value;
  }
  environment.PI_CODING_AGENT_DIR = agentDirectory;
  environment.PI_OFFLINE = "1";
  environment.PI_TELEMETRY = "0";
  environment[RUNTIME_API_KEY_ENV] = apiKey;
  return environment;
}

function validateRuntimeConfig(
  command: ExecuteTurnCommandMessage,
  config: PiModelRuntimeConfig,
): PiModelRuntimeConfig {
  if (config.provider !== command.payload.model.provider) {
    throw new PiRpcTurnError(
      "model_binding_mismatch",
      "Resolved provider does not match the accepted turn",
      false,
    );
  }
  if (config.modelId !== command.payload.model.modelId) {
    throw new PiRpcTurnError(
      "model_binding_mismatch",
      "Resolved model does not match the accepted turn",
      false,
    );
  }
  if (config.apiKey.length === 0) {
    throw new PiRpcTurnError("credential_unavailable", "Model credential is unavailable", true);
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
  } catch {
    throw new PiRpcTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new PiRpcTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (command.payload.model.thinkingLevel !== "off" && config.reasoning !== true) {
    throw new PiRpcTurnError(
      "invalid_model_runtime",
      "The accepted thinking level is unsupported by the resolved model",
      false,
    );
  }
  return config;
}

function sendLine(child: ChildProcessWithoutNullStreams, message: JsonRecord): void {
  if (child.stdin.destroyed || !child.stdin.writable) {
    throw new PiRpcTurnError("pi_process_exit", "Pi RPC process is unavailable", true);
  }
  if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
    throw new PiRpcTurnError("pi_backpressure", "Pi RPC stdin is backpressured", true);
  }
}

function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") return;
      throw error;
    }
  }
  child.kill(signal);
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<ExitResult>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exitPromise;
    return;
  }
  child.stdin.end();
  try {
    await withTimeout(exitPromise, timeoutMs, "Pi clean shutdown");
    return;
  } catch {
    terminateProcessGroup(child, "SIGTERM");
  }
  try {
    await withTimeout(exitPromise, timeoutMs, "Pi SIGTERM shutdown");
    return;
  } catch {
    terminateProcessGroup(child, "SIGKILL");
    await withTimeout(exitPromise, timeoutMs, "Pi SIGKILL shutdown");
  }
}

function modelConfigJson(config: PiModelRuntimeConfig): string {
  return `${JSON.stringify(
    {
      providers: {
        [config.provider]: {
          baseUrl: config.baseUrl,
          api: config.api,
          apiKey: `$${RUNTIME_API_KEY_ENV}`,
          models: [
            {
              id: config.modelId,
              name: config.modelId,
              reasoning: config.reasoning ?? false,
              input: ["text"],
              contextWindow: config.contextWindow ?? 16_384,
              maxTokens: config.maxTokens ?? 1_024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function resolvePinnedPiRpcEntry(moduleUrl: string): string {
  const packageJson = findPackageJSON("@earendil-works/pi-coding-agent", moduleUrl);
  if (packageJson === undefined) {
    throw new PiRpcTurnError(
      "pi_installation_missing",
      "Pinned Pi RPC package is unavailable",
      false,
    );
  }
  return resolve(dirname(packageJson), "dist/rpc-entry.js");
}

export class PiRpcTurnRunner {
  readonly #options: PiRpcTurnRunnerOptions;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PiRpcTurnRunnerOptions) {
    this.#options = options;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#turnTimeoutMs = positiveInteger(
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "turnTimeoutMs",
    );
    this.#shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
  ): Promise<PiRpcTurnResult> {
    if (command.payload.input.kind !== "prompt") {
      throw new PiRpcTurnError(
        "unsupported_input",
        "This Pi RPC runner only supports prompt input",
        false,
      );
    }

    const runtimeConfig = validateRuntimeConfig(
      command,
      await this.#options.resolveModelRuntime(command.payload.model),
    );
    const workspaceDirectory = resolve(await this.#options.resolveWorkspaceDirectory(command));
    const workspaceStat = await stat(workspaceDirectory).catch(() => undefined);
    if (!workspaceStat?.isDirectory()) {
      throw new PiRpcTurnError("workspace_unavailable", "Workspace directory is unavailable", true);
    }

    const rpcEntry = this.#options.piRpcEntryPath ?? resolvePinnedPiRpcEntry(import.meta.url);
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-rpc-"));
    const agentDirectory = resolve(temporaryRoot, "agent");
    try {
      await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(agentDirectory, "models.json"), modelConfigJson(runtimeConfig), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw new PiRpcTurnError(
        "pi_runtime_setup_failed",
        "Unable to prepare the isolated Pi runtime",
        true,
      );
    }
    const child = spawn(
      process.execPath,
      [
        rpcEntry,
        "--provider",
        command.payload.model.provider,
        "--model",
        command.payload.model.modelId,
        "--thinking",
        command.payload.model.thinkingLevel,
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-tools",
      ],
      {
        cwd: workspaceDirectory,
        detached: process.platform !== "win32",
        env: sanitizedEnvironment(runtimeConfig.apiKey, agentDirectory),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const exitPromise = new Promise<ExitResult>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    const pendingRequests = new Map<string, PendingRequest>();
    const terminal = deferred<PiRpcTurnResult>();
    void terminal.promise.catch(() => undefined);
    const eventAdapter = new PiRpcAgentEventAdapter(
      createAgentDockEventFactory(
        {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          agentId: command.payload.agentId,
        },
        {
          initialSequence: command.payload.nextEventSeq - 1,
          clock: this.#clock,
          idGenerator: this.#idGenerator,
        },
      ),
      { inputKind: command.payload.input.kind },
    );
    let requestSequence = 0;
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let messageChain = Promise.resolve();
    let fatalError: Error | undefined;

    const fail = (error: Error): void => {
      if (fatalError !== undefined) return;
      fatalError = error;
      terminal.reject(error);
      for (const pending of pendingRequests.values()) pending.reject(error);
      pendingRequests.clear();
    };

    const publish = async (message: JsonRecord): Promise<void> => {
      if (message.type === "response") {
        const id = typeof message.id === "string" ? message.id : undefined;
        if (id === undefined) return;
        const pending = pendingRequests.get(id);
        if (pending === undefined) return;
        pendingRequests.delete(id);
        if (message.success === true) {
          pending.resolve(message);
        } else {
          pending.reject(
            new PiRpcTurnError("pi_command_rejected", "Pi rejected an RPC command", false),
          );
        }
        return;
      }
      if (message.type === "extension_error") {
        throw new PiRpcTurnError("pi_extension_error", "Pi extension failed", false);
      }
      if (message.type === "extension_ui_request") {
        throw new PiRpcTurnError(
          "pi_protocol_error",
          "Pi requested extension UI while extensions were disabled",
          false,
        );
      }

      const outcome = eventAdapter.adapt(message);
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "invalid") {
        throw new PiRpcTurnError("pi_protocol_error", outcome.reason, false);
      }
      const candidate = parseSupervisorToControlMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "event.publish",
        payload: {
          leaseId: command.payload.leaseId,
          fencingToken: command.payload.fencingToken,
          commandId: command.payload.commandId,
          event: outcome.event,
        },
      });
      if (candidate.type !== "event.publish") {
        throw new PiRpcTurnError("pi_protocol_error", "Pi event envelope was invalid", false);
      }
      await publishEvent(candidate);
      if (!outcome.terminal) return;
      if (outcome.event.type === "turn.completed") {
        terminal.resolve({ stopReason: outcome.event.payload.stopReason });
        return;
      }
      if (outcome.event.type === "turn.failed") {
        terminal.reject(
          new PiRpcTurnError(
            outcome.event.payload.code,
            outcome.event.payload.message,
            outcome.event.payload.retryable,
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      if (stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
        fail(
          new PiRpcTurnError("pi_protocol_error", "Pi RPC output exceeded its buffer limit", false),
        );
        return;
      }
      let newline = stdoutBuffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (line.length > 0) {
          messageChain = messageChain
            .then(async () => {
              let message: unknown;
              try {
                message = JSON.parse(line) as unknown;
              } catch {
                throw new PiRpcTurnError(
                  "pi_protocol_error",
                  "Pi RPC emitted malformed JSONL",
                  false,
                );
              }
              if (!isRecord(message)) {
                throw new PiRpcTurnError(
                  "pi_protocol_error",
                  "Pi RPC output was not a JSON object",
                  false,
                );
              }
              await publish(message);
            })
            .catch((error: unknown) => {
              fail(error instanceof Error ? error : new Error(String(error)));
            });
        }
        newline = stdoutBuffer.indexOf(0x0a);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.stdin.on("error", () => {
      fail(new PiRpcTurnError("pi_process_exit", "Pi RPC stdin failed", true));
    });
    child.once("error", () => {
      fail(new PiRpcTurnError("pi_process_start_failed", "Unable to start Pi RPC", true));
    });
    child.once("close", (code, signal) => {
      if (fatalError !== undefined) return;
      if (stdoutBuffer.toString("utf8").trim().length > 0) {
        fail(
          new PiRpcTurnError(
            "pi_protocol_error",
            "Pi RPC ended with an incomplete JSONL record",
            false,
          ),
        );
        return;
      }
      if (pendingRequests.size > 0 || code !== 0 || signal !== null) {
        fail(
          new PiRpcTurnError(
            "pi_process_exit",
            stderr.length > 0
              ? "Pi RPC exited unexpectedly with diagnostic output"
              : "Pi RPC exited unexpectedly",
            true,
          ),
        );
      }
    });

    const request = (type: string, fields: JsonRecord = {}): Promise<JsonRecord> => {
      requestSequence += 1;
      const id = `agent-dock-${requestSequence}`;
      const response = deferred<JsonRecord>();
      pendingRequests.set(id, response);
      try {
        sendLine(child, { id, type, ...fields });
      } catch (error: unknown) {
        pendingRequests.delete(id);
        response.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return withTimeout(response.promise, this.#requestTimeoutMs, `Pi RPC ${type}`);
    };

    try {
      await request("set_auto_retry", { enabled: false });
      const promptAck = request("prompt", { message: command.payload.input.text });
      await Promise.all([promptAck, withTimeout(terminal.promise, this.#turnTimeoutMs, "Pi turn")]);
      return await terminal.promise;
    } finally {
      await stopChild(child, exitPromise, this.#shutdownTimeoutMs).catch(() => undefined);
      await messageChain.catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
