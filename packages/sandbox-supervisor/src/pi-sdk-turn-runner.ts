import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
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
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiRpcAgentEventAdapter } from "./pi-rpc-agent-event-adapter.ts";
import {
  PiRpcTurnCancelledError,
  PiRpcTurnError,
  type PiModelRuntimeConfig,
  type PiRpcCancellationSignal,
  type PiRpcEventPublisher,
  type PiRpcSettledCheckpoint,
  type PiRpcToolOutputArtifact,
  type PiRpcToolOutputCapture,
  type PiRpcTurnResult,
} from "./pi-rpc-turn-runner.ts";

type JsonRecord = Record<string, unknown>;

export type PiSdkTurnRunnerOptions = {
  resolveModelRuntime: (
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ) => Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  resolveWorkspaceDirectory: (command: ExecuteTurnCommandMessage) => Promise<string> | string;
  inlineExtensions?: readonly InlineExtension[];
  createInlineExtensions?: (context: { toolOutputDirectory: string }) => readonly InlineExtension[];
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  collectWorkspacePatch?: () => Promise<WorkspacePatch | undefined> | WorkspacePatch | undefined;
  restorePiSession?: Uint8Array;
  onSettled?: (checkpoint: PiRpcSettledCheckpoint) => Promise<void> | void;
  persistToolOutputArtifact?: (output: PiRpcToolOutputCapture) => Promise<PiRpcToolOutputArtifact>;
  onIsolationFailure?: (error: PiSdkIsolationFailure) => Promise<void> | void;
};

export class PiSdkIsolationFailure extends Error {
  readonly code = "pi_sdk_worker_poisoned";

  constructor(message: string) {
    super(message);
    this.name = "PiSdkIsolationFailure";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const TEXT_DELTA_COALESCE_WINDOW_MS = 50;
const TEXT_DELTA_COALESCE_BYTES = 2 * 1_024;

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
    throw new TypeError("Pi SDK clock must return a valid Date");
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
    timer.unref();
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

function validateRuntimeConfig(
  command: ExecuteTurnCommandMessage,
  config: PiModelRuntimeConfig,
): PiModelRuntimeConfig {
  if (
    config.provider !== command.payload.model.provider ||
    config.modelId !== command.payload.model.modelId
  ) {
    throw new PiRpcTurnError(
      "model_binding_mismatch",
      "Resolved model runtime does not match the accepted turn",
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

function streamedTextDelta(
  value: unknown,
): { event: AgentSessionEvent; delta: string; contentIndex: number | undefined } | undefined {
  if (!isRecord(value) || value.type !== "message_update") return undefined;
  const streamEvent = value.assistantMessageEvent;
  if (
    !isRecord(streamEvent) ||
    streamEvent.type !== "text_delta" ||
    typeof streamEvent.delta !== "string"
  ) {
    return undefined;
  }
  return {
    event: value as AgentSessionEvent,
    delta: streamEvent.delta,
    contentIndex: Number.isSafeInteger(streamEvent.contentIndex)
      ? (streamEvent.contentIndex as number)
      : undefined,
  };
}

function coalescedTextEvent(current: AgentSessionEvent, delta: string): AgentSessionEvent {
  const message = current as unknown as JsonRecord;
  const streamEvent = message.assistantMessageEvent as JsonRecord;
  return {
    ...message,
    assistantMessageEvent: { ...streamEvent, delta },
  } as unknown as AgentSessionEvent;
}

async function createModelRuntime(
  config: PiModelRuntimeConfig,
  authPath: string,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerProvider(config.provider, {
    name: config.provider,
    baseUrl: config.baseUrl,
    api: config.api,
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
  });
  await runtime.setRuntimeApiKey(config.provider, config.apiKey);
  return runtime;
}

export class PiSdkTurnRunner {
  readonly #options: PiSdkTurnRunnerOptions;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PiSdkTurnRunnerOptions) {
    if (options.inlineExtensions !== undefined && options.createInlineExtensions !== undefined) {
      throw new TypeError("Pi SDK extensions must use one configuration source");
    }
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
    signal?: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    if (command.payload.input.kind !== "prompt") {
      throw new PiRpcTurnError(
        "unsupported_input",
        "This Pi SDK runner only supports prompt input",
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

    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-sdk-"));
    const agentDirectory = resolve(temporaryRoot, "agent");
    const sessionDirectory = resolve(temporaryRoot, "sessions");
    const sessionFile = resolve(sessionDirectory, "session.jsonl");
    const toolOutputDirectory = resolve(temporaryRoot, "tool-outputs");
    const persistSession =
      this.#options.restorePiSession !== undefined || this.#options.onSettled !== undefined;
    await Promise.all([
      mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
      mkdir(toolOutputDirectory, { recursive: true, mode: 0o700 }),
      ...(persistSession ? [mkdir(sessionDirectory, { recursive: true, mode: 0o700 })] : []),
    ]);
    if (this.#options.restorePiSession !== undefined) {
      await writeFile(sessionFile, this.#options.restorePiSession, { mode: 0o600 });
    }

    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let pendingTextEvent: AgentSessionEvent | undefined;
    let pendingTextBytes = 0;
    let pendingTextTimer: NodeJS.Timeout | undefined;
    let emitNextTextImmediately = true;
    let eventChain = Promise.resolve();
    let fatalError: Error | undefined;
    let cancellationError: PiRpcTurnCancelledError | undefined;
    let cancellationEvent: EventPublishMessage | undefined;
    let cancellationTask: Promise<void> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let isolationFailure: PiSdkIsolationFailure | undefined;
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

    const fail = (error: Error): void => {
      if (fatalError !== undefined) return;
      fatalError = error;
      terminal.reject(error);
      void runtime?.session.abort().catch(() => undefined);
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
    };

    const publish = async (sourceEvent: AgentSessionEvent): Promise<void> => {
      const outcome = eventAdapter.adapt(sourceEvent);
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
        if (this.#options.onSettled !== undefined) {
          const persistedSessionFile = runtime?.session.sessionFile;
          const piSession =
            persistedSessionFile === undefined
              ? undefined
              : await readFile(persistedSessionFile).catch(() => undefined);
          if (piSession === undefined) {
            throw new PiRpcTurnError(
              "checkpoint_capture_failed",
              "Pi did not produce a readable settled session snapshot",
              true,
            );
          }
          await this.#options.onSettled({ piSession });
        }
        if (this.#options.collectWorkspacePatch !== undefined) {
          const workspacePatch = await this.#options.collectWorkspacePatch();
          if (workspacePatch !== undefined) {
            publicEvent = {
              ...publicEvent,
              payload: { ...publicEvent.payload, workspacePatch },
            };
          }
        }
      }
      const envelope = eventMessage(publicEvent);
      if (publicEvent.type === "turn.cancelled") {
        settleCancellation(
          new PiRpcTurnCancelledError(publicEvent.payload.reason, publicEvent.payload.forced),
          envelope,
        );
        return;
      }
      await publishEvent(envelope);
      if (!outcome.terminal) return;
      if (publicEvent.type === "turn.completed") {
        terminal.resolve({ stopReason: publicEvent.payload.stopReason });
      } else if (publicEvent.type === "turn.failed") {
        terminal.reject(
          new PiRpcTurnError(
            publicEvent.payload.code,
            publicEvent.payload.message,
            publicEvent.payload.retryable,
          ),
        );
      }
    };

    const enqueue = (event: AgentSessionEvent): void => {
      eventChain = eventChain
        .then(() => publish(event))
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
    };
    const flushPendingText = (): void => {
      if (pendingTextTimer !== undefined) {
        clearTimeout(pendingTextTimer);
        pendingTextTimer = undefined;
      }
      if (pendingTextEvent === undefined) return;
      const event = pendingTextEvent;
      pendingTextEvent = undefined;
      pendingTextBytes = 0;
      enqueue(event);
    };
    const queueEvent = (event: AgentSessionEvent): void => {
      const text = streamedTextDelta(event);
      if (text === undefined) {
        flushPendingText();
        emitNextTextImmediately = true;
        enqueue(event);
        return;
      }
      if (emitNextTextImmediately) {
        emitNextTextImmediately = false;
        enqueue(event);
        return;
      }
      const pending =
        pendingTextEvent === undefined ? undefined : streamedTextDelta(pendingTextEvent);
      if (pending !== undefined && pending.contentIndex === text.contentIndex) {
        const combined = `${pending.delta}${text.delta}`;
        pendingTextEvent = coalescedTextEvent(event, combined);
        pendingTextBytes = Buffer.byteLength(combined, "utf8");
      } else {
        flushPendingText();
        pendingTextEvent = event;
        pendingTextBytes = Buffer.byteLength(text.delta, "utf8");
      }
      if (pendingTextBytes >= TEXT_DELTA_COALESCE_BYTES) {
        flushPendingText();
      } else if (pendingTextTimer === undefined) {
        pendingTextTimer = setTimeout(flushPendingText, TEXT_DELTA_COALESCE_WINDOW_MS);
        pendingTextTimer.unref();
      }
    };

    let result: PiRpcTurnResult | undefined;
    let runError: unknown;
    try {
      const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
        const modelRuntime = await createModelRuntime(
          runtimeConfig,
          resolve(agentDirectory, "auth.json"),
        );
        const settingsManager = SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: command.payload.budgets?.compactionReserveTokens ?? 16_384,
            keepRecentTokens: command.payload.budgets?.compactionKeepRecentTokens ?? 20_000,
          },
          retry: { enabled: false },
          enableInstallTelemetry: false,
          enableAnalytics: false,
        });
        const services = await createAgentSessionServices({
          cwd: runtimeOptions.cwd,
          agentDir: runtimeOptions.agentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: {
            extensionFactories: [
              ...(this.#options.inlineExtensions ??
                this.#options.createInlineExtensions?.({ toolOutputDirectory }) ??
                []),
            ],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
          },
        });
        const model = services.modelRuntime.getModel(runtimeConfig.provider, runtimeConfig.modelId);
        if (model === undefined) {
          throw new PiRpcTurnError(
            "invalid_model_runtime",
            "Configured model is unavailable",
            false,
          );
        }
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: runtimeOptions.sessionManager,
          ...(runtimeOptions.sessionStartEvent === undefined
            ? {}
            : { sessionStartEvent: runtimeOptions.sessionStartEvent }),
          model,
          thinkingLevel: command.payload.model.thinkingLevel,
          noTools: "builtin",
        });
        return { ...created, services, diagnostics: services.diagnostics };
      };
      const sessionManager =
        this.#options.restorePiSession === undefined
          ? SessionManager.create(workspaceDirectory, sessionDirectory)
          : SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory);
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: workspaceDirectory,
        agentDir: agentDirectory,
        sessionManager,
        sessionStartEvent: {
          type: "session_start",
          reason: this.#options.restorePiSession === undefined ? "startup" : "resume",
        },
      });
      const extensionErrors: ExtensionError[] = [];
      await runtime.session.bindExtensions({
        mode: "rpc",
        onError: (error) => {
          extensionErrors.push(error);
          fail(new PiRpcTurnError("pi_extension_error", "Pi extension failed", false));
        },
      });
      unsubscribe = runtime.session.subscribe(queueEvent);

      const beginCancellation = (candidate: unknown): void => {
        if (cancellationTask !== undefined) return;
        cancellationTask = (async () => {
          const cancellation = cancellationSignal(candidate);
          eventAdapter.requestCancellation(cancellation.reason);
          const abort = runtime!.session.abort();
          const observed = await Promise.race([
            terminal.promise.then(
              () => "other" as const,
              (error: unknown) =>
                error instanceof PiRpcTurnCancelledError
                  ? ("cancelled" as const)
                  : ("other" as const),
            ),
            abort.then(
              () => "abort_returned" as const,
              () => "abort_returned" as const,
            ),
            new Promise<"grace_expired">((resolvePromise) => {
              const timer = setTimeout(
                () => resolvePromise("grace_expired"),
                cancellation.gracePeriodMs,
              );
              timer.unref();
            }),
          ]);
          if (
            observed === "cancelled" ||
            cancellationError !== undefined ||
            fatalError !== undefined
          ) {
            return;
          }
          if (observed === "abort_returned") {
            await eventChain;
            if (cancellationError !== undefined || fatalError !== undefined) return;
          }
          const forced = eventAdapter.forceCancellation(cancellation.reason);
          if (forced.kind !== "mapped" || forced.event.type !== "turn.cancelled") {
            throw new PiRpcTurnError(
              "pi_protocol_error",
              "Pi SDK cancellation did not create a terminal event",
              false,
            );
          }
          isolationFailure = new PiSdkIsolationFailure(
            "Pi SDK did not settle within the cancellation grace period",
          );
          settleCancellation(
            new PiRpcTurnCancelledError(cancellation.reason, true),
            eventMessage(forced.event),
          );
        })().catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      if (signal !== undefined) {
        const listener = (): void => beginCancellation(signal.reason);
        signal.addEventListener("abort", listener, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", listener);
        if (signal.aborted) listener();
      }
      const turnTimer = setTimeout(() => {
        beginCancellation({
          kind: "agent-dock.turn-cancellation",
          reason: "timeout",
          gracePeriodMs: this.#shutdownTimeoutMs,
        });
      }, this.#turnTimeoutMs);
      turnTimer.unref();
      try {
        await runtime.session.prompt(command.payload.input.text, { source: "rpc" });
        if (extensionErrors.length > 0) {
          throw new PiRpcTurnError("pi_extension_error", "Pi extension failed", false);
        }
        flushPendingText();
        await eventChain;
        result = await withTimeout(terminal.promise, this.#requestTimeoutMs, "Pi SDK settlement");
      } finally {
        clearTimeout(turnTimer);
      }
    } catch (error: unknown) {
      runError = error;
    } finally {
      if (cancellationTask !== undefined) await cancellationTask.catch(() => undefined);
      flushPendingText();
      await eventChain.catch(() => undefined);
      if (cancellationEvent !== undefined) {
        try {
          await publishEvent(cancellationEvent);
        } catch (error: unknown) {
          runError ??= error;
        }
      }
      removeAbortListener?.();
      unsubscribe?.();
      if (runtime !== undefined) {
        await withTimeout(runtime.dispose(), this.#shutdownTimeoutMs, "Pi SDK dispose").catch(
          () => {
            isolationFailure ??= new PiSdkIsolationFailure(
              "Pi SDK runtime did not dispose within its shutdown deadline",
            );
          },
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
      if (isolationFailure !== undefined && this.#options.onIsolationFailure !== undefined) {
        await this.#options.onIsolationFailure(isolationFailure);
      }
    }
    if (cancellationError !== undefined) throw cancellationError;
    if (runError !== undefined) throw runError;
    if (fatalError !== undefined) throw fatalError;
    if (result === undefined) {
      throw new PiRpcTurnError(
        "pi_protocol_error",
        "Pi SDK turn ended without a terminal result",
        false,
      );
    }
    return result;
  }
}
