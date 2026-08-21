import {
  createPiCloudEventFactory,
  MAX_TOOL_OUTPUT_BYTES,
  parseSupervisorToControlMessage,
  type PiCloudEvent,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
  type WorkspacePatch,
} from "@pi-cloud/protocol";
import {
  CloudAgentRuntime,
  type CloudAgentExecutionAuthority,
  type CloudAgentRuntimeEvent,
} from "@pi-cloud/pi-session-postgres";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiAgentEventAdapter } from "./pi-agent-event-adapter.ts";
import {
  PI_WORLD_STATE_ENTRY_PROJECTORS,
  PiSessionWorldStateController,
  type PiSandboxContinuity,
} from "./pi-sandbox-continuity.ts";
import { PiSamplingStepController, type PiSamplingStepCapture } from "./pi-sampling-step.ts";
import {
  PiTurnCancelledError,
  PiTurnError,
  type PiCancellationSignal,
  type PiEventPublisher,
  type PiModelRuntimeConfig,
  type PiToolOutputArtifact,
  type PiToolOutputCapture,
  type PiTurnResult,
} from "./pi-turn-runtime.ts";
import type { TrustedRemoteAgentTools } from "./trusted-remote-tools-extension.ts";

type JsonRecord = Record<string, unknown>;

export type PiCloudSessionHandle = Readonly<{
  session: Session;
  authority: CloudAgentExecutionAuthority;
}>;

export type PiCloudTurnRunnerOptions = Readonly<{
  resolveModelRuntime: (
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ) => Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  openSession: (command: ExecuteTurnCommandMessage) => Promise<PiCloudSessionHandle>;
  createAgentTools: (context: {
    session: Session;
    toolOutputDirectory: string;
    stepWorldState: PiSessionWorldStateController;
    captureSamplingStep: (
      createFresh: () => Promise<Omit<PiSamplingStepCapture, "samplingAttempt">>,
      options?: Readonly<{ publishEvent?: boolean }>,
    ) => Promise<PiSamplingStepCapture>;
  }) => TrustedRemoteAgentTools;
  sandboxContinuity: PiSandboxContinuity;
  collectWorkspacePatch?: () => Promise<WorkspacePatch | undefined> | WorkspacePatch | undefined;
  onSettled?: (session: Session) => Promise<void> | void;
  persistToolOutputArtifact?: (output: PiToolOutputCapture) => Promise<PiToolOutputArtifact>;
  observeEvent?: (event: CloudAgentRuntimeEvent) => void;
  prepareFollowUp?: () => AgentMessage | undefined | Promise<AgentMessage | undefined>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
}>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const TEXT_DELTA_COALESCE_WINDOW_MS = 100;
const TEXT_DELTA_COALESCE_BYTES = 4 * 1_024;
const MAXIMUM_PENDING_PUBLIC_EVENTS = 512;
const BASE_SYSTEM_PROMPT = [
  "You are a coding agent working in a remote, isolated project workspace.",
  "Use the provided read, write, edit, and bash tools to inspect and change the project.",
  "Do not claim that a command, test, or file change succeeded unless its Tool result confirms it.",
  "Keep the final answer concise and report the files changed and verification performed.",
].join("\n");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Pi cloud clock must return a valid Date");
  }
  return value;
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
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (command.payload.model.thinkingLevel !== "off" && config.reasoning !== true) {
    throw new PiTurnError(
      "invalid_model_runtime",
      "The selected thinking level is unsupported",
      false,
    );
  }
  return config;
}

async function createModelRuntime(config: PiModelRuntimeConfig): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
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
        ...(config.provider === "deepseek" && config.reasoning === true
          ? {
              thinkingLevelMap: {
                minimal: "high" as const,
                low: "high" as const,
                medium: "high" as const,
                high: "high" as const,
                xhigh: "max" as const,
                max: "max" as const,
              },
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsStrictMode: false,
                maxTokensField: "max_tokens" as const,
                requiresReasoningContentOnAssistantMessages: true,
                thinkingFormat: "deepseek" as const,
              },
            }
          : {}),
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

function cancellationSignal(value: unknown): PiCancellationSignal {
  if (
    !isRecord(value) ||
    value.kind !== "pi-cloud.turn-cancellation" ||
    (value.reason !== "user_request" &&
      value.reason !== "timeout" &&
      value.reason !== "lease_revoked" &&
      value.reason !== "shutdown") ||
    !Number.isSafeInteger(value.gracePeriodMs) ||
    (value.gracePeriodMs as number) < 0
  ) {
    return { kind: "pi-cloud.turn-cancellation", reason: "shutdown", gracePeriodMs: 0 };
  }
  return value as PiCancellationSignal;
}

function streamedTextDelta(value: unknown): { delta: string; contentIndex?: number } | undefined {
  if (!isRecord(value) || value.type !== "message_update") return undefined;
  const streamEvent = value.assistantMessageEvent;
  if (
    !isRecord(streamEvent) ||
    streamEvent.type !== "text_delta" ||
    typeof streamEvent.delta !== "string"
  )
    return undefined;
  return {
    delta: streamEvent.delta,
    ...(Number.isSafeInteger(streamEvent.contentIndex)
      ? { contentIndex: streamEvent.contentIndex as number }
      : {}),
  };
}

function coalescedTextEvent(
  current: CloudAgentRuntimeEvent,
  delta: string,
): CloudAgentRuntimeEvent {
  const event = current as unknown as JsonRecord;
  const streamEvent = event.assistantMessageEvent as JsonRecord;
  return {
    ...event,
    assistantMessageEvent: { ...streamEvent, delta },
  } as unknown as CloudAgentRuntimeEvent;
}

export class PiCloudTurnRunner {
  readonly #options: PiCloudTurnRunnerOptions;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #id: () => string;
  #activeRuntime: CloudAgentRuntime | undefined;
  readonly #steerWaiters = new Set<{
    resolve(runtime: CloudAgentRuntime): void;
    reject(error: Error): void;
  }>();

  constructor(options: PiCloudTurnRunnerOptions) {
    this.#options = options;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#turnTimeoutMs = positiveInteger(
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "turnTimeoutMs",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async steer(text: string): Promise<void> {
    const runtime =
      this.#activeRuntime ??
      (await new Promise<CloudAgentRuntime>((resolvePromise, rejectPromise) => {
        const waiter = { resolve: resolvePromise, reject: rejectPromise };
        this.#steerWaiters.add(waiter);
      }));
    runtime.steer(text);
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal?: AbortSignal,
  ): Promise<PiTurnResult> {
    if (command.payload.input.kind !== "prompt") {
      throw new PiTurnError(
        "unsupported_input",
        "Cloud Pi Runtime only supports prompt input",
        false,
      );
    }
    const config = validateRuntimeConfig(
      command,
      await this.#options.resolveModelRuntime(command.payload.model),
    );
    const modelRuntime = await createModelRuntime(config);
    const model = modelRuntime.getModel(config.provider, config.modelId);
    if (model === undefined)
      throw new PiTurnError("invalid_model_runtime", "Configured model is unavailable", false);
    const sessionHandle = await this.#options.openSession(command);
    let toolOutputDirectoryForCleanup: string | undefined;

    try {
      const toolOutputDirectory = await mkdtemp(resolve(tmpdir(), "pi-cloud-tool-output-"));
      toolOutputDirectoryForCleanup = toolOutputDirectory;
      const eventFactory = createPiCloudEventFactory(
        {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          agentId: command.payload.agentId,
        },
        {
          initialSequence: command.payload.nextEventSeq - 1,
          clock: this.#clock,
          idGenerator: this.#id,
        },
      );
      const adapter = new PiAgentEventAdapter(eventFactory, {
        inputKind: "prompt",
        requireSamplingIdentity: true,
        ...(command.payload.budgets === undefined
          ? {}
          : { maximumToolOutputBytes: command.payload.budgets.maximumToolOutputBytes }),
      });
      const worldState = await PiSessionWorldStateController.create(
        sessionHandle.session,
        this.#options.sandboxContinuity,
      );
      const samplingSteps = new PiSamplingStepController();
      let toolStarted = false;
      let pendingTextEvent: CloudAgentRuntimeEvent | undefined;
      let pendingTextBytes = 0;
      let pendingTextTimer: NodeJS.Timeout | undefined;
      let emitNextTextImmediately = true;
      let eventChain = Promise.resolve();
      let pendingPublicEvents = 0;
      let fatalError: Error | undefined;

      const eventMessage = (event: PiCloudEvent): EventPublishMessage => {
        const parsed = parseSupervisorToControlMessage({
          protocolVersion: 1,
          messageId: this.#id(),
          sentAt: validDate(this.#clock).toISOString(),
          type: "event.publish",
          payload: {
            leaseId: command.payload.leaseId,
            fencingToken: command.payload.fencingToken,
            commandId: command.payload.commandId,
            runId: command.payload.runId,
            attemptId: command.payload.attemptId,
            event,
          },
        });
        if (parsed.type !== "event.publish")
          throw new PiTurnError("pi_protocol_error", "Pi event envelope was invalid", false);
        return parsed;
      };

      const publishMapped = async (
        source: unknown,
      ): Promise<ReturnType<PiAgentEventAdapter["adapt"]>> => {
        const outcome = adapter.adapt(source);
        if (outcome.kind === "invalid")
          throw new PiTurnError("pi_protocol_error", outcome.reason, false);
        if (outcome.kind === "mapped") {
          let publicEvent = outcome.event;
          if (publicEvent.type === "tool.started") toolStarted = true;
          if (
            publicEvent.type === "tool.completed" &&
            this.#options.persistToolOutputArtifact !== undefined
          ) {
            const artifactPath = resolve(
              toolOutputDirectory,
              `${createHash("sha256").update(publicEvent.payload.toolCallId, "utf8").digest("hex")}.output`,
            );
            const metadata = await lstat(artifactPath).catch((error: unknown) =>
              isRecord(error) && error.code === "ENOENT" ? undefined : Promise.reject(error),
            );
            if (metadata !== undefined) {
              if (
                !metadata.isFile() ||
                metadata.isSymbolicLink() ||
                metadata.size > MAX_TOOL_OUTPUT_BYTES
              ) {
                throw new PiTurnError(
                  "tool_output_artifact_invalid",
                  "Trusted Tool output artifact was invalid",
                  false,
                );
              }
              const artifact = await this.#options.persistToolOutputArtifact({
                toolCallId: publicEvent.payload.toolCallId,
                bytes: await readFile(artifactPath),
              });
              publicEvent = {
                ...publicEvent,
                payload: { ...publicEvent.payload, outputArtifact: artifact },
              };
            }
          }
          await publishEvent(eventMessage(publicEvent));
        }
        return outcome;
      };

      const enqueue = (event: CloudAgentRuntimeEvent): void => {
        pendingPublicEvents += 1;
        eventChain = eventChain
          .then(async () => {
            await publishMapped(this.#adapterEvent(event));
          })
          .catch((error: unknown) => {
            fatalError ??= error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            pendingPublicEvents -= 1;
          });
      };
      const flushPendingText = (): void => {
        if (pendingTextTimer !== undefined) clearTimeout(pendingTextTimer);
        pendingTextTimer = undefined;
        if (pendingTextEvent === undefined) return;
        const event = pendingTextEvent;
        pendingTextEvent = undefined;
        pendingTextBytes = 0;
        enqueue(event);
      };
      const queueEvent = (event: CloudAgentRuntimeEvent): void => {
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
        if (pendingTextBytes >= TEXT_DELTA_COALESCE_BYTES) flushPendingText();
        else if (pendingTextTimer === undefined) {
          pendingTextTimer = setTimeout(flushPendingText, TEXT_DELTA_COALESCE_WINDOW_MS);
          pendingTextTimer.unref();
        }
      };

      const tools = this.#options.createAgentTools({
        session: sessionHandle.session,
        toolOutputDirectory,
        stepWorldState: worldState,
        captureSamplingStep: async (createFresh, captureOptions) => {
          const captured = await samplingSteps.captureAsync(createFresh);
          if (captureOptions?.publishEvent !== false) {
            eventChain = eventChain.then(() =>
              publishEvent(
                eventMessage(
                  adapter.samplingStarted({
                    stepSequence: captured.step.context.sequence,
                    stepSha256: captured.step.sha256,
                    samplingAttempt: captured.samplingAttempt,
                  }),
                ),
              ),
            );
            await eventChain;
            if (fatalError !== undefined) throw fatalError;
          }
          return captured;
        },
      });
      const runtime = new CloudAgentRuntime({
        session: sessionHandle.session,
        authority: sessionHandle.authority,
        model,
        models: modelRuntime,
        systemPrompt: () =>
          tools.systemPrompt(
            command.payload.agentSystemPrompt === undefined
              ? BASE_SYSTEM_PROMPT
              : `${BASE_SYSTEM_PROMPT}\n\n${command.payload.agentSystemPrompt}`,
          ),
        tools: tools.tools,
        thinkingLevel: command.payload.model.thinkingLevel,
        streamOptions: {
          timeoutMs: this.#requestTimeoutMs,
          // The cloud runtime owns visible, governed retry attempts so each one
          // receives a fresh sampling identity and model-request ledger row.
          maxRetries: 0,
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
        compaction: {
          enabled: true,
          reserveTokens: command.payload.budgets?.compactionReserveTokens ?? 16_384,
          keepRecentTokens: command.payload.budgets?.compactionKeepRecentTokens ?? 20_000,
        },
        transformContext: (messages) => tools.transformContext(messages),
        prepareContextMaintenance: async (messages) => {
          await tools.transformContext(messages, "context_maintenance");
        },
        transformHeaders: (headers) =>
          tools.transformHeaders(headers as ProviderHeaders) as Promise<
            Record<string, string | null>
          >,
        entryProjectors: PI_WORLD_STATE_ENTRY_PROJECTORS,
        onEvent: async (event) => {
          this.#options.observeEvent?.(event);
          queueEvent(event);
          // Semantic boundaries must be durable before Pi advances. Text deltas
          // remain coalesced and asynchronous, but the next non-delta boundary
          // drains every preceding delta in order.
          if (
            streamedTextDelta(event) === undefined ||
            pendingPublicEvents >= MAXIMUM_PENDING_PUBLIC_EVENTS
          ) {
            await eventChain;
          }
          if (fatalError !== undefined) throw fatalError;
        },
        ...(this.#options.prepareFollowUp === undefined
          ? {}
          : { prepareFollowUp: this.#options.prepareFollowUp }),
        idGenerator: this.#id,
      });
      this.#activeRuntime = runtime;
      for (const waiter of this.#steerWaiters) waiter.resolve(runtime);
      this.#steerWaiters.clear();

      const timeout = new AbortController();
      const timer = setTimeout(
        () =>
          timeout.abort({
            kind: "pi-cloud.turn-cancellation",
            reason: "timeout",
            gracePeriodMs: 0,
          }),
        this.#turnTimeoutMs,
      );
      timer.unref();
      const combined =
        signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
      const abort = (): void => {
        const cancellation = cancellationSignal(combined.reason);
        try {
          adapter.requestCancellation(cancellation.reason);
        } catch {
          /* already settled */
        }
        runtime.abort();
      };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();

      try {
        const result = await runtime.run(command.payload.input.text);
        flushPendingText();
        await eventChain;
        if (fatalError !== undefined) throw fatalError;
        if (result.kind === "completed") {
          await sessionHandle.authority.assertCurrent();
          await this.#options.onSettled?.(sessionHandle.session);
          await sessionHandle.authority.assertCurrent();
        } else {
          if (toolStarted) await worldState.recordUnavailable().catch(() => undefined);
        }
        const settled = await publishMapped({ type: "agent_settled" });
        if (settled.kind !== "settled")
          throw new PiTurnError("pi_protocol_error", "Pi did not settle", false);
        if (settled.result.status === "cancelled")
          throw new PiTurnCancelledError(settled.result.reason, settled.result.forced);
        if (settled.result.status === "failed")
          throw new PiTurnError(
            settled.result.code,
            settled.result.message,
            settled.result.retryable,
          );
        const workspacePatch = await this.#options.collectWorkspacePatch?.();
        return {
          stopReason: settled.result.stopReason,
          ...(workspacePatch === undefined ? {} : { workspacePatch }),
        };
      } catch (error: unknown) {
        if (toolStarted) await worldState.recordUnavailable().catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        flushPendingText();
        await eventChain.catch(() => undefined);
        this.#activeRuntime = undefined;
        for (const waiter of this.#steerWaiters)
          waiter.reject(
            new PiTurnError(
              "steer_target_unavailable",
              "Pi Run ended before steer delivery",
              false,
            ),
          );
        this.#steerWaiters.clear();
      }
    } finally {
      await sessionHandle.authority.close();
      if (toolOutputDirectoryForCleanup !== undefined) {
        await rm(toolOutputDirectoryForCleanup, { recursive: true, force: true });
      }
    }
  }

  #adapterEvent(event: CloudAgentRuntimeEvent): unknown {
    if (event.type === "compaction_start") return event;
    if (event.type === "compaction_end") {
      return {
        type: "compaction_end",
        reason: event.reason,
        aborted: !event.success,
        willRetry: false,
        ...(event.result === undefined ? {} : { result: event.result }),
      };
    }
    return event;
  }
}
