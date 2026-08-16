import {
  Agent,
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  compact,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CompactionSettings,
  type CustomEntryContextMessageProjector,
  type Session,
  type StreamFn,
  type ThinkingLevel,
  type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  Models,
  RetryPolicy,
  SimpleStreamOptions,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExecutionAuthority } from "./execution-authority.ts";

export interface CloudAgentExecutionAuthority extends ExecutionAuthority {
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export type CloudAgentRuntimeEvent =
  | AgentEvent
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: "threshold" }
  | {
      type: "compaction_end";
      reason: "threshold";
      success: boolean;
      errorMessage?: string;
      result?: Readonly<{
        summary: string;
        tokensBefore: number;
        estimatedTokensAfter: number;
      }>;
    };

export type CloudAgentRuntimeOptions = Readonly<{
  session: Session;
  authority: CloudAgentExecutionAuthority;
  model: Model<Api>;
  models?: Models;
  streamFn?: StreamFn;
  systemPrompt: string | (() => string | Promise<string>);
  tools?: readonly AgentTool[];
  thinkingLevel?: ThinkingLevel;
  streamOptions?: SimpleStreamOptions;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  toolExecution?: ToolExecutionMode;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  prepareContextMaintenance?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<void>;
  transformHeaders?: (
    headers: Record<string, string | null>,
  ) => Record<string, string | null> | Promise<Record<string, string | null>>;
  entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
  prepareFollowUp?: () => AgentMessage | undefined | Promise<AgentMessage | undefined>;
  onEvent?: (event: CloudAgentRuntimeEvent) => Promise<void> | void;
  idGenerator?: () => string;
}>;

export type CloudAgentRunResult = Readonly<{
  kind: "completed" | "aborted" | "failed";
  finalMessage: AssistantMessage;
  leafId: string;
  error?: Readonly<{ code: string; message: string }>;
}>;

const INTERRUPTION_CUSTOM_TYPE = "pi-cloud.run_interrupted";
const UNKNOWN_TOOL_EFFECT_TEXT =
  "The previous Worker stopped while this Tool was active. Its side effects are unknown. " +
  "Do not replay it blindly; inspect the Workspace and environment before continuing.";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createUserMessage(text: string, images?: readonly ImageContent[]): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
  };
}

function normalizeMessage(message: AgentMessage): AgentMessage {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isObject(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (candidate !== undefined) result[key] = visit(candidate);
    }
    return result;
  };
  return visit(message) as AgentMessage;
}

function combinedSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(settle, milliseconds);
    timer.unref();
    const abort = (): void => settle(signal.reason);
    function settle(error?: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function operationError(error: unknown): { code: string; message: string } {
  const normalized = asError(error);
  return { code: normalized.name || "execution_failed", message: normalized.message };
}

function interruptionProjector(entry: {
  customType: string;
  data?: unknown;
  timestamp: number;
}): AgentMessage[] | undefined {
  if (entry.customType !== INTERRUPTION_CUSTOM_TYPE || !isObject(entry.data)) return undefined;
  const content = entry.data.content;
  if (typeof content !== "string" || content.length === 0) return undefined;
  return [
    {
      role: "custom",
      customType: INTERRUPTION_CUSTOM_TYPE,
      content,
      display: false,
      timestamp: entry.timestamp,
    } as AgentMessage,
  ];
}

function recoveryMarker(reason: string): string {
  return [
    "<turn_aborted>",
    "The previous agent Run did not finish normally.",
    `Reason: ${reason}`,
    "Treat unfinished work as uncertain and inspect relevant state before continuing.",
    "</turn_aborted>",
  ].join("\n");
}

/**
 * Product-sized Pi runtime for one cloud Run.
 *
 * PostgreSQL SessionStorage owns model context; Pi Agent owns only the active
 * in-memory loop. Complete messages are appended on message_end, while remote
 * Tools and Session writes share one opaque authority. The caller owns that
 * authority's lifetime so it can remain valid through Workspace and terminal
 * settlement after this in-memory loop stops.
 */
export class CloudAgentRuntime {
  readonly #options: CloudAgentRuntimeOptions;
  readonly #id: () => string;
  readonly #compaction: CompactionSettings;
  #agent: Agent | undefined;
  #closed = false;

  constructor(options: CloudAgentRuntimeOptions) {
    if (options.models === undefined && options.streamFn === undefined) {
      throw new TypeError("CloudAgentRuntime requires Pi Models or a streamFn");
    }
    this.#options = options;
    this.#id = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#compaction = { ...(options.compaction ?? DEFAULT_COMPACTION_SETTINGS) };
  }

  async run(text: string, images?: readonly ImageContent[]): Promise<CloudAgentRunResult> {
    if (this.#closed) throw new Error("Cloud Agent Runtime is closed");
    if (this.#agent !== undefined) throw new Error("Cloud Agent Runtime is already active");
    if (text.trim().length === 0) throw new TypeError("Cloud Agent prompt must not be empty");

    const authority = this.#options.authority;
    const session = this.#options.session;
    const lane = "main";
    const operationId = this.#id();
    const userMessage = normalizeMessage(createUserMessage(text, images));
    const userEntryId = this.#id();
    let finalMessage: AssistantMessage | undefined;
    let removeAuthorityAbort: (() => void) | undefined;

    try {
      await authority.assertCurrent();
      await this.#recoverInterruptedOperation();
      await session.appendRecord({
        id: operationId,
        lane,
        type: "operation_started",
        sourceLeafId: await session.getLeafId(),
        intent: {
          kind: "run",
          originalPrompt: [userMessage],
          initialMessages: [{ id: userEntryId, type: "message", message: userMessage }],
        },
      });
      await session.appendEntry({ id: userEntryId, type: "message", message: userMessage }, lane);

      const restored = await this.#loadContext();
      const systemPrompt =
        typeof this.#options.systemPrompt === "function"
          ? await this.#options.systemPrompt()
          : this.#options.systemPrompt;
      const resultEntryIds = new Map<string, string>();
      let assistantEntryId: string | undefined;
      let pendingAssistantEntryId: string | undefined;
      let assistantAttempt = 0;
      let toolIndex = 0;

      const tools = (this.#options.tools ?? []).map((tool) =>
        this.#bindTool(
          tool,
          operationId,
          resultEntryIds,
          () => assistantEntryId,
          () => toolIndex++,
        ),
      );
      const streamFn: StreamFn = async (model, context, options) => {
        await authority.assertCurrent();
        assistantAttempt += 1;
        pendingAssistantEntryId = this.#id();
        await session.appendRecord({
          id: this.#id(),
          lane,
          type: "step_attempt",
          runId: operationId,
          step: "assistant",
          attempt: assistantAttempt,
          resultEntryId: pendingAssistantEntryId,
        });
        const headers = {
          ...(this.#options.streamOptions?.headers ?? {}),
          ...(options?.headers ?? {}),
        };
        const transformedHeaders = await this.#options.transformHeaders?.(headers);
        const effectiveOptions = {
          ...this.#options.streamOptions,
          ...options,
          headers: transformedHeaders ?? headers,
        };
        return (
          this.#options.streamFn?.(model, context, effectiveOptions) ??
          this.#options.models!.streamSimple(model, context, effectiveOptions)
        );
      };

      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt,
          model: this.#options.model,
          thinkingLevel: this.#options.thinkingLevel ?? "off",
          messages: restored,
          tools,
        },
        convertToLlm,
        transformContext: async (_messages, signal) => {
          await this.#compactIfNeeded(operationId, signal);
          const current = await this.#loadContext();
          return this.#options.transformContext
            ? this.#options.transformContext(current, signal)
            : current;
        },
        toolExecution: this.#options.toolExecution ?? "sequential",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      });
      this.#agent = agent;
      const abortForAuthority = (): void => agent.abort();
      authority.signal.addEventListener("abort", abortForAuthority, { once: true });
      removeAuthorityAbort = () => authority.signal.removeEventListener("abort", abortForAuthority);
      if (authority.signal.aborted) abortForAuthority();

      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end") {
          await authority.assertCurrent();
          const message = normalizeMessage(event.message);
          let entryId: string;
          if (message.role === "assistant") {
            entryId = pendingAssistantEntryId ?? this.#id();
            pendingAssistantEntryId = undefined;
          } else if (message.role === "toolResult") {
            entryId = resultEntryIds.get(message.toolCallId) ?? this.#id();
          } else {
            entryId = this.#id();
          }
          const durableMessage =
            message.role !== "assistant" ||
            (message.stopReason !== "error" && message.stopReason !== "aborted");
          if (durableMessage && (await session.getEntry(entryId)) === undefined) {
            await session.appendEntry({ id: entryId, type: "message", message }, lane);
            await this.#recordUsage(operationId, entryId, message, assistantAttempt);
          }
          if (message.role === "assistant") {
            assistantEntryId = durableMessage ? entryId : undefined;
            finalMessage = message;
            toolIndex = 0;
          }
        }
        await this.#options.onEvent?.(event);
        if (
          event.type === "turn_end" &&
          event.toolResults.length === 0 &&
          event.message.role === "assistant" &&
          event.message.stopReason !== "error" &&
          event.message.stopReason !== "aborted"
        ) {
          const followUp = await this.#options.prepareFollowUp?.();
          if (followUp !== undefined) agent.followUp(followUp);
        }
      });

      try {
        const retry = this.#options.retry;
        let retryAttempt = 0;
        for (;;) {
          await agent.continue();
          if (
            finalMessage?.stopReason !== "error" ||
            retry?.enabled !== true ||
            retryAttempt >= retry.maxRetries ||
            !isRetryableAssistantError(finalMessage)
          ) {
            if (retryAttempt > 0) {
              await this.#options.onEvent?.({
                type: "auto_retry_end",
                success: finalMessage?.stopReason !== "error",
                attempt: retryAttempt,
                ...(finalMessage?.stopReason === "error" && finalMessage.errorMessage
                  ? { finalError: finalMessage.errorMessage }
                  : {}),
              });
            }
            break;
          }

          retryAttempt += 1;
          const delayMs = retry.baseDelayMs * 2 ** (retryAttempt - 1);
          await this.#options.onEvent?.({
            type: "auto_retry_start",
            attempt: retryAttempt,
            maxAttempts: retry.maxRetries,
            delayMs,
            errorMessage: finalMessage.errorMessage ?? "Transient model request failed",
          });
          const failed = agent.state.messages.at(-1);
          if (failed?.role !== "assistant" || failed.stopReason !== "error") {
            throw new Error("Pi retry boundary did not end with a failed assistant message");
          }
          agent.state.messages = agent.state.messages.slice(0, -1);
          finalMessage = undefined;
          await abortableDelay(delayMs, authority.signal);
        }
      } finally {
        unsubscribe();
      }
      await authority.assertCurrent();
      if (finalMessage === undefined) {
        throw new Error("Pi Agent Loop settled without an assistant message");
      }
      const kind =
        finalMessage.stopReason === "aborted"
          ? "aborted"
          : finalMessage.stopReason === "error"
            ? "failed"
            : "completed";
      if (kind !== "completed") {
        await session.appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
          content: recoveryMarker(
            kind === "failed"
              ? (finalMessage.errorMessage ?? "Model request failed")
              : "The Run was aborted",
          ),
        });
      }
      await session.appendRecord({
        id: this.#id(),
        lane,
        type: "operation_finished",
        runId: operationId,
        outcome: kind,
        ...(kind === "failed"
          ? {
              error: {
                code: "model_error",
                message: finalMessage.errorMessage ?? "Model request failed",
              },
            }
          : {}),
      });
      const leafId = await session.getLeafId();
      if (leafId === null) throw new Error("Cloud Agent Session did not produce a leaf");
      return {
        kind,
        finalMessage,
        leafId,
        ...(kind === "failed"
          ? {
              error: {
                code: "model_error",
                message: finalMessage.errorMessage ?? "Model request failed",
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      const failure = operationError(error);
      if (!authority.signal.aborted) {
        await session
          .appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
            content: recoveryMarker(failure.message),
          })
          .catch(() => undefined);
        await session
          .appendRecord({
            id: this.#id(),
            lane,
            type: "operation_finished",
            runId: operationId,
            outcome: "failed",
            error: failure,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      removeAuthorityAbort?.();
      this.#agent = undefined;
      this.#closed = true;
    }
  }

  steer(text: string): void {
    if (text.trim().length === 0 || text.length > 100_000) {
      throw new TypeError("Steer text is invalid");
    }
    if (this.#agent === undefined) throw new Error("Cloud Agent Run is not active");
    this.#agent.steer(createUserMessage(text));
  }

  abort(): void {
    this.#agent?.abort();
  }

  async #loadContext(): Promise<AgentMessage[]> {
    const path = (
      await this.#options.session
        .view("main")
        .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" })
    ).reverse();
    const entryProjectors = {
      [INTERRUPTION_CUSTOM_TYPE]: interruptionProjector,
      ...(this.#options.entryProjectors ?? {}),
    } as Readonly<Record<string, CustomEntryContextMessageProjector>>;
    return buildSessionContext(path, { entryProjectors }).messages;
  }

  async #compactIfNeeded(operationId: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.#compaction.enabled) return false;
    const path = (
      await this.#options.session
        .view("main")
        .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" })
    ).reverse();
    const context = buildSessionContext(path, {
      entryProjectors: {
        [INTERRUPTION_CUSTOM_TYPE]: interruptionProjector,
        ...(this.#options.entryProjectors ?? {}),
      },
    }).messages;
    const tokens = estimateContextTokens(context).tokens;
    if (!shouldCompact(tokens, this.#options.model.contextWindow, this.#compaction)) return false;
    const preparation = prepareCompaction(path, this.#compaction);
    if (!preparation.ok) throw preparation.error;
    if (preparation.value === undefined) return false;

    await this.#options.prepareContextMaintenance?.(context, signal);

    await this.#options.onEvent?.({ type: "compaction_start", reason: "threshold" });
    const entryId = this.#id();
    const attempts = await this.#options.session.findRecords({
      lane: "main",
      type: "step_attempt",
      runId: operationId,
    });
    const attempt = attempts.filter((record) => record.step === "compaction").length + 1;
    await this.#options.session.appendRecord({
      id: this.#id(),
      lane: "main",
      type: "step_attempt",
      runId: operationId,
      step: "compaction",
      attempt,
      resultEntryId: entryId,
      compactionReason: "threshold",
    });
    const compactionModels = this.#modelsWithHeaders();
    const result = await compact(
      preparation.value,
      compactionModels,
      this.#options.model,
      undefined,
      combinedSignal(signal, this.#options.authority.signal),
      this.#options.thinkingLevel ?? "off",
      this.#options.retry,
    );
    if (!result.ok) {
      await this.#options.onEvent?.({
        type: "compaction_end",
        reason: "threshold",
        success: false,
        errorMessage: result.error.message,
      });
      throw result.error;
    }
    await this.#options.session.appendEntry(
      {
        id: entryId,
        type: "compaction",
        summary: result.value.summary,
        retainedTail: result.value.retainedTail,
        tokensBefore: result.value.tokensBefore,
        ...(result.value.details === undefined ? {} : { details: result.value.details }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      },
      "main",
    );
    if (result.value.usage !== undefined) {
      await this.#options.session.appendRecord({
        id: this.#id(),
        lane: "main",
        type: "usage",
        cause: "compaction",
        runId: operationId,
        entryId,
        attempt,
        stopReason: "stop",
        usage: result.value.usage,
      });
    }
    const compactedContext = await this.#loadContext();
    // Provider usage on an assistant retained by compaction still describes the
    // pre-compaction request.  estimateContextTokens() intentionally trusts that
    // usage for threshold decisions, so it is not a valid post-compaction size
    // metric until the next assistant response replaces it.  Estimate every
    // materialized message structurally for the completion event instead.
    const estimatedTokensAfter = compactedContext.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    );
    await this.#options.onEvent?.({
      type: "compaction_end",
      reason: "threshold",
      success: true,
      result: {
        summary: result.value.summary,
        tokensBefore: result.value.tokensBefore,
        estimatedTokensAfter,
      },
    });
    return true;
  }

  #modelsWithHeaders(): Models {
    const models = this.#options.models;
    if (models === undefined) {
      throw new Error("Automatic compaction requires Pi Models");
    }
    const transformHeaders = this.#options.transformHeaders;
    if (transformHeaders === undefined) return models;
    return new Proxy(models, {
      get(target, property, receiver) {
        if (property !== "completeSimple") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (
          model: Model<Api>,
          context: Parameters<Models["completeSimple"]>[1],
          options?: SimpleStreamOptions,
        ) => {
          const headers = await transformHeaders({ ...(options?.headers ?? {}) });
          return target.completeSimple(model, context, { ...options, headers });
        };
      },
    });
  }

  #bindTool(
    tool: AgentTool,
    operationId: string,
    resultEntryIds: Map<string, string>,
    assistantEntryId: () => string | undefined,
    nextToolIndex: () => number,
  ): AgentTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const authority = this.#options.authority;
        await authority.assertCurrent();
        const durableAssistantEntryId = assistantEntryId();
        if (durableAssistantEntryId === undefined) {
          throw new Error("Tool execution started before its assistant message was durable");
        }
        const resultEntryId = this.#id();
        resultEntryIds.set(toolCallId, resultEntryId);
        await this.#options.session.appendRecord({
          id: this.#id(),
          lane: "main",
          type: "tool_started",
          runId: operationId,
          assistantEntryId: durableAssistantEntryId,
          toolIndex: nextToolIndex(),
          toolCallId,
          toolName: tool.name,
          effectiveArgs: isObject(params) ? structuredClone(params) : {},
          resultEntryId,
          replay: "never",
        });
        const result = await tool.execute(
          toolCallId,
          params,
          combinedSignal(signal, authority.signal),
          onUpdate,
        );
        await authority.assertCurrent();
        return result;
      },
    };
  }

  async #recoverInterruptedOperation(): Promise<void> {
    const session = this.#options.session;
    const open = await session.findOpenOperations("main", { limit: 2 });
    if (open.length > 1) throw new Error("Pi Session contains multiple unfinished operations");
    const operation = open[0];
    if (operation === undefined) return;

    if (operation.intent.kind === "run") {
      for (const entry of operation.intent.initialMessages) {
        if ((await session.getEntry(entry.id)) === undefined) {
          if (entry.type !== "message") {
            throw new Error("Cloud Agent Run recovery found a non-message initial entry");
          }
          await session.appendEntry(entry, "main");
        }
      }
      const tools = await session.findRecords({
        lane: "main",
        type: "tool_started",
        runId: operation.id,
      });
      for (const tool of tools) {
        if ((await session.getEntry(tool.resultEntryId)) !== undefined) continue;
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          content: [{ type: "text", text: UNKNOWN_TOOL_EFFECT_TEXT }],
          details: { kind: "pi-cloud.unknown_tool_effect" },
          isError: true,
          timestamp: Date.now(),
        };
        await session.appendEntry({ id: tool.resultEntryId, type: "message", message }, "main");
      }
    }
    await session.appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
      content: recoveryMarker("Worker execution was interrupted before durable settlement"),
    });
    await session.appendRecord({
      id: this.#id(),
      lane: "main",
      type: "operation_finished",
      runId: operation.id,
      outcome: "failed",
      error: { code: "interrupted", message: "Recovered an unfinished cloud Agent operation" },
    });
  }

  async #recordUsage(
    operationId: string,
    entryId: string,
    message: AgentMessage,
    assistantAttempt: number,
  ): Promise<void> {
    let usage: Usage | undefined;
    let cause: "assistant" | "tool";
    let toolCallId: string | undefined;
    if (message.role === "assistant") {
      usage = message.usage;
      cause = "assistant";
    } else if (message.role === "toolResult") {
      usage = message.usage;
      cause = "tool";
      toolCallId = message.toolCallId;
    } else {
      return;
    }
    if (usage === undefined) return;
    if (cause === "assistant") {
      const assistant = message as AssistantMessage;
      const stopReason = assistant.stopReason === "pending" ? "error" : assistant.stopReason;
      await this.#options.session.appendRecord({
        id: this.#id(),
        lane: "main",
        type: "usage",
        cause,
        runId: operationId,
        entryId,
        attempt: Math.max(1, assistantAttempt),
        stopReason,
        usage,
      });
      return;
    }
    await this.#options.session.appendRecord({
      id: this.#id(),
      lane: "main",
      type: "usage",
      cause,
      runId: operationId,
      entryId,
      toolCallId: toolCallId!,
      usage,
    });
  }
}
