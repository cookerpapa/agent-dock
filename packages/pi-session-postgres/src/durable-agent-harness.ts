import {
  Agent,
  buildSessionContext,
  convertToLlm,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type Session,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

export type DurableAgentExecutionScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
}>;

/**
 * One opaque authority for every effect produced by a cloud Agent Run.
 *
 * The Harness deliberately does not expose lease IDs or fencing tokens. The
 * provider owns their representation and must reject stale authority at the
 * actual storage/Tool effect boundary.
 */
export interface DurableAgentExecutionAuthority {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableAgentExecutionAuthorityProvider {
  acquire(scope: DurableAgentExecutionScope): Promise<DurableAgentExecutionAuthority>;
}

/** Binds a pre-created authority to exactly one Harness scope. */
export class FixedDurableAgentExecutionAuthorityProvider implements DurableAgentExecutionAuthorityProvider {
  readonly #scope: DurableAgentExecutionScope;
  readonly #authority: DurableAgentExecutionAuthority;
  #acquired = false;

  constructor(scope: DurableAgentExecutionScope, authority: DurableAgentExecutionAuthority) {
    this.#scope = scope;
    this.#authority = authority;
  }

  async acquire(scope: DurableAgentExecutionScope): Promise<DurableAgentExecutionAuthority> {
    if (
      this.#acquired ||
      scope.tenantId !== this.#scope.tenantId ||
      scope.sessionId !== this.#scope.sessionId ||
      scope.runId !== this.#scope.runId ||
      scope.attemptId !== this.#scope.attemptId
    ) {
      throw new Error("Durable Agent execution authority scope is stale");
    }
    this.#acquired = true;
    await this.#authority.assertCurrent();
    return this.#authority;
  }
}

export type DurableAgentHarnessOptions = {
  session: Session;
  authorityProvider: DurableAgentExecutionAuthorityProvider;
  scope: DurableAgentExecutionScope;
  model: Model<Api>;
  streamFn: StreamFn;
  systemPrompt: string;
  tools?: readonly AgentTool[];
  thinkingLevel?: ThinkingLevel;
  toProviderMessages?: (messages: AgentMessage[]) => Promise<Message[]> | Message[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  idGenerator?: () => string;
};

export type DurableAgentRunResult = Readonly<{
  operationId: string;
  leafId: string;
  finalMessage: AgentMessage;
}>;

function textMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function operationError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name || "execution_failed", message: error.message };
  }
  return { code: "execution_failed", message: String(error) };
}

function combinedSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

/**
 * Executable Pi SessionStorage Harness used while upstream AgentHarness is a
 * public, but incomplete, scaffold.
 *
 * It restores only the active branch (bounded by the latest Pi compaction),
 * persists Pi-native messages and operation records incrementally, and owns a
 * single opaque execution authority shared by Session writes and Tools.
 */
export class DurableAgentHarness {
  readonly #options: DurableAgentHarnessOptions;
  #agent: Agent | undefined;
  #closed = false;

  constructor(options: DurableAgentHarnessOptions) {
    this.#options = options;
  }

  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<DurableAgentRunResult> {
    if (this.#closed) throw new Error("Durable Agent Harness is closed");
    if (this.#agent !== undefined)
      throw new Error("Durable Agent Harness already has an active Run");

    const prompt =
      typeof input === "string" ? [textMessage(input)] : Array.isArray(input) ? input : [input];
    const authority = await this.#options.authorityProvider.acquire(this.#options.scope);
    const operationId = this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID();
    let operationStarted = false;
    let operationFinished = false;
    let removeAuthorityAbort: (() => void) | undefined;

    try {
      await authority.assertCurrent();
      await this.#finishInterruptedOperations();
      const sourceLeafId = await this.#options.session.getLeafId();
      await this.#options.session.appendRecord({
        id: operationId,
        lane: "main",
        type: "operation_started",
        sourceLeafId,
        intent: { kind: "run", originalPrompt: prompt, initialMessages: [] },
      });
      operationStarted = true;

      const path = (
        await this.#options.session.findEntriesOnBranch({
          stopAtType: "compaction",
          order: "newestFirst",
        })
      ).reverse();
      const restored = buildSessionContext(path);
      const resultEntryIds = new Map<string, string>();
      let lastAssistantEntryId: string | undefined;
      let finalMessage: AgentMessage | undefined;
      let toolIndex = 0;
      const tools = (this.#options.tools ?? []).map((tool) => this.#bindTool(tool, authority));
      const agent = new Agent({
        streamFn: this.#options.streamFn,
        initialState: {
          systemPrompt: this.#options.systemPrompt,
          model: this.#options.model,
          thinkingLevel: this.#options.thinkingLevel ?? "off",
          messages: restored.messages,
          tools,
        },
        convertToLlm: this.#options.toProviderMessages ?? convertToLlm,
        ...(this.#options.transformContext === undefined
          ? {}
          : { transformContext: this.#options.transformContext }),
        toolExecution: "sequential",
        beforeToolCall: async () => {
          await authority.assertCurrent();
          return undefined;
        },
      });
      this.#agent = agent;
      const abortForAuthority = (): void => agent.abort();
      authority.signal.addEventListener("abort", abortForAuthority, { once: true });
      removeAuthorityAbort = () => authority.signal.removeEventListener("abort", abortForAuthority);
      if (authority.signal.aborted) abortForAuthority();

      const unsubscribe = agent.subscribe(async (event, signal) => {
        if (event.type === "message_end") {
          await authority.assertCurrent();
          const message = event.message;
          const toolCallId =
            message.role === "toolResult" && typeof message.toolCallId === "string"
              ? message.toolCallId
              : undefined;
          const entryId =
            (toolCallId === undefined ? undefined : resultEntryIds.get(toolCallId)) ??
            this.#options.idGenerator?.() ??
            globalThis.crypto.randomUUID();
          await this.#options.session.appendEntry(
            { id: entryId, type: "message", message },
            "main",
          );
          if (message.role === "assistant") {
            lastAssistantEntryId = entryId;
            finalMessage = message;
            toolIndex = 0;
          }
        } else if (event.type === "tool_execution_start") {
          await authority.assertCurrent();
          if (lastAssistantEntryId === undefined) {
            throw new Error("Tool execution started before its assistant message was durable");
          }
          const resultEntryId = this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID();
          resultEntryIds.set(event.toolCallId, resultEntryId);
          await this.#options.session.appendRecord({
            id: this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID(),
            lane: "main",
            type: "tool_started",
            runId: operationId,
            assistantEntryId: lastAssistantEntryId,
            toolIndex: toolIndex++,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            effectiveArgs:
              typeof event.args === "object" && event.args !== null
                ? (event.args as Record<string, unknown>)
                : {},
            resultEntryId,
            replay: "never",
          });
        }
        await this.#options.onEvent?.(event);
        if (signal.aborted && !authority.signal.aborted) agent.abort();
      });

      try {
        await agent.prompt(prompt);
      } finally {
        unsubscribe();
      }
      await authority.assertCurrent();
      if (finalMessage === undefined || lastAssistantEntryId === undefined) {
        throw new Error("Pi Agent Loop settled without a durable assistant message");
      }
      await this.#options.session.appendRecord({
        id: this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID(),
        lane: "main",
        type: "operation_finished",
        runId: operationId,
        outcome:
          finalMessage.role === "assistant" && finalMessage.stopReason === "aborted"
            ? "aborted"
            : finalMessage.role === "assistant" && finalMessage.stopReason === "error"
              ? "failed"
              : "completed",
      });
      operationFinished = true;
      return {
        operationId,
        leafId: (await this.#options.session.getLeafId())!,
        finalMessage,
      };
    } catch (error: unknown) {
      if (operationStarted && !operationFinished) {
        const failure = operationError(error);
        await this.#options.session
          .appendRecord({
            id: this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID(),
            lane: "main",
            type: "operation_finished",
            runId: operationId,
            outcome: authority.signal.aborted ? "aborted" : "failed",
            error: failure,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      removeAuthorityAbort?.();
      this.#agent = undefined;
      this.#closed = true;
      await authority.close();
    }
  }

  steer(message: string | AgentMessage): void {
    const agent = this.#agent;
    if (agent === undefined) throw new Error("Durable Agent Harness has no active Run");
    agent.steer(typeof message === "string" ? textMessage(message) : message);
  }

  abort(): void {
    this.#agent?.abort();
  }

  close(): void {
    this.#closed = true;
    this.#agent?.abort();
  }

  async #finishInterruptedOperations(): Promise<void> {
    const open = await this.#options.session.findOpenOperations("main", { limit: 1 });
    for (const operation of open) {
      await this.#options.session.appendRecord({
        id: this.#options.idGenerator?.() ?? globalThis.crypto.randomUUID(),
        lane: "main",
        type: "operation_finished",
        runId: operation.id,
        outcome: "failed",
        error: {
          code: "execution_interrupted",
          message: "The previous cloud execution ended before settlement",
        },
      });
    }
  }

  #bindTool(tool: AgentTool, authority: DurableAgentExecutionAuthority): AgentTool {
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        await authority.assertCurrent();
        const effectSignal = combinedSignal(signal, authority.signal);
        const result = await tool.execute(toolCallId, params, effectSignal, onUpdate);
        await authority.assertCurrent();
        return result;
      },
    };
  }
}
