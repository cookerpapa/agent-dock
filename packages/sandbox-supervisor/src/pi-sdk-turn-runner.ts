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
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
  type WorkspacePatch,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { appendPiInterruption } from "./pi-interrupted-session.ts";
import { appendPiDurableRecovery } from "./pi-durable-recovery.ts";
import { PiStepWorldStateController, type PiSandboxContinuity } from "./pi-sandbox-continuity.ts";
import { PiAgentEventAdapter } from "./pi-agent-event-adapter.ts";
import { PiSamplingStepController, type PiSamplingStepCapture } from "./pi-sampling-step.ts";
import type { PiDurableRecoverySuffix } from "./sandbox-checkpoint.ts";
import {
  PiTurnCancelledError,
  PiTurnError,
  type PiModelRuntimeConfig,
  type PiCancellationSignal,
  type PiEventPublisher,
  type PiInterruptedCheckpoint,
  type PiSettledCheckpoint,
  type PiToolOutputArtifact,
  type PiToolOutputCapture,
  type PiTurnResult,
} from "./pi-turn-runtime.ts";

type JsonRecord = Record<string, unknown>;

export type PiSdkTurnRunnerOptions = {
  resolveModelRuntime: (
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ) => Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  resolveWorkspaceDirectory: (command: ExecuteTurnCommandMessage) => Promise<string> | string;
  inlineExtensions?: readonly InlineExtension[];
  createInlineExtensions?: (context: {
    toolOutputDirectory: string;
    stepWorldState: PiStepWorldStateController | undefined;
    captureSamplingStep: (
      createFresh: () => Omit<PiSamplingStepCapture, "samplingAttempt">,
    ) => PiSamplingStepCapture;
  }) => readonly InlineExtension[];
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  collectWorkspacePatch?: () => Promise<WorkspacePatch | undefined> | WorkspacePatch | undefined;
  restorePiSession?: Uint8Array;
  recoverySuffix?: PiDurableRecoverySuffix;
  sandboxContinuity?: PiSandboxContinuity;
  onSettled?: (checkpoint: PiSettledCheckpoint) => Promise<void> | void;
  onInterrupted?: (checkpoint: PiInterruptedCheckpoint) => Promise<void> | void;
  persistToolOutputArtifact?: (output: PiToolOutputCapture) => Promise<PiToolOutputArtifact>;
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
      rejectPromise(new PiTurnError("pi_timeout", `${label} timed out`, true));
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
    throw new PiTurnError(
      "model_binding_mismatch",
      "Resolved model runtime does not match the accepted turn",
      false,
    );
  }
  if (config.apiKey.length === 0) {
    throw new PiTurnError("credential_unavailable", "Model credential is unavailable", true);
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
  } catch {
    throw new PiTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new PiTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (command.payload.model.thinkingLevel !== "off" && config.reasoning !== true) {
    throw new PiTurnError(
      "invalid_model_runtime",
      "The accepted thinking level is unsupported by the resolved model",
      false,
    );
  }
  return config;
}

function cancellationSignal(value: unknown): PiCancellationSignal {
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
    throw new PiTurnError("invalid_cancellation", "Turn cancellation signal was invalid", false);
  }
  return value as PiCancellationSignal;
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
  #activeSession: AgentSession | undefined;
  #finished = false;
  readonly #steerWaiters = new Set<{
    resolve: (session: AgentSession) => void;
    reject: (error: Error) => void;
  }>();

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

  async steer(text: string): Promise<void> {
    if (text.trim().length === 0 || text.length > 100_000) {
      throw new PiTurnError("invalid_steer", "Steer text is invalid", false);
    }
    const session = this.#activeSession ?? (await this.#waitForSteerTarget());
    await session.steer(text);
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal?: AbortSignal,
  ): Promise<PiTurnResult> {
    if (command.payload.input.kind !== "prompt") {
      throw new PiTurnError(
        "unsupported_input",
        "This Pi SDK runner only supports prompt input",
        false,
      );
    }
    const acceptedPrompt = command.payload.input.text;
    const runtimeConfig = validateRuntimeConfig(
      command,
      await this.#options.resolveModelRuntime(command.payload.model),
    );
    const workspaceDirectory = resolve(await this.#options.resolveWorkspaceDirectory(command));
    const workspaceStat = await stat(workspaceDirectory).catch(() => undefined);
    if (!workspaceStat?.isDirectory()) {
      throw new PiTurnError("workspace_unavailable", "Workspace directory is unavailable", true);
    }

    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-sdk-"));
    const agentDirectory = resolve(temporaryRoot, "agent");
    const sessionDirectory = resolve(temporaryRoot, "sessions");
    const sessionFile = resolve(sessionDirectory, "session.jsonl");
    const toolOutputDirectory = resolve(temporaryRoot, "tool-outputs");
    const persistSession =
      this.#options.restorePiSession !== undefined ||
      this.#options.onSettled !== undefined ||
      this.#options.onInterrupted !== undefined;
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
    let cancellationError: PiTurnCancelledError | undefined;
    let cancellationTask: Promise<void> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let isolationFailure: PiSdkIsolationFailure | undefined;
    let sessionManager: SessionManager | undefined;
    let baseEntryIds = new Set<string>();
    let interruptedCheckpointCaptured = false;
    let sandboxToolStarted = false;
    let stepWorldState: PiStepWorldStateController | undefined;
    const samplingSteps = new PiSamplingStepController();
    const terminal = deferred<PiTurnResult>();
    void terminal.promise.catch(() => undefined);

    const eventFactory = createAgentDockEventFactory(
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
    );
    const eventAdapter = new PiAgentEventAdapter(eventFactory, {
      inputKind: command.payload.input.kind,
      requireSamplingIdentity: this.#options.createInlineExtensions !== undefined,
      ...(command.payload.budgets === undefined
        ? {}
        : { maximumToolOutputBytes: command.payload.budgets.maximumToolOutputBytes }),
    });

    const captureInterruptedConversation = async (reason: string): Promise<void> => {
      if (interruptedCheckpointCaptured || this.#options.onInterrupted === undefined) return;
      if (sessionManager === undefined) {
        throw new PiTurnError(
          "checkpoint_capture_failed",
          "Pi did not create a Session for the interrupted Run",
          true,
        );
      }
      appendPiInterruption(sessionManager, {
        baseEntryIds,
        acceptedPrompt,
        reason,
        runId: command.payload.runId,
        attemptId: command.payload.attemptId,
        timestamp: validDate(this.#clock).valueOf(),
      });
      if (sandboxToolStarted) stepWorldState?.recordUnavailable();
      const persistedSessionFile = sessionManager.getSessionFile();
      const piSession =
        persistedSessionFile === undefined
          ? undefined
          : await readFile(persistedSessionFile).catch(() => undefined);
      if (piSession === undefined) {
        throw new PiTurnError(
          "checkpoint_capture_failed",
          "Pi did not produce a readable interrupted Session snapshot",
          true,
        );
      }
      await this.#options.onInterrupted({ piSession, reason });
      interruptedCheckpointCaptured = true;
    };

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
        throw new PiTurnError("pi_protocol_error", "Pi event envelope was invalid", false);
      }
      return candidate;
    };

    const settleCancellation = (error: PiTurnCancelledError): void => {
      if (cancellationError !== undefined) return;
      cancellationError = error;
      fatalError = error;
      terminal.reject(error);
    };

    const publish = async (sourceEvent: AgentSessionEvent): Promise<void> => {
      const outcome = eventAdapter.adapt(sourceEvent);
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "invalid") {
        throw new PiTurnError("pi_protocol_error", outcome.reason, false);
      }
      if (outcome.kind === "settled") {
        if (outcome.result.status === "completed") {
          if (this.#options.onSettled !== undefined) {
            if (sandboxToolStarted) stepWorldState?.recordActive();
            const persistedSessionFile = runtime?.session.sessionFile;
            const piSession =
              persistedSessionFile === undefined
                ? undefined
                : await readFile(persistedSessionFile).catch(() => undefined);
            if (piSession === undefined) {
              throw new PiTurnError(
                "checkpoint_capture_failed",
                "Pi did not produce a readable settled session snapshot",
                true,
              );
            }
            await this.#options.onSettled({ piSession });
          }
          const workspacePatch = await this.#options.collectWorkspacePatch?.();
          terminal.resolve({
            stopReason: outcome.result.stopReason,
            ...(workspacePatch === undefined ? {} : { workspacePatch }),
          });
          return;
        }
        if (outcome.result.status === "cancelled") {
          await captureInterruptedConversation(`cancelled:${outcome.result.reason}`);
          settleCancellation(
            new PiTurnCancelledError(outcome.result.reason, outcome.result.forced),
          );
          return;
        }
        await captureInterruptedConversation(`failed:${outcome.result.code}`);
        terminal.reject(
          new PiTurnError(outcome.result.code, outcome.result.message, outcome.result.retryable),
        );
        return;
      }
      let publicEvent = outcome.event;
      if (publicEvent.type === "tool.started" || publicEvent.type === "tool.completed") {
        sandboxToolStarted = true;
      }
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
            throw new PiTurnError(
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
      const envelope = eventMessage(publicEvent);
      await publishEvent(envelope);
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
      if (event.type === "auto_retry_start") samplingSteps.scheduleRetry(event.attempt);
      if (event.type === "auto_retry_end" && !event.success) {
        samplingSteps.cancelScheduledRetry();
      }
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

    let result: PiTurnResult | undefined;
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
                this.#options.createInlineExtensions?.({
                  toolOutputDirectory,
                  stepWorldState,
                  captureSamplingStep: (createFresh) => {
                    const captured = samplingSteps.capture(createFresh);
                    const identity = {
                      stepSequence: captured.step.context.sequence,
                      stepSha256: captured.step.sha256,
                      samplingAttempt: captured.samplingAttempt,
                    } as const;
                    eventChain = eventChain
                      .then(() =>
                        publishEvent(eventMessage(eventAdapter.samplingStarted(identity))),
                      )
                      .catch((error: unknown) => {
                        fail(error instanceof Error ? error : new Error(String(error)));
                      });
                    return captured;
                  },
                }) ??
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
          throw new PiTurnError("invalid_model_runtime", "Configured model is unavailable", false);
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
      sessionManager =
        this.#options.restorePiSession === undefined
          ? SessionManager.create(workspaceDirectory, sessionDirectory)
          : SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory);
      if (this.#options.recoverySuffix !== undefined) {
        appendPiDurableRecovery(sessionManager, this.#options.recoverySuffix);
      }
      if (this.#options.sandboxContinuity !== undefined) {
        stepWorldState = new PiStepWorldStateController(
          sessionManager,
          this.#options.sandboxContinuity,
        );
      }
      baseEntryIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
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
          fail(new PiTurnError("pi_extension_error", "Pi extension failed", false));
        },
      });
      unsubscribe = runtime.session.subscribe(queueEvent);
      this.#activeSession = runtime.session;
      for (const waiter of this.#steerWaiters) waiter.resolve(runtime.session);
      this.#steerWaiters.clear();

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
                error instanceof PiTurnCancelledError ? ("cancelled" as const) : ("other" as const),
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
          if (forced.kind !== "settled" || forced.result.status !== "cancelled") {
            throw new PiTurnError(
              "pi_protocol_error",
              "Pi SDK cancellation did not create a terminal result",
              false,
            );
          }
          isolationFailure = new PiSdkIsolationFailure(
            "Pi SDK did not settle within the cancellation grace period",
          );
          await captureInterruptedConversation(`cancelled:${forced.result.reason}`);
          settleCancellation(new PiTurnCancelledError(forced.result.reason, forced.result.forced));
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
        await runtime.session.prompt(acceptedPrompt, { source: "rpc" });
        if (extensionErrors.length > 0) {
          throw new PiTurnError("pi_extension_error", "Pi extension failed", false);
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
      removeAbortListener?.();
      unsubscribe?.();
      this.#activeSession = undefined;
      this.#finished = true;
      const unavailable = new PiTurnError(
        "steer_target_unavailable",
        "Pi Run ended before the steer could be delivered",
        false,
      );
      for (const waiter of this.#steerWaiters) waiter.reject(unavailable);
      this.#steerWaiters.clear();
      if (runtime !== undefined) {
        await withTimeout(runtime.dispose(), this.#shutdownTimeoutMs, "Pi SDK dispose").catch(
          () => {
            isolationFailure ??= new PiSdkIsolationFailure(
              "Pi SDK runtime did not dispose within its shutdown deadline",
            );
          },
        );
      }
      if (
        result === undefined &&
        !interruptedCheckpointCaptured &&
        this.#options.onInterrupted !== undefined
      ) {
        const failure = runError ?? fatalError ?? cancellationError;
        const reason =
          cancellationError !== undefined
            ? `cancelled:${cancellationError.reason}`
            : failure !== undefined &&
                typeof failure === "object" &&
                "code" in failure &&
                typeof failure.code === "string"
              ? `failed:${failure.code}`
              : "failed:worker_interrupted";
        await captureInterruptedConversation(reason).catch((error: unknown) => {
          runError ??= error;
        });
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
      throw new PiTurnError(
        "pi_protocol_error",
        "Pi SDK turn ended without a terminal result",
        false,
      );
    }
    return result;
  }

  #waitForSteerTarget(): Promise<AgentSession> {
    if (this.#finished) {
      return Promise.reject(
        new PiTurnError(
          "steer_target_unavailable",
          "Pi Run is no longer available for steering",
          false,
        ),
      );
    }
    let waiter!: {
      resolve: (session: AgentSession) => void;
      reject: (error: Error) => void;
    };
    const ready = new Promise<AgentSession>((resolvePromise, rejectPromise) => {
      waiter = { resolve: resolvePromise, reject: rejectPromise };
      this.#steerWaiters.add(waiter);
    });
    return withTimeout(ready, this.#requestTimeoutMs, "Pi steer target").finally(() => {
      this.#steerWaiters.delete(waiter);
    });
  }
}
