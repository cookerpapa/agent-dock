import {
  createAgentDockEventFactory,
  MAX_TOOL_OUTPUT_BYTES,
  parseSupervisorToControlMessage,
  type AgentDockEvent,
  type CancelTurnCommandMessage,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
  type WorkspacePatch,
} from "@agent-dock/protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  enabledTools?: readonly PiBuiltinToolName[];
  disableBuiltinTools?: boolean;
  trustedExtensionPaths?: readonly string[];
  trustedEnvironment?: Readonly<Record<string, string>>;
  collectWorkspacePatch?: () => Promise<WorkspacePatch | undefined> | WorkspacePatch | undefined;
  restorePiSession?: Uint8Array;
  onSettled?: (checkpoint: PiRpcSettledCheckpoint) => Promise<void> | void;
  persistToolOutputArtifact?: (output: PiRpcToolOutputCapture) => Promise<PiRpcToolOutputArtifact>;
};

export type PiRpcSettledCheckpoint = {
  piSession: Uint8Array;
};

export type PiRpcToolOutputCapture = {
  toolCallId: string;
  bytes: Uint8Array;
};

export type PiRpcToolOutputArtifact = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export type PiRpcTurnResult = {
  stopReason: string;
};

export type PiRpcCancellationSignal = {
  kind: "agent-dock.turn-cancellation";
  reason: CancelTurnCommandMessage["payload"]["reason"];
  gracePeriodMs: number;
};

export type PiRpcEventPublisher = (message: EventPublishMessage) => Promise<void> | void;

export const PINNED_PI_CODING_AGENT_VERSION = "0.80.10";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_STDOUT_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;
const RUNTIME_API_KEY_ENV = "AGENT_DOCK_RUNTIME_API_KEY";
const TOOL_OUTPUT_DIRECTORY_ENV = "AGENT_DOCK_TRUSTED_TOOL_OUTPUT_DIRECTORY";
const PI_BUILTIN_TOOL_NAMES = new Set<PiBuiltinToolName>([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

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

export class PiRpcTurnCancelledError extends PiRpcTurnError {
  readonly reason: PiRpcCancellationSignal["reason"];
  readonly forced: boolean;

  constructor(reason: PiRpcCancellationSignal["reason"], forced: boolean) {
    super("turn_cancelled", "Turn cancellation was confirmed", false);
    this.name = "PiRpcTurnCancelledError";
    this.reason = reason;
    this.forced = forced;
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

function sanitizedEnvironment(
  apiKey: string,
  agentDirectory: string,
  trustedEnvironment: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
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
  for (const [name, value] of Object.entries(trustedEnvironment ?? {})) {
    if (
      !/^AGENT_DOCK_TRUSTED_[A-Z0-9_]{1,96}$/.test(name) ||
      name === RUNTIME_API_KEY_ENV ||
      value.length < 1 ||
      value.length > 4_096 ||
      /[\r\n\0]/.test(value)
    ) {
      throw new TypeError("trustedEnvironment contains an invalid entry");
    }
    environment[name] = value;
  }
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

function processGroupExists(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === "win32" || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ESRCH") return false;
    if (isRecord(error) && error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) {
      throw new PiRpcTurnError("pi_process_tree_alive", "Pi process tree did not terminate", false);
    }
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 10);
      timer.unref();
    });
  }
}

async function stopCancelledChild(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<ExitResult>,
  timeoutMs: number,
): Promise<void> {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      await withTimeout(exitPromise, timeoutMs, "Pi cancellation shutdown");
    } catch {
      child.kill("SIGKILL");
      await withTimeout(exitPromise, timeoutMs, "Pi cancellation SIGKILL shutdown");
    }
    return;
  }

  if (processGroupExists(child)) terminateProcessGroup(child, "SIGTERM");
  await withTimeout(exitPromise, timeoutMs, "Pi cancellation SIGTERM shutdown").catch(
    () => undefined,
  );
  if (processGroupExists(child)) terminateProcessGroup(child, "SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await withTimeout(exitPromise, timeoutMs, "Pi cancellation SIGKILL shutdown");
  }
  await waitForProcessGroupExit(child, timeoutMs);
}

function cancellationSignal(value: unknown): PiRpcCancellationSignal {
  if (
    !isRecord(value) ||
    value.kind !== "agent-dock.turn-cancellation" ||
    (value.reason !== "user_request" &&
      value.reason !== "timeout" &&
      value.reason !== "lease_revoked" &&
      value.reason !== "shutdown") ||
    !Number.isSafeInteger(value.gracePeriodMs) ||
    (value.gracePeriodMs as number) < 0
  ) {
    throw new PiRpcTurnError("invalid_cancellation", "Turn cancellation signal was invalid", false);
  }
  return value as PiRpcCancellationSignal;
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

function settingsConfigJson(command: ExecuteTurnCommandMessage): string {
  const budgets = command.payload.budgets;
  return `${JSON.stringify(
    {
      compaction: {
        enabled: true,
        reserveTokens: budgets?.compactionReserveTokens ?? 16_384,
        keepRecentTokens: budgets?.compactionKeepRecentTokens ?? 20_000,
      },
      retry: { enabled: true },
      enableInstallTelemetry: false,
      enableAnalytics: false,
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
  readonly #enabledTools: readonly PiBuiltinToolName[];
  readonly #disableBuiltinTools: boolean;
  readonly #trustedExtensionPaths: readonly string[];

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
    const enabledTools = options.enabledTools ?? [];
    if (
      enabledTools.length > PI_BUILTIN_TOOL_NAMES.size ||
      new Set(enabledTools).size !== enabledTools.length ||
      enabledTools.some((tool) => !PI_BUILTIN_TOOL_NAMES.has(tool))
    ) {
      throw new TypeError("enabledTools must be a unique Pi built-in tool allowlist");
    }
    this.#enabledTools = [...enabledTools];
    this.#disableBuiltinTools = options.disableBuiltinTools ?? false;
    const trustedExtensionPaths = (options.trustedExtensionPaths ?? []).map((path) =>
      resolve(path),
    );
    if (
      trustedExtensionPaths.length > 8 ||
      new Set(trustedExtensionPaths).size !== trustedExtensionPaths.length
    ) {
      throw new TypeError("trustedExtensionPaths must be a unique bounded list");
    }
    this.#trustedExtensionPaths = trustedExtensionPaths;
    if (this.#disableBuiltinTools && this.#enabledTools.length !== 0) {
      throw new TypeError("disableBuiltinTools cannot be combined with enabledTools");
    }
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal?: AbortSignal,
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
    const sessionDirectory = resolve(temporaryRoot, "sessions");
    const sessionFile = resolve(sessionDirectory, "session.jsonl");
    const toolOutputDirectory = resolve(temporaryRoot, "tool-outputs");
    const persistSession =
      this.#options.restorePiSession !== undefined || this.#options.onSettled !== undefined;
    try {
      await Promise.all([
        mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
        mkdir(toolOutputDirectory, { recursive: true, mode: 0o700 }),
        ...(persistSession ? [mkdir(sessionDirectory, { recursive: true, mode: 0o700 })] : []),
      ]);
      await writeFile(resolve(agentDirectory, "models.json"), modelConfigJson(runtimeConfig), {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeFile(resolve(agentDirectory, "settings.json"), settingsConfigJson(command), {
        encoding: "utf8",
        mode: 0o600,
      });
      if (this.#options.restorePiSession !== undefined) {
        await writeFile(sessionFile, this.#options.restorePiSession, { mode: 0o600 });
      }
    } catch {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw new PiRpcTurnError(
        "pi_runtime_setup_failed",
        "Unable to prepare the isolated Pi runtime",
        true,
      );
    }
    const childEnvironment = sanitizedEnvironment(
      runtimeConfig.apiKey,
      agentDirectory,
      this.#options.trustedEnvironment,
    );
    childEnvironment[TOOL_OUTPUT_DIRECTORY_ENV] = toolOutputDirectory;
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
        ...(persistSession
          ? ["--session", sessionFile, "--session-dir", sessionDirectory]
          : ["--no-session"]),
        "--offline",
        "--no-extensions",
        ...this.#trustedExtensionPaths.flatMap((path) => ["--extension", path]),
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        ...(this.#disableBuiltinTools
          ? ["--no-builtin-tools"]
          : this.#enabledTools.length === 0
            ? ["--no-tools"]
            : ["--tools", this.#enabledTools.join(",")]),
      ],
      {
        cwd: workspaceDirectory,
        detached: process.platform !== "win32",
        env: childEnvironment,
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
      {
        inputKind: command.payload.input.kind,
        ...(command.payload.budgets === undefined
          ? {}
          : { maximumToolOutputBytes: command.payload.budgets.maximumToolOutputBytes }),
      },
    );
    let requestSequence = 0;
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let messageChain = Promise.resolve();
    let fatalError: Error | undefined;
    let cancellationEvent: EventPublishMessage | undefined;
    let cancellationError: PiRpcTurnCancelledError | undefined;
    let cancellationTask: Promise<void> | undefined;
    let removeAbortListener: (() => void) | undefined;

    const fail = (error: Error): void => {
      if (fatalError !== undefined) return;
      fatalError = error;
      terminal.reject(error);
      for (const pending of pendingRequests.values()) pending.reject(error);
      pendingRequests.clear();
    };

    const eventMessage = (event: AgentDockEvent): EventPublishMessage => {
      const candidate = parseSupervisorToControlMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "event.publish",
        payload: {
          leaseId: command.payload.leaseId,
          fencingToken: command.payload.fencingToken,
          commandId: command.payload.commandId,
          event,
        },
      });
      if (candidate.type !== "event.publish") {
        throw new PiRpcTurnError("pi_protocol_error", "Pi event envelope was invalid", false);
      }
      return candidate;
    };

    const settleCancellation = (
      error: PiRpcTurnCancelledError,
      event: EventPublishMessage,
    ): void => {
      if (cancellationError !== undefined) return;
      cancellationError = error;
      cancellationEvent = event;
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
          "Pi requested unsupported extension UI",
          false,
        );
      }

      const outcome = eventAdapter.adapt(message);
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "invalid") {
        throw new PiRpcTurnError("pi_protocol_error", outcome.reason, false);
      }
      let publicEvent = outcome.event;
      if (
        publicEvent.type === "tool.completed" &&
        this.#options.persistToolOutputArtifact !== undefined
      ) {
        const artifactPath = resolve(
          toolOutputDirectory,
          `${createHash("sha256")
            .update(publicEvent.payload.toolCallId, "utf8")
            .digest("hex")}.output`,
        );
        const metadata = await lstat(artifactPath).catch((error: unknown) => {
          if (isRecord(error) && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (metadata !== undefined) {
          if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.size > MAX_TOOL_OUTPUT_BYTES
          ) {
            throw new PiRpcTurnError(
              "tool_output_artifact_invalid",
              "Trusted tool output artifact was invalid",
              false,
            );
          }
          const bytes = await readFile(artifactPath);
          const outputArtifact = await this.#options.persistToolOutputArtifact({
            toolCallId: publicEvent.payload.toolCallId,
            bytes,
          });
          publicEvent = {
            ...publicEvent,
            payload: { ...publicEvent.payload, outputArtifact },
          };
        }
      }
      if (publicEvent.type === "turn.completed") {
        if (this.#options.onSettled) {
          let piSession: Uint8Array;
          try {
            piSession = await readFile(sessionFile);
          } catch {
            throw new PiRpcTurnError(
              "checkpoint_capture_failed",
              "Pi did not produce a readable settled session snapshot",
              true,
            );
          }
          await this.#options.onSettled({ piSession });
        }
        if (this.#options.collectWorkspacePatch) {
          const workspacePatch = await this.#options.collectWorkspacePatch();
          if (workspacePatch !== undefined) {
            publicEvent = {
              ...publicEvent,
              payload: { ...publicEvent.payload, workspacePatch },
            };
          }
        }
      }
      const candidate = eventMessage(publicEvent);
      if (publicEvent.type === "turn.cancelled") {
        settleCancellation(
          new PiRpcTurnCancelledError(publicEvent.payload.reason, publicEvent.payload.forced),
          candidate,
        );
        return;
      }
      await publishEvent(candidate);
      if (!outcome.terminal) return;
      if (publicEvent.type === "turn.completed") {
        terminal.resolve({ stopReason: publicEvent.payload.stopReason });
        return;
      }
      if (publicEvent.type === "turn.failed") {
        terminal.reject(
          new PiRpcTurnError(
            publicEvent.payload.code,
            publicEvent.payload.message,
            publicEvent.payload.retryable,
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

    let result: PiRpcTurnResult | undefined;
    let runError: unknown;
    let terminationError: unknown;
    try {
      await request("set_auto_retry", { enabled: false });
      const promptAck = request("prompt", { message: command.payload.input.text });
      if (signal !== undefined) {
        const beginCancellation = (): void => {
          if (cancellationTask !== undefined) return;
          cancellationTask = (async () => {
            const cancellation = cancellationSignal(signal.reason);
            eventAdapter.requestCancellation(cancellation.reason);
            void request("abort").catch(() => undefined);
            const observed = await Promise.race([
              terminal.promise.then(
                () => "other" as const,
                (error: unknown) =>
                  error instanceof PiRpcTurnCancelledError
                    ? ("cancelled" as const)
                    : ("other" as const),
              ),
              new Promise<"grace_expired">((resolvePromise) => {
                const timer = setTimeout(
                  () => resolvePromise("grace_expired"),
                  cancellation.gracePeriodMs,
                );
                timer.unref();
              }),
            ]);
            if (observed === "cancelled" || cancellationError !== undefined) return;
            const forced = eventAdapter.forceCancellation(cancellation.reason);
            if (forced.kind !== "mapped" || forced.event.type !== "turn.cancelled") {
              throw new PiRpcTurnError(
                "pi_protocol_error",
                "Pi cancellation did not create a terminal event",
                false,
              );
            }
            settleCancellation(
              new PiRpcTurnCancelledError(cancellation.reason, true),
              eventMessage(forced.event),
            );
          })().catch((error: unknown) => {
            fail(error instanceof Error ? error : new Error(String(error)));
          });
        };
        signal.addEventListener("abort", beginCancellation, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", beginCancellation);
        if (signal.aborted) beginCancellation();
      }
      await Promise.all([promptAck, withTimeout(terminal.promise, this.#turnTimeoutMs, "Pi turn")]);
      result = await terminal.promise;
    } catch (error: unknown) {
      runError = error;
    } finally {
      if (cancellationTask !== undefined) await cancellationTask.catch(() => undefined);
      if (cancellationError !== undefined) {
        try {
          await stopCancelledChild(child, exitPromise, this.#shutdownTimeoutMs);
        } catch (error: unknown) {
          terminationError = error;
        }
      } else {
        await stopChild(child, exitPromise, this.#shutdownTimeoutMs).catch(() => undefined);
      }
      await messageChain.catch(() => undefined);
      if (cancellationEvent !== undefined && terminationError === undefined) {
        try {
          await publishEvent(cancellationEvent);
        } catch (error: unknown) {
          terminationError = error;
        }
      }
      removeAbortListener?.();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    if (terminationError !== undefined) throw terminationError;
    if (cancellationError !== undefined) throw cancellationError;
    if (runError !== undefined) throw runError;
    if (result === undefined) {
      throw new PiRpcTurnError(
        "pi_protocol_error",
        "Pi turn ended without a terminal result",
        false,
      );
    }
    return result;
  }
}
